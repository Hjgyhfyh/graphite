//! Индекс vault поверх SQLite (SPEC §6.9): таблицы `notes/links/blocks/tasks`,
//! FTS5 (`title`+`body`, `unicode61 remove_diacritics 2`) и trigram-таблица для
//! устойчивости к русской морфологии. База целиком производна от файлов: её
//! можно удалить и пересобрать `rebuild`. Схему читают `resolver` и `txn`
//! напрямую через `SELECT *`, поэтому имена колонок фиксированы: `notes(id,
//! path,title,type,status,tags,props,updated,rev,children_count,mtime,hash,
//! body)`, `blocks(note_id,anchor,heading_path,text,pos)`, `links(src_id,dst_id,
//! dst_raw,rel_type,block,context)`, `aliases(note_id,alias)`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, OptionalExtension};

use crate::error::VaultError;
use crate::model::{
    Anchor, Block, IndexState, IndexStatus, LinkEdge, LinksGetParams, LinksGetResponse, NoteId,
    NoteMeta, NoteRef, NoteType, Priority, Rev, SearchFilters, SearchHit, SearchParams,
    SearchResponse, Status, TaskItem, TaskStatus, TaskStatusFilter, TasksQueryParams,
};
use crate::{parser, resolver, writer};

/// Дескриптор индекса. Держит открытое соединение SQLite (`resolver`/`txn`
/// читают `conn` напрямую через `SELECT *`).
pub struct Index {
    pub conn: rusqlite::Connection,
}

/// Собранные из одного файла записи для одной транзакции-апсерта.
struct NoteRecord {
    meta: NoteMeta,
    blocks: Vec<Block>,
    tasks: Vec<TaskItem>,
    links: Vec<LinkEdge>,
    aliases: Vec<String>,
    due: Option<String>,
    mtime: Option<String>,
    hash: String,
    body: String,
}

impl Index {
    /// Открывает (создаёт при отсутствии) базу индекса и готовит схему в WAL.
    /// Родительский каталог создаётся при необходимости.
    pub fn open(db_path: &Path) -> Result<Self, VaultError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = rusqlite::Connection::open(db_path).map_err(index_err)?;
        let index = Self { conn };
        index.prepare_schema()?;
        Ok(index)
    }

    fn prepare_schema(&self) -> Result<(), VaultError> {
        self.conn
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(index_err)?;
        self.conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;\n\
                 PRAGMA synchronous=NORMAL;\n\
                 PRAGMA foreign_keys=OFF;\n\
                 PRAGMA temp_store=MEMORY;",
            )
            .map_err(index_err)?;
        self.conn.execute_batch(SCHEMA).map_err(index_err)?;
        Ok(())
    }

    /// Полный рескан vault: пересобирает индекс с нуля из файлов на диске.
    /// Связи резолвятся вторым проходом — когда все заметки уже в базе.
    pub fn rebuild(&mut self, vault_root: &Path) -> Result<(), VaultError> {
        let mut rels = Vec::new();
        collect_md(vault_root, "", &mut rels);
        let records: Vec<NoteRecord> = rels
            .iter()
            .filter_map(|rel| read_record(vault_root, rel))
            .collect();
        {
            let tx = self.conn.transaction().map_err(index_err)?;
            tx.execute_batch(
                "DELETE FROM notes;\nDELETE FROM blocks;\nDELETE FROM links;\n\
                 DELETE FROM tasks;\nDELETE FROM aliases;\nDELETE FROM doc;\n\
                 DELETE FROM notes_fts;\nDELETE FROM notes_trigram;",
            )
            .map_err(index_err)?;
            for record in &records {
                write_core(&tx, record)?;
            }
            recompute_children(&tx, None)?;
            tx.commit().map_err(index_err)?;
        }
        self.resolve_links(&records)
    }

    /// Второй проход: резолвит `dst_raw` каждой заметки в `dst_id` и переписывает
    /// исходящие рёбра одной транзакцией. Цели резолвятся по единожды собранной
    /// в память карте (иначе полный скан на каждое ребро не уложится в бюджет).
    fn resolve_links(&mut self, records: &[NoteRecord]) -> Result<(), VaultError> {
        if records.is_empty() {
            return Ok(());
        }
        let targets = LinkTargets::load(&self.conn)?;
        let mut resolved: Vec<ResolvedEdge> = Vec::new();
        for record in records {
            for edge in &record.links {
                resolved.push(ResolvedEdge {
                    src_id: record.meta.id.0.clone(),
                    dst_id: targets.resolve(&record.meta.id.0, &edge.dst_raw),
                    dst_raw: edge.dst_raw.clone(),
                    rel_type: edge.rel_type.as_str().to_string(),
                    block: edge.block.as_ref().map(|a| a.0.clone()),
                    context: edge.context.clone(),
                });
            }
        }
        let tx = self.conn.transaction().map_err(index_err)?;
        for edge in &resolved {
            insert_edge(&tx, edge)?;
        }
        tx.commit().map_err(index_err)?;
        Ok(())
    }

    /// Инкрементальная переиндексация набора относительных путей: существующие
    /// файлы перечитываются и апсертятся, исчезнувшие — вычищаются.
    pub fn reindex_paths(
        &mut self,
        vault_root: &Path,
        rel_paths: &[String],
    ) -> Result<(), VaultError> {
        let mut touched: HashSet<String> = HashSet::new();
        for raw in rel_paths {
            let rel = normalize_rel(raw);
            if rel.is_empty() || !rel.to_ascii_lowercase().ends_with(".md") {
                continue;
            }
            touched.insert(rel);
        }
        if touched.is_empty() {
            return Ok(());
        }
        let mut records: Vec<NoteRecord> = Vec::new();
        let mut removed: Vec<String> = Vec::new();
        for rel in &touched {
            match read_record(vault_root, rel) {
                Some(record) => records.push(record),
                None => removed.push(rel.clone()),
            }
        }
        let mut dirs: HashSet<String> = HashSet::new();
        {
            let tx = self.conn.transaction().map_err(index_err)?;
            for rel in &removed {
                dirs.insert(container_dir(rel).to_string());
                dirs.insert(represented_dir(rel));
                remove_path(&tx, rel)?;
            }
            for record in &records {
                dirs.insert(container_dir(&record.meta.path).to_string());
                dirs.insert(represented_dir(&record.meta.path));
                write_core(&tx, record)?;
            }
            recompute_children(&tx, Some(&dirs))?;
            tx.commit().map_err(index_err)?;
        }
        self.resolve_links(&records)
    }

    /// Вставляет/обновляет заметку и её производные записи одной транзакцией.
    /// FTS-текст восстанавливается из блоков (полное тело недоступно на этом
    /// пути); полноценный текст даёт `rebuild`/`reindex_paths`.
    pub fn upsert_note(
        &mut self,
        meta: &NoteMeta,
        blocks: &[Block],
        tasks: &[TaskItem],
        links: &[LinkEdge],
    ) -> Result<(), VaultError> {
        let body = blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let hash = format!("blake3:{}", writer::compute_full_hash(body.as_bytes()));
        let record = NoteRecord {
            meta: meta.clone(),
            blocks: blocks.to_vec(),
            tasks: tasks.to_vec(),
            links: links.to_vec(),
            aliases: Vec::new(),
            due: None,
            mtime: None,
            hash,
            body,
        };
        let tx = self.conn.transaction().map_err(index_err)?;
        write_core(&tx, &record)?;
        for edge in &record.links {
            insert_edge(
                &tx,
                &ResolvedEdge {
                    src_id: meta.id.0.clone(),
                    dst_id: edge.dst_id.as_ref().map(|id| id.0.clone()),
                    dst_raw: edge.dst_raw.clone(),
                    rel_type: edge.rel_type.as_str().to_string(),
                    block: edge.block.as_ref().map(|a| a.0.clone()),
                    context: edge.context.clone(),
                },
            )?;
        }
        let mut dirs = HashSet::new();
        dirs.insert(container_dir(&meta.path).to_string());
        dirs.insert(represented_dir(&meta.path));
        recompute_children(&tx, Some(&dirs))?;
        tx.commit().map_err(index_err)?;
        Ok(())
    }

    /// Удаляет заметку и её производные записи по идентификатору.
    pub fn remove_note(&mut self, note_id: &NoteId) -> Result<(), VaultError> {
        let path: Option<String> = self
            .conn
            .query_row("SELECT path FROM notes WHERE id = ?1", params![note_id.0], |r| {
                r.get(0)
            })
            .optional()
            .map_err(index_err)?;
        let tx = self.conn.transaction().map_err(index_err)?;
        remove_id(&tx, &note_id.0)?;
        if let Some(path) = path.as_deref() {
            let mut dirs = HashSet::new();
            dirs.insert(container_dir(path).to_string());
            dirs.insert(represented_dir(path));
            recompute_children(&tx, Some(&dirs))?;
        }
        tx.commit().map_err(index_err)?;
        Ok(())
    }

    /// Удаляет заметку и её производные записи по относительному пути.
    pub fn remove_by_path(&mut self, rel_path: &str) -> Result<(), VaultError> {
        let rel = normalize_rel(rel_path);
        let tx = self.conn.transaction().map_err(index_err)?;
        remove_path(&tx, &rel)?;
        let mut dirs = HashSet::new();
        dirs.insert(container_dir(&rel).to_string());
        dirs.insert(represented_dir(&rel));
        recompute_children(&tx, Some(&dirs))?;
        tx.commit().map_err(index_err)?;
        Ok(())
    }

    /// Полнотекстовый/фильтрованный поиск (FTS5 + trigram, BM25-ранжирование).
    pub fn search(&self, params: &SearchParams) -> Result<SearchResponse, VaultError> {
        search::run(self, params)
    }

    /// Состояние индекса для `index_status` (синхронный рескан → всегда `Idle`).
    pub fn status(&self) -> Result<IndexStatus, VaultError> {
        let total = self.count_notes()?;
        Ok(IndexStatus {
            state: IndexState::Idle,
            done: total,
            total,
        })
    }

    /// Число проиндексированных заметок.
    pub fn count_notes(&self) -> Result<u32, VaultError> {
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .map_err(index_err)?;
        Ok(count.max(0) as u32)
    }

    /// Все заметки индекса (метаданные), для обходов дерева и брифинга.
    pub fn all_notes(&self) -> Result<Vec<NoteMeta>, VaultError> {
        self.query_metas("SELECT * FROM notes ORDER BY path", params![])
    }

    /// Резолв `ref` → метаданные (лестница id/path/title/alias, `resolver`).
    pub fn note_by_ref(&self, r#ref: &NoteRef) -> Result<NoteMeta, VaultError> {
        crate::resolver::resolve(self, r#ref)
    }

    /// Метаданные по идентификатору; отсутствие — `Ok(None)`.
    pub fn note_by_id(&self, id: &NoteId) -> Result<Option<NoteMeta>, VaultError> {
        let metas = self.query_metas(
            "SELECT * FROM notes WHERE id = ?1 COLLATE NOCASE",
            params![id.0],
        )?;
        Ok(metas.into_iter().next())
    }

    /// Метаданные по относительному пути; отсутствие — `Ok(None)`.
    pub fn note_by_path(&self, rel_path: &str) -> Result<Option<NoteMeta>, VaultError> {
        match crate::resolver::resolve(self, &NoteRef(format!("path:{rel_path}"))) {
            Ok(meta) => Ok(Some(meta)),
            Err(VaultError::NotFound(_)) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Прямые дети заметки-папки (по контейнерному каталогу).
    pub fn children_of(&self, note_id: &NoteId) -> Result<Vec<NoteMeta>, VaultError> {
        let Some(meta) = self.note_by_id(note_id)? else {
            return Ok(Vec::new());
        };
        let dir = represented_dir(&meta.path);
        let all = self.all_notes()?;
        let mut out: Vec<NoteMeta> = all
            .into_iter()
            .filter(|m| m.id != meta.id && container_dir(&m.path) == dir)
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Все задачи индекса в порядке путь→строка.
    pub fn all_tasks(&self) -> Result<Vec<TaskItem>, VaultError> {
        self.query_tasks(
            "SELECT t.* FROM tasks t JOIN notes n ON n.id = t.note_id \
             ORDER BY n.path, t.line",
            params![],
        )
    }

    /// Задачи одной заметки в порядке появления.
    pub fn tasks_for_note(&self, note_id: &NoteId) -> Result<Vec<TaskItem>, VaultError> {
        self.query_tasks(
            "SELECT * FROM tasks WHERE note_id = ?1 ORDER BY line",
            params![note_id.0],
        )
    }

    /// Задачи по фильтрам scope/status/due/overdue/plan.
    pub fn tasks_query(&self, params: &TasksQueryParams) -> Result<Vec<TaskItem>, VaultError> {
        let mut tasks = self.all_tasks()?;
        if let Some(scope) = &params.scope {
            let meta = resolver::resolve(self, scope)?;
            let prefix = represented_dir(&meta.path);
            let scope_id = meta.id.0.clone();
            let paths = self.path_by_id()?;
            tasks.retain(|t| {
                if t.note_id.0 == scope_id {
                    return true;
                }
                paths
                    .get(&t.note_id.0)
                    .map(|p| path_in_scope(p, &prefix))
                    .unwrap_or(false)
            });
        }
        if let Some(plan) = &params.plan {
            let meta = resolver::resolve(self, plan)?;
            let plan_id = meta.id.0.clone();
            tasks.retain(|t| t.note_id.0 == plan_id);
        }
        match params.status {
            Some(TaskStatusFilter::Open) => tasks.retain(|t| !t.done),
            Some(TaskStatusFilter::Done) => tasks.retain(|t| t.done),
            Some(TaskStatusFilter::All) | None => {}
        }
        if let Some(due_before) = &params.due_before {
            tasks.retain(|t| t.due.as_deref().map(|d| d < due_before.as_str()).unwrap_or(false));
        }
        if params.overdue == Some(true) {
            let today = today_date();
            tasks.retain(|t| {
                !t.done && t.due.as_deref().map(|d| d < today.as_str()).unwrap_or(false)
            });
        }
        let limit = params
            .limit
            .map(|l| l as usize)
            .unwrap_or(crate::model::limits::TASKS_LIMIT_DEFAULT as usize);
        tasks.truncate(limit);
        Ok(tasks)
    }

    /// Исходящие рёбра заметки (`resolver`).
    pub fn outgoing(&self, note_id: &NoteId) -> Result<Vec<LinkEdge>, VaultError> {
        crate::resolver::outgoing(self, note_id)
    }

    /// Бэклинки заметки (`resolver`).
    pub fn backlinks(&self, note_id: &NoteId) -> Result<Vec<LinkEdge>, VaultError> {
        crate::resolver::backlinks(self, note_id)
    }

    /// Инструмент `links_get` (`resolver`).
    pub fn links_get(&self, params: &LinksGetParams) -> Result<LinksGetResponse, VaultError> {
        crate::resolver::links_get(self, params)
    }

    /// Произвольное чтение по соединению для потребителей вне модуля.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, VaultError> {
        f(&self.conn).map_err(index_err)
    }

    fn query_metas(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<NoteMeta>, VaultError> {
        let mut stmt = self.conn.prepare(sql).map_err(index_err)?;
        let mut rows = stmt.query(params).map_err(index_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(index_err)? {
            out.push(meta_from_row(row)?);
        }
        Ok(out)
    }

    fn query_tasks(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<TaskItem>, VaultError> {
        let mut stmt = self.conn.prepare(sql).map_err(index_err)?;
        let mut rows = stmt.query(params).map_err(index_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(index_err)? {
            out.push(task_from_row(row)?);
        }
        Ok(out)
    }

    fn path_by_id(&self) -> Result<HashMap<String, String>, VaultError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, path FROM notes")
            .map_err(index_err)?;
        let mut rows = stmt.query([]).map_err(index_err)?;
        let mut map = HashMap::new();
        while let Some(row) = rows.next().map_err(index_err)? {
            let id: String = row.get(0).map_err(index_err)?;
            let path: String = row.get(1).map_err(index_err)?;
            map.insert(id, path);
        }
        Ok(map)
    }
}

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS notes (\
    id TEXT PRIMARY KEY,\
    path TEXT NOT NULL,\
    title TEXT,\
    type TEXT,\
    status TEXT,\
    tags TEXT,\
    props TEXT,\
    updated TEXT,\
    rev TEXT,\
    children_count INTEGER NOT NULL DEFAULT 0,\
    mtime TEXT,\
    hash TEXT,\
    body TEXT\
);\
CREATE INDEX IF NOT EXISTS notes_path ON notes(path);\
CREATE TABLE IF NOT EXISTS blocks (\
    note_id TEXT NOT NULL,\
    anchor TEXT,\
    heading_path TEXT,\
    text TEXT,\
    pos INTEGER NOT NULL\
);\
CREATE INDEX IF NOT EXISTS blocks_note ON blocks(note_id);\
CREATE TABLE IF NOT EXISTS links (\
    src_id TEXT NOT NULL,\
    dst_id TEXT,\
    dst_raw TEXT NOT NULL,\
    rel_type TEXT,\
    block TEXT,\
    context TEXT\
);\
CREATE INDEX IF NOT EXISTS links_src ON links(src_id);\
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_id);\
CREATE TABLE IF NOT EXISTS tasks (\
    id TEXT,\
    note_id TEXT NOT NULL,\
    anchor TEXT,\
    text TEXT,\
    done INTEGER NOT NULL DEFAULT 0,\
    status TEXT,\
    due TEXT,\
    priority TEXT,\
    every TEXT,\
    line INTEGER NOT NULL DEFAULT 0,\
    plan TEXT,\
    stage TEXT\
);\
CREATE INDEX IF NOT EXISTS tasks_note ON tasks(note_id);\
CREATE TABLE IF NOT EXISTS aliases (\
    note_id TEXT NOT NULL,\
    alias TEXT NOT NULL\
);\
CREATE INDEX IF NOT EXISTS aliases_note ON aliases(note_id);\
CREATE TABLE IF NOT EXISTS doc (\
    rowid INTEGER PRIMARY KEY,\
    note_id TEXT NOT NULL UNIQUE\
);\
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(\
    title, body, tokenize = 'unicode61 remove_diacritics 2'\
);\
CREATE VIRTUAL TABLE IF NOT EXISTS notes_trigram USING fts5(\
    body, tokenize = 'trigram'\
);\
CREATE TABLE IF NOT EXISTS meta (\
    key TEXT PRIMARY KEY,\
    value TEXT\
);";

fn index_err(err: rusqlite::Error) -> VaultError {
    VaultError::Index(err.to_string())
}

struct ResolvedEdge {
    src_id: String,
    dst_id: Option<String>,
    dst_raw: String,
    rel_type: String,
    block: Option<String>,
    context: Option<String>,
}

/// Единожды собранная карта целей ссылок: повторяет лестницу резолвинга
/// (`resolver`) — id → путь → уникальный title → уникальный alias — но без
/// полного скана таблицы на каждое ребро. Парсинг/нормализация целей берутся
/// из `resolver` (общие примитивы), чтобы поведение совпадало с ним.
struct LinkTargets {
    id_upper: HashMap<String, String>,
    by_path: HashMap<String, String>,
    by_title: HashMap<String, Vec<String>>,
    by_alias: HashMap<String, Vec<String>>,
}

impl LinkTargets {
    fn load(conn: &rusqlite::Connection) -> Result<Self, VaultError> {
        let mut stmt = conn
            .prepare("SELECT id, path, title, props FROM notes")
            .map_err(index_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(index_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(index_err)?;
        drop(stmt);
        let mut targets = LinkTargets {
            id_upper: HashMap::new(),
            by_path: HashMap::new(),
            by_title: HashMap::new(),
            by_alias: HashMap::new(),
        };
        let mut folders: Vec<(String, String)> = Vec::new();
        for (id, path, title, props) in &rows {
            targets.id_upper.insert(id.to_uppercase(), id.clone());
            let path_key = strip_md_key(&resolver::normalize_key(path)).to_string();
            if !path_key.is_empty() {
                targets.by_path.entry(path_key.clone()).or_insert_with(|| id.clone());
                if let Some(parent) = path_key.strip_suffix("/_index") {
                    if !parent.is_empty() {
                        folders.push((parent.to_string(), id.clone()));
                    }
                }
            }
            let display = title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| file_stem(path));
            let mut keys: Vec<String> = Vec::new();
            for key in [
                resolver::normalize_key(&display),
                resolver::normalize_key(&file_stem(path)),
            ] {
                if !key.is_empty() && !keys.contains(&key) {
                    keys.push(key);
                }
            }
            for key in keys {
                targets.by_title.entry(key).or_default().push(id.clone());
            }
            let aliases = props
                .as_ref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .and_then(|value| json_strings(Some(&value), "aliases"))
                .unwrap_or_default();
            for alias in aliases {
                let key = resolver::normalize_key(&alias);
                if !key.is_empty() {
                    targets.by_alias.entry(key).or_default().push(id.clone());
                }
            }
        }
        for (parent, id) in folders {
            targets.by_path.entry(parent).or_insert(id);
        }
        Ok(targets)
    }

    fn resolve(&self, from_id: &str, raw: &str) -> Option<String> {
        let parsed = resolver::parse_wikilink_target(raw);
        if parsed.target.is_empty() {
            return parsed.fragment.is_some().then(|| from_id.to_string());
        }
        if let Some(rest) = parsed.target.strip_prefix(resolver::REF_ID_PREFIX) {
            let canonical =
                resolver::parse_ref(&NoteRef(format!("{}{rest}", resolver::REF_ID_PREFIX)));
            return match canonical {
                Ok(resolver::ParsedRef::Id(id)) => self.id_upper.get(&id.0.to_uppercase()).cloned(),
                _ => None,
            };
        }
        if parsed.target.contains('/') || parsed.target.contains('\\') {
            let cleaned =
                resolver::parse_ref(&NoteRef(format!("{}{}", resolver::REF_PATH_PREFIX, parsed.target)));
            return match cleaned {
                Ok(resolver::ParsedRef::Path(path)) => {
                    let key = strip_md_key(&resolver::normalize_key(&path)).to_string();
                    self.by_path.get(&key).cloned()
                }
                _ => None,
            };
        }
        let key = resolver::normalize_key(&parsed.target);
        if let Some(ids) = self.by_title.get(&key) {
            return match ids.len() {
                1 => Some(ids[0].clone()),
                _ => None,
            };
        }
        match self.by_alias.get(&key) {
            Some(ids) if ids.len() == 1 => Some(ids[0].clone()),
            _ => None,
        }
    }
}

fn insert_edge(tx: &rusqlite::Transaction<'_>, edge: &ResolvedEdge) -> Result<(), VaultError> {
    tx.execute(
        "INSERT INTO links (src_id, dst_id, dst_raw, rel_type, block, context) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            edge.src_id,
            edge.dst_id,
            edge.dst_raw,
            edge.rel_type,
            edge.block,
            edge.context
        ],
    )
    .map_err(index_err)?;
    Ok(())
}

/// Пишет ядро заметки (всё, кроме исходящих связей) идемпотентно: старые
/// строки этой заметки во всех таблицах вычищаются, затем вставляются новые.
fn write_core(tx: &rusqlite::Transaction<'_>, rec: &NoteRecord) -> Result<(), VaultError> {
    let id = &rec.meta.id.0;
    for sql in [
        "DELETE FROM notes WHERE id = ?1",
        "DELETE FROM blocks WHERE note_id = ?1",
        "DELETE FROM tasks WHERE note_id = ?1",
        "DELETE FROM aliases WHERE note_id = ?1",
        "DELETE FROM links WHERE src_id = ?1",
    ] {
        tx.execute(sql, params![id]).map_err(index_err)?;
    }
    let rowid = fts_rowid(tx, id)?;
    let title_fts = fold_yo(&rec.meta.title);
    let body_fts = fold_yo(&rec.body);
    tx.execute(
        "INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
        params![rowid, title_fts, body_fts],
    )
    .map_err(index_err)?;
    tx.execute(
        "INSERT INTO notes_trigram (rowid, body) VALUES (?1, ?2)",
        params![rowid, format!("{title_fts}\n{body_fts}")],
    )
    .map_err(index_err)?;
    let props = build_props(rec);
    let tags_json = serde_json::to_string(&rec.meta.tags).unwrap_or_else(|_| "[]".to_string());
    tx.execute(
        "INSERT INTO notes \
         (id, path, title, type, status, tags, props, updated, rev, children_count, mtime, hash, body) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12)",
        params![
            id,
            rec.meta.path,
            rec.meta.title,
            rec.meta.r#type.as_str(),
            rec.meta.status.map(|s| s.as_str()),
            tags_json,
            props,
            rec.meta.updated,
            rec.meta.rev.0,
            rec.mtime,
            rec.hash,
            rec.body
        ],
    )
    .map_err(index_err)?;
    for block in &rec.blocks {
        let heading = serde_json::to_string(&block.heading_path).unwrap_or_else(|_| "[]".to_string());
        tx.execute(
            "INSERT INTO blocks (note_id, anchor, heading_path, text, pos) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                block.anchor.as_ref().map(|a| a.0.clone()),
                heading,
                block.text,
                block.pos
            ],
        )
        .map_err(index_err)?;
    }
    for task in &rec.tasks {
        tx.execute(
            "INSERT INTO tasks \
             (id, note_id, anchor, text, done, status, due, priority, every, line, plan, stage) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                task.id,
                id,
                task.anchor.0,
                task.text,
                task.done as i64,
                task.status.as_str(),
                task.due,
                task.priority.map(|p| p.as_str()),
                task.every,
                task.line,
                task.plan.as_ref().map(|p| p.0.clone()),
                task.stage
            ],
        )
        .map_err(index_err)?;
    }
    for alias in &rec.aliases {
        tx.execute(
            "INSERT INTO aliases (note_id, alias) VALUES (?1, ?2)",
            params![id, alias],
        )
        .map_err(index_err)?;
    }
    Ok(())
}

/// Возвращает целочисленный `rowid` для FTS-таблиц: переиспользует прежний из
/// `doc` (очистив старые FTS-строки) либо выделяет новый.
fn fts_rowid(tx: &rusqlite::Transaction<'_>, note_id: &str) -> Result<i64, VaultError> {
    let existing: Option<i64> = tx
        .query_row("SELECT rowid FROM doc WHERE note_id = ?1", params![note_id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(index_err)?;
    if let Some(rowid) = existing {
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])
            .map_err(index_err)?;
        tx.execute("DELETE FROM notes_trigram WHERE rowid = ?1", params![rowid])
            .map_err(index_err)?;
        return Ok(rowid);
    }
    tx.execute("INSERT INTO doc (note_id) VALUES (?1)", params![note_id])
        .map_err(index_err)?;
    Ok(tx.last_insert_rowid())
}

fn remove_id(tx: &rusqlite::Transaction<'_>, note_id: &str) -> Result<(), VaultError> {
    if let Some(rowid) = tx
        .query_row("SELECT rowid FROM doc WHERE note_id = ?1", params![note_id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(index_err)?
    {
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])
            .map_err(index_err)?;
        tx.execute("DELETE FROM notes_trigram WHERE rowid = ?1", params![rowid])
            .map_err(index_err)?;
    }
    for sql in [
        "DELETE FROM doc WHERE note_id = ?1",
        "DELETE FROM notes WHERE id = ?1",
        "DELETE FROM blocks WHERE note_id = ?1",
        "DELETE FROM tasks WHERE note_id = ?1",
        "DELETE FROM aliases WHERE note_id = ?1",
        "DELETE FROM links WHERE src_id = ?1",
    ] {
        tx.execute(sql, params![note_id]).map_err(index_err)?;
    }
    tx.execute(
        "UPDATE links SET dst_id = NULL WHERE dst_id = ?1",
        params![note_id],
    )
    .map_err(index_err)?;
    Ok(())
}

fn remove_path(tx: &rusqlite::Transaction<'_>, rel_path: &str) -> Result<(), VaultError> {
    let id: Option<String> = tx
        .query_row("SELECT id FROM notes WHERE path = ?1", params![rel_path], |r| {
            r.get(0)
        })
        .optional()
        .map_err(index_err)?;
    if let Some(id) = id {
        remove_id(tx, &id)?;
    }
    Ok(())
}

/// Пересчитывает `children_count` для заметок-папок. `only` ограничивает
/// набор обновляемых папок (по представляемому каталогу); `None` — все.
fn recompute_children(
    tx: &rusqlite::Transaction<'_>,
    only: Option<&HashSet<String>>,
) -> Result<(), VaultError> {
    let mut stmt = tx.prepare("SELECT id, path FROM notes").map_err(index_err)?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(index_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(index_err)?;
    drop(stmt);
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (_, path) in &rows {
        *counts.entry(container_dir(path)).or_insert(0) += 1;
    }
    for (id, path) in &rows {
        if !is_folder_note(path) {
            continue;
        }
        let dir = represented_dir(path);
        if only.is_some_and(|set| !set.contains(&dir)) {
            continue;
        }
        let count = counts.get(&dir).copied().unwrap_or(0);
        tx.execute(
            "UPDATE notes SET children_count = ?1 WHERE id = ?2",
            params![count, id],
        )
        .map_err(index_err)?;
    }
    Ok(())
}

fn build_props(rec: &NoteRecord) -> String {
    let mut map = serde_json::Map::new();
    map.insert(
        "aliases".to_string(),
        serde_json::Value::from(rec.aliases.clone()),
    );
    map.insert(
        "tags".to_string(),
        serde_json::Value::from(rec.meta.tags.clone()),
    );
    if !rec.meta.updated.is_empty() {
        map.insert(
            "updated".to_string(),
            serde_json::Value::from(rec.meta.updated.clone()),
        );
    }
    if let Some(due) = &rec.due {
        map.insert("due".to_string(), serde_json::Value::from(due.clone()));
    }
    serde_json::Value::Object(map).to_string()
}

/// Читает файл заметки и собирает все производные записи. Отсутствие/битость
/// файла — `None` (для инкремента это сигнал удаления из индекса).
fn read_record(vault_root: &Path, rel_path: &str) -> Option<NoteRecord> {
    let rel = normalize_rel(rel_path);
    if rel.is_empty() {
        return None;
    }
    let abs = writer::vault_abs_path(vault_root, &rel).ok()?;
    let raw = std::fs::read_to_string(&abs).ok()?;
    let parsed = parser::parse_note(&raw).ok()?;
    let fm = parsed.frontmatter;
    let id = fm
        .id
        .as_ref()
        .map(|nid| nid.0.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| synthetic_id(&rel));
    let note_id = NoteId(id.clone());
    let title = fm
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| file_stem(&rel));
    let r#type = fm.r#type.unwrap_or(NoteType::Note);
    let mtime = std::fs::metadata(&abs)
        .and_then(|m| m.modified())
        .ok()
        .map(iso_from_systime);
    let updated = fm
        .updated
        .clone()
        .or_else(|| fm.created.clone())
        .or_else(|| mtime.clone())
        .unwrap_or_default();
    let rev = writer::compute_rev(raw.as_bytes());
    let hash = format!("blake3:{}", writer::compute_full_hash(raw.as_bytes()));
    let body = parsed.body;
    let blocks = parser::extract_blocks(&note_id, &body).unwrap_or_default();
    let mut tasks = parser::extract_tasks(&note_id, &body).unwrap_or_default();
    if r#type == NoteType::Plan {
        let plan_ref = NoteRef(format!("id:{id}"));
        for task in &mut tasks {
            task.plan = Some(plan_ref.clone());
        }
    }
    let mut links = parser::extract_links(&note_id, &body).unwrap_or_default();
    for rel_link in &parsed.rel_links {
        links.push(LinkEdge {
            src_id: note_id.clone(),
            dst_id: None,
            dst_raw: rel_link.raw.clone(),
            rel_type: rel_link.rel_type.clone(),
            block: None,
            context: None,
        });
    }
    Some(NoteRecord {
        meta: NoteMeta {
            id: note_id,
            path: rel,
            title,
            r#type,
            status: fm.status,
            tags: fm.tags.clone(),
            updated,
            rev,
            children_count: 0,
        },
        blocks,
        tasks,
        links,
        aliases: fm.aliases.clone(),
        due: fm.due.clone(),
        mtime,
        hash,
        body,
    })
}

/// Детерминированный ULID из пути для заметок без `id` во frontmatter:
/// blake3 пути → первые 16 байт → канонический ULID. Один путь — один id.
fn synthetic_id(rel_path: &str) -> String {
    let digest = blake3::hash(rel_path.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    ulid::Ulid::from(u128::from_be_bytes(bytes)).to_string()
}

fn iso_from_systime(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn collect_md(root: &Path, dir_rel: &str, out: &mut Vec<String>) {
    let abs = if dir_rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir_rel.split('/').collect::<std::path::PathBuf>())
    };
    let Ok(entries) = std::fs::read_dir(&abs) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if dir_rel.is_empty() {
            name.clone()
        } else {
            format!("{dir_rel}/{name}")
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if !is_service_dir(&name) {
                collect_md(root, &rel, out);
            }
        } else if name.to_ascii_lowercase().ends_with(".md") {
            out.push(rel);
        }
    }
}

fn is_service_dir(name: &str) -> bool {
    name.starts_with('.') || name == "_assets" || name == "node_modules" || name == "target"
}

fn normalize_rel(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    replaced
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn is_folder_note(path: &str) -> bool {
    path == "_index.md" || path.ends_with("/_index.md")
}

/// Каталог, который заметка представляет как «папку» для своих детей.
fn represented_dir(path: &str) -> String {
    if path == "_index.md" {
        return String::new();
    }
    if let Some(dir) = path.strip_suffix("/_index.md") {
        return dir.to_string();
    }
    strip_md(path).to_string()
}

/// Каталог-контейнер, непосредственно держащий заметку (её родитель).
fn container_dir(path: &str) -> String {
    if path == "_index.md" {
        return "\u{0}".to_string();
    }
    let repr = represented_dir(path);
    match repr.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

fn strip_md(path: &str) -> &str {
    if path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md") {
        &path[..path.len() - 3]
    } else {
        path
    }
}

/// Срез хвоста `.md` у уже нормализованного ключа пути (нижний регистр).
fn strip_md_key(key: &str) -> &str {
    key.strip_suffix(".md").unwrap_or(key)
}

fn file_stem(path: &str) -> String {
    let last = path.rsplit('/').next().unwrap_or(path);
    let stem = strip_md(last);
    if stem.eq_ignore_ascii_case("_index") {
        path.rsplit('/').nth(1).unwrap_or(stem).to_string()
    } else {
        stem.to_string()
    }
}

fn path_in_scope(path: &str, scope_dir: &str) -> bool {
    if scope_dir.is_empty() {
        return true;
    }
    let key = resolver::normalize_key(path);
    let dir = resolver::normalize_key(scope_dir);
    key == dir || key.starts_with(&format!("{dir}/"))
}

fn today_date() -> String {
    let now = writer::now_iso_utc();
    now.chars().take(10).collect()
}

fn fold_yo(text: &str) -> String {
    text.replace('ё', "е").replace('Ё', "Е")
}

fn meta_from_row(row: &rusqlite::Row<'_>) -> Result<NoteMeta, VaultError> {
    let id: String = row.get("id").map_err(index_err)?;
    let path: String = row.get("path").map_err(index_err)?;
    let props: Option<serde_json::Value> = opt_text(row, "props")
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let title = opt_text(row, "title")
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| file_stem(&path));
    let r#type = opt_text(row, "type")
        .and_then(|raw| raw.parse::<NoteType>().ok())
        .unwrap_or(NoteType::Note);
    let status = opt_text(row, "status").and_then(|raw| raw.parse::<Status>().ok());
    let tags = opt_text(row, "tags")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .or_else(|| json_strings(props.as_ref(), "tags"))
        .unwrap_or_default();
    let updated = opt_text(row, "updated")
        .filter(|s| !s.is_empty())
        .or_else(|| json_string(props.as_ref(), "updated"))
        .or_else(|| opt_text(row, "mtime"))
        .unwrap_or_default();
    let rev = opt_text(row, "rev").unwrap_or_default();
    let children_count = opt_int(row, "children_count").unwrap_or(0).max(0) as u32;
    Ok(NoteMeta {
        id: NoteId(id),
        path,
        title,
        r#type,
        status,
        tags,
        updated,
        rev: Rev(rev),
        children_count,
    })
}

fn task_from_row(row: &rusqlite::Row<'_>) -> Result<TaskItem, VaultError> {
    let note_id: String = row.get("note_id").map_err(index_err)?;
    let anchor = opt_text(row, "anchor").unwrap_or_default();
    let status = opt_text(row, "status")
        .and_then(|raw| raw.parse::<TaskStatus>().ok())
        .unwrap_or(TaskStatus::Todo);
    let done = opt_int(row, "done").unwrap_or(0) != 0;
    Ok(TaskItem {
        id: opt_text(row, "id").unwrap_or_default(),
        note_id: NoteId(note_id),
        anchor: Anchor(anchor),
        text: opt_text(row, "text").unwrap_or_default(),
        done,
        status,
        due: opt_text(row, "due"),
        priority: opt_text(row, "priority").and_then(|raw| raw.parse::<Priority>().ok()),
        every: opt_text(row, "every"),
        line: opt_int(row, "line").unwrap_or(0).max(0) as u32,
        plan: opt_text(row, "plan").map(NoteRef),
        stage: opt_text(row, "stage"),
    })
}

fn json_string(props: Option<&serde_json::Value>, key: &str) -> Option<String> {
    props?.get(key)?.as_str().map(str::to_string)
}

fn json_strings(props: Option<&serde_json::Value>, key: &str) -> Option<Vec<String>> {
    let items = props?.get(key)?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
    )
}

fn opt_text(row: &rusqlite::Row<'_>, column: &str) -> Option<String> {
    row.get::<&str, Option<String>>(column).ok().flatten()
}

fn opt_int(row: &rusqlite::Row<'_>, column: &str) -> Option<i64> {
    row.get::<&str, Option<i64>>(column).ok().flatten()
}

mod search {
    use super::*;

    /// Кандидат поиска: метаданные + материал для фильтров и сниппетов.
    struct Candidate {
        meta: NoteMeta,
        body: String,
        tags: Vec<String>,
        due: Option<String>,
    }

    struct Query {
        words: Vec<String>,
        phrases: Vec<String>,
        excludes: Vec<String>,
    }

    struct EffFilters {
        r#type: Option<NoteType>,
        status: Option<Status>,
        tags: Vec<String>,
        path: Option<String>,
        updated_after: Option<String>,
        updated_before: Option<String>,
        due_before: Option<String>,
    }

    pub(super) fn run(index: &Index, params: &SearchParams) -> Result<SearchResponse, VaultError> {
        let (query, mut filters) = parse_query(&params.query);
        merge_filters(&mut filters, params.filters.as_ref());
        let limit = params
            .limit
            .map(|l| l as usize)
            .unwrap_or(crate::model::limits::SEARCH_LIMIT_DEFAULT as usize)
            .min(crate::model::limits::SEARCH_LIMIT_MAX as usize);
        let offset = params.offset.map(|o| o as usize).unwrap_or(0);

        let scored: Vec<(Candidate, f32)> =
            if query.words.is_empty() && query.phrases.is_empty() {
                load_all_candidates(index)?
            } else {
                let ranked = full_text_candidates(index, &query)?;
                let mut out = Vec::with_capacity(ranked.len());
                let mut seen: HashSet<String> = HashSet::new();
                for (note_id, score) in ranked {
                    if !seen.insert(note_id.clone()) {
                        continue;
                    }
                    if let Some(candidate) = load_candidate(index, &note_id)? {
                        out.push((candidate, score));
                    }
                }
                out
            };

        let needles = snippet_needles(&query);
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut total = 0u32;
        for (candidate, score) in &scored {
            if !passes(candidate, &filters) {
                continue;
            }
            if !query.excludes.is_empty() && has_excluded(candidate, &query.excludes) {
                continue;
            }
            total += 1;
            if total as usize <= offset || hits.len() >= limit {
                continue;
            }
            hits.push(build_hit(candidate, *score, &needles));
        }
        Ok(SearchResponse {
            hits,
            total: Some(total),
        })
    }

    fn parse_query(raw: &str) -> (Query, EffFilters) {
        let mut words = Vec::new();
        let mut phrases = Vec::new();
        let mut excludes = Vec::new();
        let mut filters = EffFilters {
            r#type: None,
            status: None,
            tags: Vec::new(),
            path: None,
            updated_after: None,
            updated_before: None,
            due_before: None,
        };
        for token in tokenize(raw) {
            match token {
                Token::Phrase(text) => {
                    let folded = fold_yo(text.trim());
                    if !folded.is_empty() {
                        phrases.push(folded);
                    }
                }
                Token::Word(text) => {
                    let (negated, bare) = match text.strip_prefix('-') {
                        Some(rest) if !rest.is_empty() => (true, rest.to_string()),
                        _ => (false, text.clone()),
                    };
                    if let Some((key, value)) = bare.split_once(':') {
                        if apply_operator(&mut filters, key, value) {
                            continue;
                        }
                    }
                    let folded = fold_yo(bare.trim());
                    if folded.is_empty() {
                        continue;
                    }
                    if negated {
                        excludes.push(folded);
                    } else {
                        words.push(folded);
                    }
                }
            }
        }
        (
            Query {
                words,
                phrases,
                excludes,
            },
            filters,
        )
    }

    fn apply_operator(filters: &mut EffFilters, key: &str, value: &str) -> bool {
        let value = value.trim().trim_matches('"');
        if value.is_empty() {
            return false;
        }
        match key {
            "tag" | "tags" => {
                filters.tags.push(value.to_string());
                true
            }
            "type" => match value.parse::<NoteType>() {
                Ok(t) => {
                    filters.r#type = Some(t);
                    true
                }
                Err(_) => false,
            },
            "status" => match value.parse::<Status>() {
                Ok(s) => {
                    filters.status = Some(s);
                    true
                }
                Err(_) => false,
            },
            "path" => {
                filters.path = Some(value.to_string());
                true
            }
            "updated" | "after" => {
                filters.updated_after = Some(value.to_string());
                true
            }
            "before" => {
                filters.updated_before = Some(value.to_string());
                true
            }
            "due" => {
                filters.due_before = Some(value.to_string());
                true
            }
            _ => false,
        }
    }

    fn merge_filters(filters: &mut EffFilters, extra: Option<&SearchFilters>) {
        let Some(extra) = extra else { return };
        if filters.r#type.is_none() {
            filters.r#type = extra.r#type;
        }
        if filters.status.is_none() {
            filters.status = extra.status;
        }
        if let Some(tags) = &extra.tags {
            for tag in tags {
                filters.tags.push(tag.clone());
            }
        }
        if filters.path.is_none() {
            filters.path = extra.path.clone();
        }
        if filters.updated_after.is_none() {
            filters.updated_after = extra.updated_after.clone();
        }
        if filters.updated_before.is_none() {
            filters.updated_before = extra.updated_before.clone();
        }
        if filters.due_before.is_none() {
            filters.due_before = extra.due_before.clone();
        }
    }

    enum Token {
        Word(String),
        Phrase(String),
    }

    fn tokenize(raw: &str) -> Vec<Token> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut in_quote = false;
        for ch in raw.chars() {
            match ch {
                '"' => {
                    if in_quote {
                        tokens.push(Token::Phrase(std::mem::take(&mut current)));
                        in_quote = false;
                    } else {
                        if !current.is_empty() {
                            tokens.push(Token::Word(std::mem::take(&mut current)));
                        }
                        in_quote = true;
                    }
                }
                c if c.is_whitespace() && !in_quote => {
                    if !current.is_empty() {
                        tokens.push(Token::Word(std::mem::take(&mut current)));
                    }
                }
                c => current.push(c),
            }
        }
        if !current.is_empty() {
            if in_quote {
                tokens.push(Token::Phrase(current));
            } else {
                tokens.push(Token::Word(current));
            }
        }
        tokens
    }

    fn full_text_candidates(
        index: &Index,
        query: &Query,
    ) -> Result<Vec<(String, f32)>, VaultError> {
        let mut ranked: Vec<(String, f32)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        if let Some(match_expr) = fts_match(query) {
            let mut stmt = index
                .conn
                .prepare(
                    "SELECT d.note_id, bm25(notes_fts, 8.0, 1.0) AS score \
                     FROM notes_fts JOIN doc d ON d.rowid = notes_fts.rowid \
                     WHERE notes_fts MATCH ?1 ORDER BY score",
                )
                .map_err(index_err)?;
            let rows = stmt
                .query_map(rusqlite::params![match_expr], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                })
                .map_err(index_err)?;
            for row in rows {
                let (note_id, bm25) = row.map_err(index_err)?;
                if seen.insert(note_id.clone()) {
                    ranked.push((note_id, -bm25 as f32));
                }
            }
        }
        if let Some(match_expr) = trigram_match(query) {
            let mut stmt = index
                .conn
                .prepare(
                    "SELECT d.note_id FROM notes_trigram JOIN doc d \
                     ON d.rowid = notes_trigram.rowid WHERE notes_trigram MATCH ?1",
                )
                .map_err(index_err)?;
            let rows = stmt
                .query_map(rusqlite::params![match_expr], |row| row.get::<_, String>(0))
                .map_err(index_err)?;
            for row in rows {
                let note_id = row.map_err(index_err)?;
                if seen.insert(note_id.clone()) {
                    ranked.push((note_id, 0.05));
                }
            }
        }
        Ok(ranked)
    }

    fn fts_match(query: &Query) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        for phrase in &query.phrases {
            if let Some(quoted) = safe_phrase(phrase) {
                parts.push(quoted);
            }
        }
        for word in &query.words {
            let token = safe_token(word);
            if !token.is_empty() {
                parts.push(format!("{token}*"));
            }
        }
        if parts.is_empty() {
            return None;
        }
        let mut expr = parts.join(" ");
        for exclude in &query.excludes {
            let token = safe_token(exclude);
            if !token.is_empty() {
                expr.push_str(&format!(" NOT {token}*"));
            }
        }
        Some(expr)
    }

    fn trigram_match(query: &Query) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        for phrase in &query.phrases {
            if phrase.chars().count() >= 3 {
                if let Some(quoted) = safe_phrase(phrase) {
                    parts.push(quoted);
                }
            }
        }
        for word in &query.words {
            let token = safe_token(word);
            if token.chars().count() >= 3 {
                parts.push(format!("\"{token}\""));
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" "))
        }
    }

    /// Токен для FTS/trigram: только буквенно-цифровые символы (кириллица
    /// сохраняется), пунктуация отбрасывается — защита от синтаксиса MATCH.
    fn safe_token(word: &str) -> String {
        word.chars().filter(|c| c.is_alphanumeric()).collect()
    }

    fn safe_phrase(phrase: &str) -> Option<String> {
        let tokens: Vec<String> = phrase
            .split_whitespace()
            .map(safe_token)
            .filter(|t| !t.is_empty())
            .collect();
        if tokens.is_empty() {
            None
        } else {
            Some(format!("\"{}\"", tokens.join(" ")))
        }
    }

    fn load_all_candidates(index: &Index) -> Result<Vec<(Candidate, f32)>, VaultError> {
        let mut stmt = index
            .conn
            .prepare("SELECT * FROM notes ORDER BY updated DESC, path")
            .map_err(index_err)?;
        let mut rows = stmt.query([]).map_err(index_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(index_err)? {
            out.push((candidate_from_row(row)?, 0.0));
        }
        Ok(out)
    }

    fn load_candidate(index: &Index, note_id: &str) -> Result<Option<Candidate>, VaultError> {
        let mut stmt = index
            .conn
            .prepare("SELECT * FROM notes WHERE id = ?1")
            .map_err(index_err)?;
        let mut rows = stmt.query(rusqlite::params![note_id]).map_err(index_err)?;
        let Some(row) = rows.next().map_err(index_err)? else {
            return Ok(None);
        };
        Ok(Some(candidate_from_row(row)?))
    }

    fn candidate_from_row(row: &rusqlite::Row<'_>) -> Result<Candidate, VaultError> {
        let meta = meta_from_row(row)?;
        let body = opt_text(row, "body").unwrap_or_default();
        let props: Option<serde_json::Value> = opt_text(row, "props")
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let due = json_string(props.as_ref(), "due");
        let tags = meta.tags.clone();
        Ok(Candidate {
            meta,
            body,
            tags,
            due,
        })
    }

    fn passes(candidate: &Candidate, filters: &EffFilters) -> bool {
        if let Some(t) = filters.r#type {
            if candidate.meta.r#type != t {
                return false;
            }
        }
        if let Some(s) = filters.status {
            if candidate.meta.status != Some(s) {
                return false;
            }
        }
        for tag in &filters.tags {
            let key = resolver::normalize_key(tag);
            if !candidate
                .tags
                .iter()
                .any(|t| resolver::normalize_key(t) == key)
            {
                return false;
            }
        }
        if let Some(path) = &filters.path {
            if !path_in_scope(&candidate.meta.path, &normalize_rel(path)) {
                return false;
            }
        }
        if let Some(after) = &filters.updated_after {
            if candidate.meta.updated.is_empty() || candidate.meta.updated.as_str() < after.as_str()
            {
                return false;
            }
        }
        if let Some(before) = &filters.updated_before {
            if candidate.meta.updated.is_empty()
                || candidate.meta.updated.as_str() > before.as_str()
            {
                return false;
            }
        }
        if let Some(due_before) = &filters.due_before {
            match &candidate.due {
                Some(due) if due.as_str() < due_before.as_str() => {}
                _ => return false,
            }
        }
        true
    }

    fn has_excluded(candidate: &Candidate, excludes: &[String]) -> bool {
        let haystack = fold_yo(&format!("{} {}", candidate.meta.title, candidate.body)).to_lowercase();
        excludes
            .iter()
            .any(|needle| haystack.contains(needle.to_lowercase().as_str()))
    }

    fn snippet_needles(query: &Query) -> Vec<String> {
        let mut needles: Vec<String> = Vec::new();
        for phrase in &query.phrases {
            needles.push(phrase.clone());
        }
        for word in &query.words {
            needles.push(word.clone());
        }
        needles
    }

    fn build_hit(candidate: &Candidate, score: f32, needles: &[String]) -> SearchHit {
        let snippets = make_snippets(&candidate.body, needles);
        SearchHit {
            r#ref: NoteRef(format!("id:{}", candidate.meta.id.0)),
            title: candidate.meta.title.clone(),
            score,
            snippets,
            updated: candidate.meta.updated.clone(),
        }
    }

    const SNIPPET_MAX: usize = 300;
    const SNIPPET_COUNT: usize = 3;

    fn make_snippets(body: &str, needles: &[String]) -> Vec<String> {
        let orig: Vec<char> = body.chars().collect();
        if orig.is_empty() {
            return Vec::new();
        }
        let folded: Vec<char> = fold_chars(body);
        let mut hits: Vec<(usize, usize)> = Vec::new();
        for needle in needles {
            let pattern: Vec<char> = fold_chars(needle);
            if pattern.is_empty() {
                continue;
            }
            if let Some(pos) = find_subsequence(&folded, &pattern) {
                hits.push((pos, pattern.len()));
            }
        }
        hits.sort_by_key(|(pos, _)| *pos);
        let mut snippets: Vec<String> = Vec::new();
        let mut covered_end = 0usize;
        for (pos, len) in hits {
            if !snippets.is_empty() && pos < covered_end {
                continue;
            }
            let (text, end) = window(&orig, pos, len);
            snippets.push(text);
            covered_end = end;
            if snippets.len() >= SNIPPET_COUNT {
                break;
            }
        }
        if snippets.is_empty() {
            snippets.push(head_snippet(&orig));
        }
        snippets
    }

    fn head_snippet(orig: &[char]) -> String {
        let mut end = orig.len().min(SNIPPET_MAX);
        if end < orig.len() {
            end = back_to_boundary(orig, end);
        }
        let mut text = collapse(&orig[..end]);
        if end < orig.len() {
            text.push_str(" …");
        }
        text
    }

    fn window(orig: &[char], pos: usize, len: usize) -> (String, usize) {
        let lead = 48usize;
        let mut start = pos.saturating_sub(lead);
        if start > 0 {
            start = forward_to_boundary(orig, start);
        }
        let mut end = (start + SNIPPET_MAX).min(orig.len()).max(pos + len);
        end = end.min(orig.len());
        if end < orig.len() {
            end = back_to_boundary(orig, end);
        }
        if end <= start {
            end = orig.len().min(start + SNIPPET_MAX);
        }
        let mut text = String::new();
        if start > 0 {
            text.push_str("… ");
        }
        text.push_str(&collapse(&orig[start..end]));
        if end < orig.len() {
            text.push_str(" …");
        }
        (text, end)
    }

    fn forward_to_boundary(orig: &[char], mut idx: usize) -> usize {
        let limit = (idx + 24).min(orig.len());
        while idx < limit && !orig[idx].is_whitespace() {
            idx += 1;
        }
        while idx < orig.len() && orig[idx].is_whitespace() {
            idx += 1;
        }
        idx
    }

    fn back_to_boundary(orig: &[char], mut idx: usize) -> usize {
        let floor = idx.saturating_sub(24);
        while idx > floor && idx < orig.len() && !orig[idx].is_whitespace() {
            idx -= 1;
        }
        idx
    }

    fn collapse(chars: &[char]) -> String {
        let mut out = String::with_capacity(chars.len());
        let mut prev_space = false;
        for &ch in chars {
            if ch.is_whitespace() {
                if !prev_space {
                    out.push(' ');
                    prev_space = true;
                }
            } else {
                out.push(ch);
                prev_space = false;
            }
        }
        out.trim().to_string()
    }

    fn fold_chars(text: &str) -> Vec<char> {
        let mut out = Vec::new();
        for ch in text.chars() {
            let mut lower = ch.to_lowercase();
            let first = lower.next().unwrap_or(ch);
            out.push(if first == 'ё' { 'е' } else { first });
        }
        out
    }

    fn find_subsequence(haystack: &[char], needle: &[char]) -> Option<usize> {
        if needle.is_empty() || needle.len() > haystack.len() {
            return None;
        }
        let last = haystack.len() - needle.len();
        (0..=last).find(|&start| haystack[start..start + needle.len()] == *needle)
    }
}

