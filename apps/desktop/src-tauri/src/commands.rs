use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::Emitter;

use crate::state::{CoreState, core_cell};
use crate::dto::*;
use crate::events::{IndexProgressEvent, JournalOpEvent, NoteChangeKind, NoteChangedEvent};
use vault_core::indexer::Index;
use vault_core::txn::TxnOpts;
use vault_core::vault::{ai, crud, history, planning, query};
use vault_core::{parser, writer};

/// Захват мьютекса ядра, переживающий отравление: паника под локом (индекс/
/// парсер) не должна валить все последующие команды и watcher-супервизор.
/// Восстанавливаем внутреннее значение, как это делает `EchoSet` писателя.
pub fn lock_core() -> MutexGuard<'static, Option<CoreState>> {
    match core_cell().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    }
}

fn gerr(code: GraphiteErrorCode, message: impl Into<String>, hint: Option<&str>) -> GraphiteError {
    GraphiteError {
        code,
        message: message.into(),
        hint: hint.map(|s| s.to_string()),
        data: None,
    }
}

fn core_err(e: vault_core::VaultError) -> GraphiteError {
    let rpc_err: vault_core::GraphiteError = e.into();
    convert(&rpc_err).unwrap_or_else(|_| gerr(GraphiteErrorCode::Unavailable, "ошибка ядра", None))
}

/// Перегоняет один сериализуемый тип в другой с идентичной формой serde
/// (dto ↔ канонические типы ядра). Оба набора используют camelCase на границе.
fn convert<A: Serialize, B: DeserializeOwned>(value: &A) -> Result<B, GraphiteError> {
    let json = serde_json::to_value(value)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("сериализация: {e}"), None))?;
    serde_json::from_value(json)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("десериализация: {e}"), None))
}

fn not_mounted() -> GraphiteError {
    gerr(
        GraphiteErrorCode::Unavailable,
        "хранилище не открыто",
        Some("сначала вызови vault_open"),
    )
}

/// Эксклюзивный доступ к смонтированному ядру (один писатель).
fn with_core<T>(f: impl FnOnce(&mut CoreState) -> Result<T, GraphiteError>) -> Result<T, GraphiteError> {
    let mut guard = lock_core();
    let state = guard.as_mut().ok_or_else(not_mounted)?;
    f(state)
}

fn current_root() -> Result<PathBuf, GraphiteError> {
    lock_core()
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(not_mounted)
}

thread_local! {
    /// Помечает поток, обслуживающий MCP-вызов (dispatch), чтобы мутации
    /// атрибутировались ассистенту, а не пользователю (Р27, лента ИИ).
    static ASSISTANT_ACTOR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct AssistantActorGuard;
impl Drop for AssistantActorGuard {
    fn drop(&mut self) {
        ASSISTANT_ACTOR.with(|a| a.set(false));
    }
}

/// Поток обслуживает MCP-вызов (мутация атрибутируется ассистенту).
fn actor_is_assistant() -> bool {
    ASSISTANT_ACTOR.with(|a| a.get())
}

fn txn_opts() -> TxnOpts {
    let actor = if actor_is_assistant() {
        vault_core::Actor::Assistant
    } else {
        vault_core::Actor::User
    };
    TxnOpts {
        actor,
        tool: None,
        session: None,
    }
}

/// Пост-обработка мутации: журнал + переиндексация затронутых файлов + трансляция
/// изменений в окно (открытые вкладки перечитывают файл, лента активности живёт).
fn after_mutation(state: &mut CoreState, op: &vault_core::JournalOp) {
    let _ = history::record(&state.root, op);
    let paths: Vec<String> = op.files.iter().map(|c| c.path.clone()).collect();
    let _ = state.index.reindex_paths(&state.root, &paths);
    emit_mutation_events(op, NoteChangeKind::Modified);
}

/// Эмитит `note_changed` для каждого затронутого файла, ещё существующего на
/// диске (правка/создание), и одну запись `journal_op` для ленты активности.
/// Удаления (`after: None`) не рассылаются как note_changed — их инициатор уже
/// закрыл вкладку, а перечитывание несуществующего файла дало бы NotFound.
fn emit_mutation_events(op: &vault_core::JournalOp, kind: NoteChangeKind) {
    let Some(app) = crate::runtime::app_handle() else {
        return;
    };
    let actor = if actor_is_assistant() { Actor::Assistant } else { Actor::User };
    for change in &op.files {
        let Some(after) = &change.after else { continue };
        let rev = after
            .strip_prefix("blake3:")
            .unwrap_or(after)
            .chars()
            .take(16)
            .collect::<String>();
        let _ = app.emit(
            "note_changed",
            NoteChangedEvent {
                r#ref: NoteRef(format!("path:{}", change.path)),
                rev: Rev(rev),
                actor,
                kind: Some(kind),
                from: None,
            },
        );
    }
    if let Ok(dto_op) = convert::<_, JournalOp>(op) {
        let _ = app.emit("journal_op", JournalOpEvent { op: dto_op });
    }
}

/// Сообщает окну о ходе (пере)индексации: `total==done` → индекс свеж,
/// `done<total` → идёт индексация (StatusBar/настройки следят за этим).
fn emit_index_progress(done: u32, total: u32) {
    if let Some(app) = crate::runtime::app_handle() {
        let _ = app.emit("index_progress", IndexProgressEvent { done, total });
    }
}

/// Транслирует `note_changed` для набора путей (восстановление undo). Пути,
/// которых уже нет на диске (откат создания = удаление), пропускаются — иначе
/// открытая вкладка попыталась бы перечитать несуществующий файл.
fn emit_paths_changed(root: &Path, paths: &[String]) {
    let Some(app) = crate::runtime::app_handle() else {
        return;
    };
    let actor = if actor_is_assistant() { Actor::Assistant } else { Actor::User };
    for path in paths {
        let abs = root.join(path);
        let Ok(bytes) = fs::read(&abs) else { continue };
        let _ = app.emit(
            "note_changed",
            NoteChangedEvent {
                r#ref: NoteRef(format!("path:{path}")),
                rev: Rev(writer::compute_rev(&bytes).0),
                actor,
                kind: Some(NoteChangeKind::Modified),
                from: None,
            },
        );
    }
}

/// Пути файлов операции журнала (для рассылки note_changed после undo).
fn op_paths(root: &Path, op_id: &str) -> Vec<String> {
    let dir = history::journal_dir(root);
    ::history::read_op(&dir, op_id)
        .map(|op| op.files.iter().map(|f| f.path.clone()).collect())
        .unwrap_or_default()
}

/// Пути файлов всех операций сессии (для рассылки note_changed после undo).
fn session_paths(root: &Path, session: &str) -> Vec<String> {
    let dir = history::journal_dir(root);
    ::history::read_session_ops(&dir, session)
        .map(|ops| {
            ops.iter()
                .flat_map(|op| op.files.iter().map(|f| f.path.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Регистрирует только что созданную заметку в индексе, чтобы она сразу
/// резолвилась по ref (иначе последующие мутации возвращают NotFound).
fn reindex_new(rel: &str) {
    let paths = [rel.to_string()];
    let _ = with_core(|s| s.index.reindex_paths(&s.root, &paths).map_err(core_err));
}

/// Журналирует создание заметки: `after`-снапшот содержимого кладётся в
/// объектное хранилище (через `history::record` → `snapshot_after`), поэтому
/// `before`-снапшот первой же правки этого файла находится и её undo работает.
/// Само создание тоже становится откатываемой операцией. Реиндексацию делает
/// отдельный `reindex_new`, поэтому здесь только журнал и трансляция события.
fn record_create(rel: &str, text: &str) {
    let hash = ::history::snapshot::labeled_hash(text.as_bytes());
    let actor = if actor_is_assistant() {
        vault_core::Actor::Assistant
    } else {
        vault_core::Actor::User
    };
    let op = vault_core::JournalOp {
        op_id: ulid::Ulid::new().to_string(),
        ts: writer::now_iso_utc(),
        actor,
        session: None,
        tool: None,
        summary: format!("Создание заметки: {rel}"),
        files: vec![vault_core::FileChange {
            path: rel.to_string(),
            before: None,
            after: Some(hash),
        }],
        undone: false,
    };
    let _ = with_core(|s| history::record(&s.root, &op).map_err(core_err));
    emit_mutation_events(&op, NoteChangeKind::Created);
}

/// Полная переиндексация vault на отдельном соединении, БЕЗ удержания мьютекса
/// ядра: тяжёлый rescan не должен блокировать остальные команды/MCP/watcher.
/// Смонтированное соединение видит закоммиченный результат (WAL), отдельный swap
/// не нужен.
fn rebuild_off_lock(root: &Path) -> Result<(), GraphiteError> {
    let mut files = Vec::new();
    walk_md_files(root, "", &mut files);
    let total = files.len() as u32;
    emit_index_progress(0, total.max(1));
    let db = root.join(".graphite").join("index.db");
    let mut index = Index::open(db.as_path()).map_err(core_err)?;
    index.rebuild(root).map_err(core_err)?;
    emit_index_progress(total, total);
    Ok(())
}

fn ref_to_rel(r: &str) -> Result<String, GraphiteError> {
    let Some(p) = r.strip_prefix("path:") else {
        return Err(gerr(
            GraphiteErrorCode::Validation,
            format!("неподдерживаемая форма ссылки: {r}"),
            Some("используй path:относительный/путь.md"),
        ));
    };
    let rel = p.replace('\\', "/");
    if rel.split('/').any(|seg| seg == "..") {
        return Err(gerr(GraphiteErrorCode::Validation, "путь выходит за пределы хранилища", None));
    }
    Ok(rel.trim_matches('/').to_string())
}

/// Резолвит ссылку в относительный путь. `path:` — чистой строковой логикой
/// (работает и для ещё не проиндексированных файлов). Прочие формы (`id:`,
/// заголовок, alias) резолвятся через индекс — так `search → note_read`, а также
/// `id:`-родитель/корень работают единообразно (иначе VALIDATION на любом `id:`).
fn resolve_rel(r: &str) -> Result<String, GraphiteError> {
    if r.starts_with("path:") {
        return ref_to_rel(r);
    }
    with_core(|s| {
        s.index
            .note_by_ref(&vault_core::NoteRef(r.to_string()))
            .map(|meta| meta.path)
            .map_err(core_err)
    })
}

fn is_service_dir(name: &str) -> bool {
    name.starts_with('.') || name == "_assets" || name == "node_modules" || name == "target"
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_from_systime(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn walk_md_files(root: &Path, dir_rel: &str, out: &mut Vec<String>) {
    let abs = if dir_rel.is_empty() { root.to_path_buf() } else { root.join(dir_rel) };
    let Ok(entries) = fs::read_dir(&abs) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !is_service_dir(&name) {
                walk_md_files(root, &rel, out);
            }
        } else if name.to_lowercase().ends_with(".md") {
            out.push(rel);
        }
    }
}

fn vault_info_impl() -> Result<VaultInfoResponse, GraphiteError> {
    let root = current_root()?;
    let mut files = Vec::new();
    walk_md_files(&root, "", &mut files);
    let mut plans = 0u32;
    let mut tasks_open = 0u32;
    let mut inbox = 0u32;
    for rel in &files {
        if rel.starts_with("Входящие/") {
            inbox += 1;
        }
        let abs = root.join(rel);
        if let Ok(meta) = fs::metadata(&abs) {
            if meta.len() > 512 * 1024 {
                continue;
            }
        }
        if let Ok(raw) = fs::read_to_string(&abs) {
            // План определяем по типу во frontmatter, а не по подстроке «type: plan»
            // в первых 600 символах: иначе упоминание в теле давало ложный +1
            // (наблюдалось «Планы 2» при единственном плане).
            if let Ok((fm, _)) = parser::parse_frontmatter(&raw) {
                if fm.r#type == Some(vault_core::NoteType::Plan) {
                    plans += 1;
                }
            }
            tasks_open += raw.matches("- [ ]").count() as u32;
        }
    }
    Ok(VaultInfoResponse {
        schema_version: vault_core::SCHEMA_VERSION.to_string(),
        vault_format: vault_core::VAULT_FORMAT.to_string(),
        root: root.to_string_lossy().to_string(),
        counts: VaultCounts {
            notes: files.len() as u32,
            plans,
            tasks_open,
            inbox,
        },
        capabilities: Vec::new(),
        limits: VaultLimits {
            max_response_bytes: 51_200,
            tree_limit_max: 500,
            search_limit_max: 50,
            mutations_rps: 5,
        },
        conventions_digest: "graphite-vault-format-1".to_string(),
    })
}

fn mount_vault(path: &str, create: bool) -> Result<VaultInfoResponse, GraphiteError> {
    let root = PathBuf::from(path);
    if create {
        fs::create_dir_all(root.join("Входящие"))
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать хранилище: {e}"), None))?;
    } else if !root.is_dir() {
        return Err(gerr(GraphiteErrorCode::NotFound, format!("папка не найдена: {path}"), None));
    }
    for dir in [".graphite", ".trash", "_assets"] {
        let _ = fs::create_dir_all(root.join(dir));
    }
    let db = root.join(".graphite").join("index.db");
    let index = match Index::open(&db) {
        Ok(index) => index,
        Err(_) => {
            // Индекс — перестраиваемый кэш. Повреждённый/залоченный после
            // аварийного завершения (kill/креш) удаляем и открываем заново,
            // чтобы vault не выглядел «пропавшим» и монтировался всегда.
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(root.join(".graphite").join(format!("index.db{suffix}")));
            }
            Index::open(&db).map_err(core_err)?
        }
    };
    crate::runtime::save_last_vault(&root);
    *lock_core() = Some(CoreState { root: root.clone(), index });
    // Если корень — известная sync-реплика, активировать её (фоновый цикл
    // подхватит по интервалу). Не sync-корень снимает прежнюю активную реплику.
    crate::sync::activate_for_root(&root);
    // Тёплый полный rebuild — в фоне: окно не блокируется на «тысячах файлов».
    // Дерево и счётчики (обход ФС) корректны сразу; поиск/задачи/связи работают
    // на сохранённом индексе и догоняются фоном. Смонтированное соединение видит
    // результат по WAL.
    std::thread::spawn(move || {
        let _ = rebuild_off_lock(&root);
    });
    vault_info_impl()
}

/// Монтирует последний открытый vault на старте приложения. Тихо пропускает
/// отсутствие сохранённого пути или недоступную папку, чтобы старт без vault
/// не падал — ядро просто ждёт выбора.
pub fn mount_saved_vault() {
    if lock_core().is_some() {
        return;
    }
    if let Some(path) = crate::runtime::load_last_vault() {
        if path.is_dir() {
            let _ = mount_vault(&path.to_string_lossy(), false);
        }
    }
}

fn de<T: DeserializeOwned>(params: serde_json::Value) -> Result<T, GraphiteError> {
    let params = if params.is_null() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        params
    };
    serde_json::from_value(params).map_err(|e| {
        gerr(
            GraphiteErrorCode::Validation,
            format!("некорректные параметры: {e}"),
            Some("проверь форму аргументов метода"),
        )
    })
}

fn ser<T: Serialize>(value: T) -> Result<serde_json::Value, GraphiteError> {
    serde_json::to_value(value)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("сериализация ответа: {e}"), None))
}

/// Единый диспетчер методов ядра: имя метода → типизированная команда. Общий
/// путь для Tauri-обёрток (через свои сигнатуры) и pipe-Handler (по имени).
/// `hello`, `ui_open_note`, `ui_flash_note` обслуживает приложение, не ядро.
pub fn dispatch(method: &str, params: serde_json::Value) -> Result<serde_json::Value, GraphiteError> {
    ASSISTANT_ACTOR.with(|a| a.set(true));
    let _actor_guard = AssistantActorGuard;
    match method {
        "vault_info" => ser(vault_info()?),
        "vault_tree" => ser(vault_tree(de(params)?)?),
        "note_read" => ser(note_read(de(params)?)?),
        "search" => ser(search(de(params)?)?),
        "links_get" => ser(links_get(de(params)?)?),
        "activity_get" => ser(activity_get(de(params)?)?),
        "context_briefing" => ser(context_briefing()?),
        "note_create" => ser(note_create(de(params)?)?),
        "note_edit" => ser(note_edit(de(params)?)?),
        "note_move" => ser(note_move(de(params)?)?),
        "note_rename" => ser(note_rename(de(params)?)?),
        "note_delete" => ser(note_delete(de(params)?)?),
        "note_restore" => ser(note_restore(de(params)?)?),
        "set_status" => ser(set_status(de(params)?)?),
        "link_add" => ser(link_add(de(params)?)?),
        "link_remove" => ser(link_remove(de(params)?)?),
        "tasks_query" => ser(tasks_query(de(params)?)?),
        "task_check" => ser(task_check(de(params)?)?),
        "plan_create" => ser(plan_create(de(params)?)?),
        "plan_update" => ser(plan_update(de(params)?)?),
        "plan_progress" => ser(plan_progress(de(params)?)?),
        "distill_context" => ser(distill_context(de(params)?)?),
        "distill_save" => ser(distill_save(de(params)?)?),
        "index_status" => ser(index_status()?),
        "reindex" => {
            let full = params.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
            reindex(full)?;
            ser(serde_json::json!({ "started": true }))
        }
        "set_icon" => ser(set_icon(de(params)?)?),
        "note_pin" => ser(note_pin(de(params)?)?),
        "bundle_compose" => ser(bundle_compose(de(params)?)?),
        "bundle_create" => ser(bundle_create(de(params)?)?),
        "idea_to_tasks" => ser(idea_to_tasks(de(params)?)?),
        "add_path_note" => ser(add_path_note(de(params)?)?),
        "save_attachment" => ser(save_attachment(de(params)?)?),
        "save_attachment_from_path" => ser(save_attachment_from_path(de(params)?)?),
        "journal_list" => ser(journal_list(de(params)?)?),
        "undo_op" => {
            let op_id = params.get("opId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            ser(undo_op(op_id)?)
        }
        "undo_session" => {
            let session = params.get("session").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            ser(undo_session(session)?)
        }
        "hello" | "ui_open_note" | "ui_flash_note" => Err(gerr(
            GraphiteErrorCode::Unavailable,
            format!("метод «{method}» обслуживается приложением, не ядром"),
            None,
        )),
        _ => Err(gerr(
            GraphiteErrorCode::NotFound,
            format!("неизвестный метод «{method}»"),
            None,
        )),
    }
}

fn count_md_children(abs_dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(abs_dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => !is_service_dir(&name),
                Ok(_) => name.to_lowercase().ends_with(".md") && name != "_index.md",
                Err(_) => false,
            }
        })
        .count() as u32
}

fn read_fm(abs: &Path) -> vault_core::Frontmatter {
    fs::read_to_string(abs)
        .ok()
        .and_then(|raw| parser::parse_frontmatter(&raw).ok())
        .map(|(fm, _)| fm)
        .unwrap_or_default()
}

fn yml_str(fm: &vault_core::Frontmatter, key: &str) -> Option<String> {
    fm.extra.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn note_type_dto(t: Option<vault_core::NoteType>) -> NoteType {
    t.and_then(|t| convert::<_, NoteType>(&t).ok()).unwrap_or(NoteType::Note)
}

fn status_dto(s: Option<vault_core::Status>) -> Option<Status> {
    s.and_then(|s| convert::<_, Status>(&s).ok())
}

fn node_for(rel: &str, fallback_title: &str, abs: &Path, children_count: u32) -> TreeNode {
    let updated = fs::metadata(abs)
        .and_then(|m| m.modified())
        .map(iso_from_systime)
        .unwrap_or_else(|_| writer::now_iso_utc());
    let fm = read_fm(abs);
    let title = fm
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    TreeNode {
        r#ref: NoteRef(format!("path:{rel}")),
        path: rel.to_string(),
        title,
        r#type: note_type_dto(fm.r#type),
        status: status_dto(fm.status),
        children_count,
        updated,
        icon: yml_str(&fm, "icon"),
        icon_color: yml_str(&fm, "icon_color").or_else(|| yml_str(&fm, "iconColor")),
        pinned: fm.extra.get("pinned").and_then(|v| v.as_bool()),
    }
}

fn build_tree(root: &Path, dir_rel: &str, depth: Option<u32>, out: &mut Vec<TreeNode>) {
    let abs = if dir_rel.is_empty() { root.to_path_buf() } else { root.join(dir_rel) };
    let Ok(entries) = fs::read_dir(&abs) else { return };
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                if !is_service_dir(&name) {
                    dirs.push(name);
                }
            }
            Ok(_) => {
                if name.to_lowercase().ends_with(".md") && name != "_index.md" {
                    files.push(name);
                }
            }
            Err(_) => {}
        }
    }
    dirs.sort_by_key(|a| a.to_lowercase());
    files.sort_by_key(|a| a.to_lowercase());
    for name in dirs {
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let abs_dir = root.join(&rel);
        let index_rel = format!("{rel}/_index.md");
        let index_abs = root.join(&index_rel);
        if index_abs.is_file() {
            out.push(node_for(&index_rel, &name, &index_abs, count_md_children(&abs_dir)));
        }
        if depth.map(|d| d > 1).unwrap_or(true) {
            build_tree(root, &rel, depth.map(|d| d - 1), out);
        }
    }
    for name in files {
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let title = name.trim_end_matches(".md").trim_end_matches(".MD");
        out.push(node_for(&rel, title, &root.join(&rel), 0));
    }
}

fn frontmatter_to_dto(fm: &vault_core::Frontmatter) -> Frontmatter {
    let mut dto: Frontmatter = serde_json::to_value(fm)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if dto.icon.is_none() {
        dto.icon = yml_str(fm, "icon");
    }
    if dto.icon_color.is_none() {
        dto.icon_color = yml_str(fm, "icon_color").or_else(|| yml_str(fm, "iconColor"));
    }
    dto.extra.remove("icon");
    dto.extra.remove("icon_color");
    dto.extra.remove("iconColor");
    dto
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn enum_str<T: serde::Serialize>(v: &T, fallback: &str) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| fallback.to_string())
}

fn note_create_impl(
    parent: Option<String>,
    title: &str,
    r#type: Option<NoteType>,
    status: Option<Status>,
    tags: Option<Vec<String>>,
    content: Option<String>,
) -> Result<(NoteCreateResponse, String), GraphiteError> {
    let root = current_root()?;
    let mut parent_rel = match parent {
        Some(r) => resolve_rel(&r)?,
        None => "Входящие".to_string(),
    };
    if let Some(stripped) = parent_rel.strip_suffix("/_index.md") {
        parent_rel = stripped.to_string();
    } else if parent_rel.to_lowercase().ends_with(".md") {
        parent_rel = parent_rel.trim_end_matches(".md").trim_end_matches(".MD").to_string();
    }
    if !parent_rel.is_empty() {
        fs::create_dir_all(root.join(&parent_rel))
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать папку: {e}"), None))?;
    }
    let base = writer::sanitize_file_name(title);
    let mut rel = if parent_rel.is_empty() { format!("{base}.md") } else { format!("{parent_rel}/{base}.md") };
    let mut n = 2u32;
    while root.join(&rel).exists() {
        rel = if parent_rel.is_empty() {
            format!("{base} {n}.md")
        } else {
            format!("{parent_rel}/{base} {n}.md")
        };
        n += 1;
    }
    let now = writer::now_iso_utc();
    let id = ulid::Ulid::new().to_string();
    let type_str = r#type.map(|t| enum_str(&t, "note")).unwrap_or_else(|| "note".to_string());
    let status_str = status.map(|s| enum_str(&s, "inbox")).unwrap_or_else(|| "inbox".to_string());
    let mut fm = String::from("---\n");
    fm.push_str(&format!("id: {id}\n"));
    fm.push_str(&format!("type: {type_str}\n"));
    fm.push_str(&format!("title: {}\n", yaml_quote(title)));
    if let Some(tags) = tags {
        if !tags.is_empty() {
            fm.push_str(&format!(
                "tags: [{}]\n",
                tags.iter().map(|t| yaml_quote(t)).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    fm.push_str(&format!("status: {status_str}\n"));
    fm.push_str(&format!("created: {now}\n"));
    fm.push_str(&format!("updated: {now}\n"));
    fm.push_str("---\n\n");
    let body = content.unwrap_or_default();
    let text = format!("{fm}{body}");
    let rev = writer::create_atomic(&root, &rel, &text).map_err(core_err)?;
    let resp = NoteCreateResponse {
        r#ref: NoteRef(format!("path:{rel}")),
        path: rel,
        rev: Rev(rev.0),
    };
    Ok((resp, text))
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_info() -> Result<VaultInfoResponse, GraphiteError> {
    vault_info_impl()
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_tree(params: VaultTreeParams) -> Result<VaultTreeResponse, GraphiteError> {
    let root = current_root()?;
    let start_rel = match params.root {
        Some(r) => {
            let rel = resolve_rel(&r.0)?;
            rel.strip_suffix("/_index.md").map(|s| s.to_string()).unwrap_or(rel)
        }
        None => String::new(),
    };
    let mut nodes = Vec::new();
    build_tree(&root, &start_rel, params.depth, &mut nodes);
    if let Some(types) = &params.types {
        if !types.is_empty() {
            nodes.retain(|n| types.contains(&n.r#type));
        }
    }
    let total = nodes.len() as u32;
    let offset = params.offset.unwrap_or(0) as usize;
    let limit = params.limit.unwrap_or(500).min(500) as usize;
    let page = if offset >= nodes.len() {
        Vec::new()
    } else {
        let end = offset.saturating_add(limit).min(nodes.len());
        nodes[offset..end].to_vec()
    };
    Ok(VaultTreeResponse { nodes: page, total })
}

/// Формирует поле `content` ответа. Без section/offset/maxChars — весь файл как
/// есть (редактор гоняет его байт-в-байт через buffer_save, усечение недопустимо).
/// С `section` — срез тела по заголовку (фронтматтер не попадает, он в отдельном
/// поле). `offset`/`maxChars` считаются в символах (безопасно для кириллицы) и
/// выставляют `truncated`.
fn shape_note_content(raw: &str, body: &str, params: &NoteReadParams) -> (String, Option<bool>) {
    let (base, mut sliced) = match &params.section {
        Some(section) => {
            let text = match parser::find_section(body, section) {
                Ok(Some((start, end))) => body[start..end].to_string(),
                _ => String::new(),
            };
            (text, true)
        }
        None => (raw.to_string(), false),
    };
    if params.offset.is_none() && params.max_chars.is_none() {
        return (base, if sliced { Some(true) } else { None });
    }
    let chars: Vec<char> = base.chars().collect();
    let total = chars.len();
    let offset = (params.offset.unwrap_or(0) as usize).min(total);
    let take = params.max_chars.map(|m| m as usize).unwrap_or(total - offset);
    let end = offset.saturating_add(take).min(total);
    if offset > 0 || end < total {
        sliced = true;
    }
    let out: String = chars[offset..end].iter().collect();
    (out, if sliced { Some(true) } else { None })
}

type NoteIncludes = (
    Option<Vec<LinkEdge>>,
    Option<Vec<LinkEdge>>,
    Option<Vec<TreeNode>>,
    Option<Vec<TaskItem>>,
);

/// Резолвит запрошенные include-срезы через индекс. Не в индексе (свежий файл)
/// или ядро не смонтировано — мягко пусто, а не ошибка.
fn read_includes(root: &Path, rel: &str, include: Option<&[NoteReadInclude]>) -> NoteIncludes {
    let Some(include) = include.filter(|i| !i.is_empty()) else {
        return (None, None, None, None);
    };
    let want = |kind: NoteReadInclude| include.contains(&kind);
    with_core(|s| {
        let Ok(meta) = s.index.note_by_ref(&vault_core::NoteRef(format!("path:{rel}"))) else {
            return Ok((None, None, None, None));
        };
        let links = if want(NoteReadInclude::Links) {
            let edges = vault_core::resolver::outgoing(&s.index, &meta.id).map_err(core_err)?;
            Some(convert::<_, Vec<LinkEdge>>(&edges)?)
        } else {
            None
        };
        let backlinks = if want(NoteReadInclude::Backlinks) {
            let edges = vault_core::resolver::backlinks(&s.index, &meta.id).map_err(core_err)?;
            Some(convert::<_, Vec<LinkEdge>>(&edges)?)
        } else {
            None
        };
        let children = if want(NoteReadInclude::Children) {
            let kids = s.index.children_of(&meta.id).map_err(core_err)?;
            Some(kids.iter().map(|m| child_node(root, m)).collect::<Vec<TreeNode>>())
        } else {
            None
        };
        let tasks = if want(NoteReadInclude::Tasks) {
            let items = s.index.tasks_for_note(&meta.id).map_err(core_err)?;
            Some(convert::<_, Vec<TaskItem>>(&items)?)
        } else {
            None
        };
        Ok((links, backlinks, children, tasks))
    })
    .unwrap_or((None, None, None, None))
}

fn child_node(root: &Path, meta: &vault_core::NoteMeta) -> TreeNode {
    let abs = root.join(&meta.path);
    let count = if meta.path.ends_with("/_index.md") || meta.path == "_index.md" {
        count_md_children(abs.parent().unwrap_or(root))
    } else {
        0
    };
    node_for(&meta.path, &meta.title, &abs, count)
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_read(params: NoteReadParams) -> Result<NoteReadResponse, GraphiteError> {
    let root = current_root()?;
    let rel = resolve_rel(&params.r#ref.0)?;
    let abs = root.join(&rel);
    if !abs.is_file() {
        return Err(gerr(GraphiteErrorCode::NotFound, format!("заметка не найдена: {rel}"), None));
    }
    let raw = fs::read_to_string(&abs)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось прочитать файл: {e}"), None))?;
    let rev = writer::compute_rev(raw.as_bytes());
    let parsed = parser::parse_note(&raw).ok();
    let fm = parsed
        .as_ref()
        .map(|p| frontmatter_to_dto(&p.frontmatter))
        .unwrap_or_else(|| frontmatter_to_dto(&vault_core::Frontmatter::default()));
    let body_src: &str = parsed.as_ref().map(|p| p.body.as_str()).unwrap_or(raw.as_str());
    let (content, truncated) = shape_note_content(&raw, body_src, &params);
    let (links, backlinks, children, tasks) = read_includes(&root, &rel, params.include.as_deref());
    Ok(NoteReadResponse {
        frontmatter: fm,
        content,
        rev: Rev(rev.0),
        truncated,
        links,
        backlinks,
        children,
        tasks,
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn search(params: SearchParams) -> Result<SearchResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::SearchParams = convert(&params)?;
        let resp = query::search(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn links_get(params: LinksGetParams) -> Result<LinksGetResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinksGetParams = convert(&params)?;
        let resp = query::links_get(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn activity_get(params: ActivityGetParams) -> Result<ActivityGetResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::ActivityGetParams = convert(&params)?;
        let resp = query::activity_get(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn context_briefing() -> Result<ContextBriefingResponse, GraphiteError> {
    with_core(|s| {
        let resp = ai::context_briefing(&s.root, &s.index).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_create(params: NoteCreateParams) -> Result<NoteCreateResponse, GraphiteError> {
    let (resp, text) = note_create_impl(
        params.parent.map(|r| r.0),
        &params.title,
        params.r#type,
        params.status,
        params.tags,
        params.content,
    )?;
    reindex_new(&resp.path);
    record_create(&resp.path, &text);
    Ok(resp)
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_edit(params: NoteEditParams) -> Result<NoteEditResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteEditParams = convert(&params)?;
        let (resp, op) = crud::note_edit(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_move(params: NoteMoveParams) -> Result<NoteMoveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteMoveParams = convert(&params)?;
        let (resp, op) = crud::note_move(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_rename(params: NoteRenameParams) -> Result<NoteRenameResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteRenameParams = convert(&params)?;
        let (resp, op) = crud::note_rename(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_delete(params: NoteDeleteParams) -> Result<NoteDeleteResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteDeleteParams = convert(&params)?;
        let (resp, op) = crud::note_delete(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_restore(params: NoteRestoreParams) -> Result<NoteRestoreResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteRestoreParams = convert(&params)?;
        let (resp, op) = crud::note_restore(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn set_status(params: SetStatusParams) -> Result<SetStatusResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::SetStatusParams = convert(&params)?;
        let (resp, op) = crud::set_status(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn link_add(params: LinkAddParams) -> Result<LinkAddResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinkAddParams = convert(&params)?;
        let (resp, op) = crud::link_add(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn link_remove(params: LinkRemoveParams) -> Result<LinkRemoveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinkRemoveParams = convert(&params)?;
        let (resp, op) = crud::link_remove(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn tasks_query(params: TasksQueryParams) -> Result<TasksQueryResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::TasksQueryParams = convert(&params)?;
        let resp = query::tasks_query(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn task_check(params: TaskCheckParams) -> Result<TaskCheckResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::TaskCheckParams = convert(&params)?;
        let (resp, op) = query::task_check(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn plan_create(params: PlanCreateParams) -> Result<PlanCreateResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanCreateParams = convert(&params)?;
        let (resp, op) = planning::plan_create(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn plan_update(params: PlanUpdateParams) -> Result<PlanUpdateResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanUpdateParams = convert(&params)?;
        let (resp, op) = planning::plan_update(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn plan_progress(params: PlanProgressParams) -> Result<PlanProgressResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanProgressParams = convert(&params)?;
        let resp = planning::plan_progress(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn distill_context(
    params: DistillContextParams,
) -> Result<DistillContextResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::DistillContextParams = convert(&params)?;
        let resp = ai::distill_context(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn distill_save(params: DistillSaveParams) -> Result<DistillSaveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::DistillSaveParams = convert(&params)?;
        let (resp, op) = ai::distill_save(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn buffer_save(params: BufferSaveParams) -> Result<NoteEditResponse, GraphiteError> {
    let root = current_root()?;
    let rel = ref_to_rel(&params.r#ref.0)?;
    let abs = root.join(&rel);
    let old = fs::read_to_string(&abs).unwrap_or_default();
    let cur_rev = writer::compute_rev(old.as_bytes());
    if !old.is_empty() && cur_rev.0 != params.base_rev.0 {
        let mut err = gerr(
            GraphiteErrorCode::Conflict,
            "файл изменился вне редактора",
            Some("перечитай note_read и сохрани заново"),
        );
        err.data = Some(serde_json::json!({ "rev": cur_rev.0 }));
        return Err(err);
    }
    let rev_new = writer::write_atomic(&root, &rel, params.content.as_bytes()).map_err(core_err)?;
    // Запись редактора эхо-гасится watcher-ом, поэтому индекс обновляем здесь —
    // иначе поиск/бэклинки/задачи по правке остаются устаревшими до reindex.
    let _ = with_core(|s| {
        s.index
            .reindex_paths(&s.root, std::slice::from_ref(&rel))
            .map_err(core_err)
    });
    // Эхо-подавление лишает второе окно той же заметки события от watcher-а,
    // поэтому синхронизацию окон обеспечивает сама команда: рассылаем
    // note_changed с новым rev. Окно-инициатор узнаёт свою запись по rev
    // (он совпадает с revNew ответа) и не перечитывает буфер.
    if let Some(app) = crate::runtime::app_handle() {
        let actor = if actor_is_assistant() { Actor::Assistant } else { Actor::User };
        let _ = app.emit(
            "note_changed",
            NoteChangedEvent {
                r#ref: NoteRef(format!("path:{rel}")),
                rev: Rev(rev_new.0.clone()),
                actor,
                kind: Some(NoteChangeKind::BufferBody),
                from: None,
            },
        );
    }
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = params.content.lines().collect();
    let common = old_lines.iter().zip(new_lines.iter()).filter(|(a, b)| a == b).count();
    Ok(NoteEditResponse {
        rev_new: Rev(rev_new.0),
        diff_stat: DiffStat {
            plus: (new_lines.len() - common) as u32,
            minus: (old_lines.len() - common) as u32,
        },
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn index_status() -> Result<IndexStatus, GraphiteError> {
    with_core(|s| {
        let st = s.index.status().map_err(core_err)?;
        convert(&st)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn reindex(full: bool) -> Result<(), GraphiteError> {
    let _ = full;
    let root = current_root()?;
    rebuild_off_lock(&root)
}

#[tauri::command(async)]
#[specta::specta]
pub fn undo_op(op_id: String) -> Result<UndoResult, GraphiteError> {
    let root = current_root()?;
    let paths = op_paths(&root, &op_id);
    let res: UndoResult = with_core(|s| {
        let res = history::undo_op(&s.root, &mut s.index, &op_id).map_err(core_err)?;
        convert(&res)
    })?;
    if res.restored_files > 0 {
        emit_paths_changed(&root, &paths);
    }
    Ok(res)
}

#[tauri::command(async)]
#[specta::specta]
pub fn undo_session(session: String) -> Result<UndoResult, GraphiteError> {
    let root = current_root()?;
    let paths = session_paths(&root, &session);
    let res: UndoResult = with_core(|s| {
        let res = history::undo_session(&s.root, &mut s.index, &session).map_err(core_err)?;
        convert(&res)
    })?;
    if res.restored_files > 0 {
        emit_paths_changed(&root, &paths);
    }
    Ok(res)
}

#[tauri::command(async)]
#[specta::specta]
pub fn journal_list(params: ActivityGetParams) -> Result<Vec<JournalOp>, GraphiteError> {
    with_core(|s| {
        let mut params = params;
        // Пустой since = «вся история»: иначе resolve_since('') → Validation, и
        // панель журнала не может попросить полный список.
        if params.since.trim().is_empty() {
            params.since = "1970-01-01T00:00:00Z".to_string();
        }
        // id-scope резолвим в path заранее (как это делает activity_get), иначе
        // фильтр журнала отклонит его как Invalid.
        if let Some(scope) = params.scope.clone() {
            if !scope.0.starts_with("path:") {
                if let Ok(meta) = s.index.note_by_ref(&vault_core::NoteRef(scope.0)) {
                    params.scope = Some(NoteRef(format!("path:{}", meta.path)));
                }
            }
        }
        let p: vault_core::ActivityGetParams = convert(&params)?;
        let ops = history::journal_list(&s.root, &p).map_err(core_err)?;
        convert(&ops)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_open(path: String) -> Result<VaultInfoResponse, GraphiteError> {
    mount_vault(&path, false)
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_create(path: String) -> Result<VaultInfoResponse, GraphiteError> {
    mount_vault(&path, true)
}

#[tauri::command]
#[specta::specta]
pub fn detect_claude_cli() -> Result<ClaudeCliInfo, GraphiteError> {
    Ok(ClaudeCliInfo {
        found: false,
        path: None,
        mcp_add_command: "claude mcp add graphite --transport stdio -- graphite-mcp".to_string(),
    })
}

fn thought_title() -> String {
    use chrono::{Datelike, Timelike};
    let months = [
        "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
    ];
    let now = chrono::Local::now();
    format!(
        "Мысль · {} {} {:02}:{:02}",
        now.day(),
        months[now.month0() as usize],
        now.hour(),
        now.minute()
    )
}

#[tauri::command(async)]
#[specta::specta]
pub fn quick_capture(text: String) -> Result<NoteCreateResponse, GraphiteError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "пустая заметка", None));
    }
    let first = trimmed
        .lines()
        .next()
        .unwrap_or("Быстрая заметка")
        .trim_start_matches(['#', '-', '*', ' '])
        .trim();
    let title: String = if first.chars().count() < 2 {
        thought_title()
    } else {
        first.chars().take(60).collect()
    };
    let (resp, text) = note_create_impl(None, &title, None, None, None, Some(trimmed.to_string()))?;
    reindex_new(&resp.path);
    record_create(&resp.path, &text);
    Ok(resp)
}

/// Отображаемое имя из абсолютного пути: последний сегмент, для корней дисков —
/// сам путь.
fn path_display_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// `file:`-URL пути: локальные диски → `file:///C:/…`, UNC → `file://server/…`.
/// Слэши нормализуются, пробелы/кириллица остаются как есть — назначение
/// вставляется в markdown в угловых скобках `(<…>)`.
fn file_url(path: &str) -> String {
    let forward = path.replace('\\', "/");
    if let Some(unc) = forward.strip_prefix("//") {
        format!("file://{unc}")
    } else {
        format!("file:///{}", forward.trim_start_matches('/'))
    }
}

/// Экранирование текста markdown-ссылки: скобки и обратный слэш.
fn escape_md_link_text(text: &str) -> String {
    text.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]")
}

/// Дроп внешних файлов → заметки-пути (Р28): на каждый путь создаётся заметка
/// во «Входящих» (или под переданным родителем) с кликабельной `file:`-ссылкой
/// и сырым путём — файл фиксируется «где лежит», без копирования в хранилище.
#[tauri::command(async)]
#[specta::specta]
pub fn add_path_note(params: AddPathNoteParams) -> Result<AddPathNoteResponse, GraphiteError> {
    let paths: Vec<String> = params
        .paths
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return Err(gerr(
            GraphiteErrorCode::Validation,
            "не передано ни одного пути",
            Some("paths — абсолютные пути внешних файлов"),
        ));
    }
    let parent = params.parent.map(|r| r.0);
    let mut notes = Vec::with_capacity(paths.len());
    for path in &paths {
        let name = path_display_name(path);
        let body = format!(
            "[{}](<{}>)\n\n`{}`\n",
            escape_md_link_text(&name),
            file_url(path),
            path
        );
        let (resp, text) = note_create_impl(
            parent.clone(),
            &name,
            None,
            None,
            Some(vec!["файл".to_string()]),
            Some(body),
        )?;
        reindex_new(&resp.path);
        record_create(&resp.path, &text);
        notes.push(resp);
    }
    Ok(AddPathNoteResponse { notes })
}

/// Потолок размера вложения: и base64-вставка, и импорт по пути читаются в
/// память целиком — гигабайтные файлы отклоняем доменной ошибкой, а не OOM.
const ATTACHMENT_MAX_BYTES: usize = 256 * 1024 * 1024;

/// Расширение файла вложения: точка/мусор срезаются, только ASCII-буквоцифры,
/// нижний регистр, не длиннее 12 символов; пусто → `bin`.
fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

/// Base64-полезная нагрузка вставки: допускается data-URL (`data:…;base64,…`)
/// и переносы строк внутри тела.
fn decode_base64_payload(data: &str) -> Result<Vec<u8>, GraphiteError> {
    let trimmed = data.trim();
    let payload = match (trimmed.starts_with("data:"), trimmed.find("base64,")) {
        (true, Some(idx)) => &trimmed[idx + "base64,".len()..],
        _ => trimmed,
    };
    let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64
        .decode(cleaned.as_bytes())
        .map_err(|e| gerr(GraphiteErrorCode::Validation, format!("некорректный base64: {e}"), None))
}

/// Поиск уже сохранённого вложения с тем же содержимым (SPEC §6.7, дедуп по
/// blake3): обход `_assets/` с префильтром по размеру, хэш считается только у
/// кандидатов равной длины. Возвращает rel-путь с `/`-разделителями.
fn find_asset_duplicate(root: &Path, len: u64, hash: &str) -> Option<String> {
    let mut stack = vec![(root.join("_assets"), "_assets".to_string())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let child_rel = format!("{rel}/{name}");
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push((entry.path(), child_rel)),
                Ok(ft) if ft.is_file() => {
                    let Ok(meta) = entry.metadata() else { continue };
                    if meta.len() != len {
                        continue;
                    }
                    let Ok(data) = fs::read(entry.path()) else { continue };
                    if writer::compute_full_hash(&data) == hash {
                        return Some(child_rel);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Общий сохранитель вложений (Р29): дедуп по blake3, иначе атомарная запись в
/// `_assets/ГГГГ/ММ/<ulid>.<расширение>`. Возвращает rel-путь для вставки
/// `![](_assets/…)`.
fn save_attachment_bytes(bytes: &[u8], ext: &str) -> Result<SaveAttachmentResponse, GraphiteError> {
    if bytes.is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "пустое вложение", None));
    }
    if bytes.len() > ATTACHMENT_MAX_BYTES {
        return Err(gerr(
            GraphiteErrorCode::Limit,
            format!("вложение больше {} МБ", ATTACHMENT_MAX_BYTES / (1024 * 1024)),
            Some("сохрани файл рядом и добавь его путь через add_path_note"),
        ));
    }
    let root = current_root()?;
    let size = bytes.len() as u32;
    let hash = writer::compute_full_hash(bytes);
    if let Some(existing) = find_asset_duplicate(&root, bytes.len() as u64, &hash) {
        return Ok(SaveAttachmentResponse {
            rel_path: existing,
            bytes: size,
            reused: true,
        });
    }
    let now = writer::now_iso_utc();
    let rel = format!(
        "_assets/{}/{}/{}.{}",
        &now[0..4],
        &now[5..7],
        ulid::Ulid::new(),
        sanitize_ext(ext)
    );
    writer::write_atomic(&root, &rel, bytes).map_err(core_err)?;
    Ok(SaveAttachmentResponse {
        rel_path: rel,
        bytes: size,
        reused: false,
    })
}

/// Вставка картинки/файла из буфера (Р29): содержимое приходит base64
/// (допустим data-URL), сохраняется в `_assets/ГГГГ/ММ/<ulid>.<ext>` с дедупом
/// по blake3.
#[tauri::command(async)]
#[specta::specta]
pub fn save_attachment(params: SaveAttachmentParams) -> Result<SaveAttachmentResponse, GraphiteError> {
    let bytes = decode_base64_payload(&params.data_base64)?;
    save_attachment_bytes(&bytes, &params.ext)
}

/// Импорт вложения с диска (Р29): файл читается по абсолютному пути и
/// сохраняется в `_assets/` той же схемой (дедуп, ulid-имя); расширение
/// берётся из исходного имени.
#[tauri::command(async)]
#[specta::specta]
pub fn save_attachment_from_path(
    params: SaveAttachmentFromPathParams,
) -> Result<SaveAttachmentResponse, GraphiteError> {
    let src = params.src_path.trim();
    if src.is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "пустой путь к файлу", None));
    }
    let path = PathBuf::from(src);
    if !path.is_file() {
        return Err(gerr(
            GraphiteErrorCode::NotFound,
            format!("файл не найден: {src}"),
            None,
        ));
    }
    let bytes = fs::read(&path)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось прочитать файл: {e}"), None))?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    save_attachment_bytes(&bytes, &ext)
}

/// Гарантирует существование folder-note для ссылок вида `path:…/_index.md`:
/// у «виртуальной» папки (каталог есть, `_index.md` нет) файл создаётся с
/// минимальным frontmatter, чтобы иконку/цвет папки можно было ставить сразу.
/// Ссылки другой формы и существующие файлы проходят насквозь.
fn ensure_folder_note(note_ref: &str) -> Result<(), GraphiteError> {
    let Some(raw) = note_ref.strip_prefix("path:") else {
        return Ok(());
    };
    let rel = raw.replace('\\', "/").trim_matches('/').to_string();
    if rel != "_index.md" && !rel.ends_with("/_index.md") {
        return Ok(());
    }
    if rel.split('/').any(|seg| seg == "..") {
        return Err(gerr(GraphiteErrorCode::Validation, "путь выходит за пределы хранилища", None));
    }
    let root = current_root()?;
    let abs = root.join(&rel);
    if abs.is_file() {
        return Ok(());
    }
    let dir = abs.parent().unwrap_or(&root).to_path_buf();
    if !dir.is_dir() {
        return Err(gerr(
            GraphiteErrorCode::NotFound,
            format!("папка не найдена: {rel}"),
            None,
        ));
    }
    let title = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Заметки".to_string());
    let now = writer::now_iso_utc();
    let id = ulid::Ulid::new().to_string();
    let text = format!(
        "---\nid: {id}\ntype: note\ntitle: {}\ncreated: {now}\nupdated: {now}\n---\n\n",
        yaml_quote(&title)
    );
    writer::create_atomic(&root, &rel, &text).map_err(core_err)?;
    reindex_new(&rel);
    record_create(&rel, &text);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn set_icon(params: SetIconParams) -> Result<SetIconResponse, GraphiteError> {
    ensure_folder_note(&params.r#ref.0)?;
    with_core(|s| {
        let p: crud::SetIconParams = convert(&params)?;
        let (resp, op) = crud::set_icon(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn note_pin(params: NotePinParams) -> Result<NotePinResponse, GraphiteError> {
    with_core(|s| {
        let p: crud::NotePinParams = convert(&params)?;
        let (resp, op) = crud::note_pin(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn bundle_compose(params: BundleComposeParams) -> Result<BundleComposeResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::BundleComposeParams = convert(&params)?;
        let resp = ai::bundle_compose(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn bundle_create(params: BundleCreateParams) -> Result<BundleCreateResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::BundleCreateParams = convert(&params)?;
        let (resp, op) = ai::bundle_create(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn idea_to_tasks(params: IdeaToTasksParams) -> Result<IdeaToTasksResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::IdeaToTasksParams = convert(&params)?;
        let (resp, plan_op) = ai::idea_to_tasks(&s.root, &s.index, &p).map_err(core_err)?;
        if let Some(op) = plan_op {
            after_mutation(s, &op);
        }
        convert(&resp)
    })
}

/// Заголовок окна заметки из ссылки: «Имя файла — Graphite».
fn note_window_title(note_ref: &str) -> String {
    let rel = note_ref.strip_prefix("path:").unwrap_or(note_ref);
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    let stem = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .unwrap_or(name);
    if stem.is_empty() {
        "Graphite".to_string()
    } else {
        format!("{stem} — Graphite")
    }
}

/// Выносит заметку в отдельное webview-окно (фича #16). Повторный вызов для той
/// же ссылки фокусирует уже открытое окно, а не плодит дубликаты.
#[tauri::command]
#[specta::specta]
pub fn open_note_window(app: tauri::AppHandle, note_ref: String) -> Result<(), GraphiteError> {
    use tauri::{Emitter, Manager};

    // Переиспользуем заранее объявленное (в tauri.conf) окно «note»: конфиг-окна
    // грузят вшитый фронт надёжно, в отличие от создаваемых в рантайме. Закрытие
    // прячет окно (см. lib.rs), поэтому оно всегда доступно для повторного выноса.
    let window = app.get_webview_window("note").ok_or_else(|| {
        gerr(
            GraphiteErrorCode::Unavailable,
            "окно заметки недоступно",
            Some("перезапусти приложение"),
        )
    })?;
    let _ = window.set_title(&note_window_title(&note_ref));
    let _ = window.emit("note-open", note_ref);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// Абсолютный путь заметки/папки на диске (для «Скопировать путь»).
/// Для folder-note (`…/_index.md`) отдаёт путь самой папки.
#[tauri::command(async)]
#[specta::specta]
pub fn note_abs_path(note_ref: String) -> Result<String, GraphiteError> {
    let root = current_root()?;
    let mut rel = ref_to_rel(&note_ref)?;
    if let Some(stripped) = rel.strip_suffix("/_index.md") {
        rel = stripped.to_string();
    }
    let abs = root.join(&rel).to_string_lossy().to_string();
    #[cfg(windows)]
    let abs = abs.replace('/', "\\");
    Ok(abs)
}

/// Показывает заметку/папку в Проводнике, выделяя её. Для folder-note
/// выделяет саму папку. Идёт через плагин opener: rel-пути ядра канонизированы
/// прямыми слэшами, которые `explorer /select,` не переваривает (уводит в
/// «Документы»), а opener нормализует путь под ОС и проверяет существование.
#[tauri::command]
#[specta::specta]
pub fn reveal_in_explorer(note_ref: String) -> Result<(), GraphiteError> {
    let root = current_root()?;
    let mut rel = ref_to_rel(&note_ref)?;
    if let Some(stripped) = rel.strip_suffix("/_index.md") {
        rel = stripped.to_string();
    }
    let abs = root.join(&rel);
    tauri_plugin_opener::reveal_item_in_dir(&abs).map_err(|e| {
        gerr(
            GraphiteErrorCode::Unavailable,
            format!("не удалось открыть проводник: {e}"),
            None,
        )
    })
}

/// Срез хранилища для вида «Граф связей»: все заметки индекса — узлы, их
/// резолвленные исходящие ссылки — рёбра. Битые ссылки (без `dst_id`) и цели
/// вне индекса отбрасываются, пары источник→цель дедуплицируются, петли на
/// себя не включаются. Пустое хранилище отдаёт пустой граф.
#[tauri::command(async)]
#[specta::specta]
pub fn graph_data() -> Result<GraphData, GraphiteError> {
    let (root, notes, edges) = with_core(|s| {
        let notes = s.index.all_notes().map_err(core_err)?;
        let mut ref_by_id: HashMap<String, String> = HashMap::with_capacity(notes.len());
        for meta in &notes {
            ref_by_id.insert(meta.id.0.clone(), format!("path:{}", meta.path));
        }
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        for meta in &notes {
            let src_ref = format!("path:{}", meta.path);
            for edge in s.index.outgoing(&meta.id).map_err(core_err)? {
                let Some(dst) = edge.dst_id else { continue };
                let Some(dst_ref) = ref_by_id.get(&dst.0) else { continue };
                if *dst_ref == src_ref || !seen.insert((src_ref.clone(), dst_ref.clone())) {
                    continue;
                }
                edges.push(GraphEdge {
                    source: NoteRef(src_ref.clone()),
                    target: NoteRef(dst_ref.clone()),
                });
            }
        }
        Ok((s.root.clone(), notes, edges))
    })?;
    let mut degree: HashMap<String, u32> = HashMap::new();
    for edge in &edges {
        *degree.entry(edge.source.0.clone()).or_insert(0) += 1;
        *degree.entry(edge.target.0.clone()).or_insert(0) += 1;
    }
    // Иконка/цвет живут во frontmatter файлов (как в дереве); читаем их уже
    // без мьютекса ядра, чтобы скан файлов не блокировал остальные команды.
    let mut nodes = Vec::with_capacity(notes.len());
    for meta in &notes {
        let node_ref = format!("path:{}", meta.path);
        let fm = read_fm(&root.join(&meta.path));
        nodes.push(GraphNode {
            r#ref: NoteRef(node_ref.clone()),
            title: meta.title.clone(),
            icon: yml_str(&fm, "icon"),
            color: yml_str(&fm, "icon_color").or_else(|| yml_str(&fm, "iconColor")),
            degree: degree.get(&node_ref).copied().unwrap_or(0),
        });
    }
    Ok(GraphData { nodes, edges })
}

/// Агрегация тегов по всем заметкам: frontmatter-теги из индекса плюс
/// инлайн-`#теги` тела. Ключ агрегата — нормализация §9.3 (регистр, `ё`→`е`),
/// отображается первое встреченное написание; внутри одной заметки тег
/// считается один раз. Сортировка: count по убыванию, затем по алфавиту.
#[tauri::command(async)]
#[specta::specta]
pub fn tags_list() -> Result<Vec<TagInfo>, GraphiteError> {
    let (root, notes) = with_core(|s| Ok((s.root.clone(), s.index.all_notes().map_err(core_err)?)))?;
    let mut by_key: BTreeMap<String, TagInfo> = BTreeMap::new();
    for meta in &notes {
        let note_ref = format!("path:{}", meta.path);
        let mut tags = meta.tags.clone();
        if let Ok(raw) = fs::read_to_string(root.join(&meta.path)) {
            if let Ok(parsed) = parser::parse_note(&raw) {
                tags.extend(parser::extract_tags(&parsed.body));
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        for tag in tags {
            let display = tag.trim().trim_start_matches('#').to_string();
            if display.is_empty() {
                continue;
            }
            let key = vault_core::resolver::normalize_key(&display);
            if !seen.insert(key.clone()) {
                continue;
            }
            let entry = by_key.entry(key).or_insert_with(|| TagInfo {
                tag: display,
                count: 0,
                refs: Vec::new(),
            });
            entry.count += 1;
            entry.refs.push(NoteRef(note_ref.clone()));
        }
    }
    let mut out: Vec<TagInfo> = by_key.into_values().collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    Ok(out)
}

/// Форма даты дневника: строго `ГГГГ-ММ-ДД` (цифры и дефисы на своих местах).
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter()
            .enumerate()
            .all(|(i, c)| if matches!(i, 4 | 7) { *c == b'-' } else { c.is_ascii_digit() })
}

/// Путь пользовательского шаблона записи дня внутри хранилища.
const DAILY_TEMPLATE_REL: &str = "Шаблоны/Дневник.md";

/// Нормализация папки дневника: `\`→`/`, обрезка слэшей, пустая → «Дневник»;
/// сегменты `..` запрещены.
fn daily_folder(folder: Option<String>) -> Result<String, GraphiteError> {
    let folder = folder
        .map(|f| f.replace('\\', "/").trim_matches('/').to_string())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| "Дневник".to_string());
    if folder.split('/').any(|seg| seg == "..") {
        return Err(gerr(GraphiteErrorCode::Validation, "путь выходит за пределы хранилища", None));
    }
    Ok(folder)
}

/// Валидация даты и папки дневника; возвращает (дата, папка, rel-путь записи).
fn daily_target(date: &str, folder: Option<String>) -> Result<(String, String, String), GraphiteError> {
    let date = date.trim().to_string();
    if !is_iso_date(&date) {
        return Err(gerr(
            GraphiteErrorCode::Validation,
            format!("некорректная дата: {date}"),
            Some("ожидается формат ГГГГ-ММ-ДД"),
        ));
    }
    let folder = daily_folder(folder)?;
    let rel = format!("{folder}/{date}.md");
    Ok((date, folder, rel))
}

/// Встроенное тело новой записи дня.
fn default_daily_body(date: &str) -> String {
    format!("# {date}\n\n## Заметки дня\n\n## Задачи\n")
}

/// Подстановка плейсхолдеров шаблона дня: `{{date}}`/`{{title}}` → дата,
/// `{{time}}` → текущее время `ЧЧ:ММ` (UTC).
fn substitute_daily(tpl: &str, date: &str) -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let time = format!("{:02}:{:02}", secs % 86_400 / 3600, secs % 3600 / 60);
    tpl.replace("{{date}}", date)
        .replace("{{title}}", date)
        .replace("{{time}}", &time)
}

/// Тело пользовательского шаблона `Шаблоны/Дневник.md` (без frontmatter),
/// если такой файл есть и парсится.
fn daily_custom_template(root: &Path) -> Option<String> {
    let raw = fs::read_to_string(root.join(DAILY_TEMPLATE_REL)).ok()?;
    parser::parse_frontmatter(&raw).ok().map(|(_, body)| body)
}

/// Тело записи дня «пустое», если каждая непустая строка входит в шаблонный
/// набор: заголовок дня, штатные секции и строки пользовательского шаблона с
/// подставленной датой. Любая иная строка — признак контента (подмножество,
/// не равенство: удалённые заголовки пустоты не отменяют).
fn daily_body_is_empty(body: &str, date: &str, custom_template: Option<&str>) -> bool {
    let mut allowed: HashSet<String> = HashSet::new();
    allowed.insert(format!("# {date}"));
    allowed.insert("## Заметки дня".to_string());
    allowed.insert("## Задачи".to_string());
    if let Some(tpl) = custom_template {
        let filled = tpl.replace("{{date}}", date).replace("{{title}}", date);
        for line in filled.split('\n') {
            let line = line.trim_end();
            // Строки с «{{time}}» зависят от момента создания — их не угадать,
            // поэтому записи с ними безопаснее считать непустыми.
            if !line.is_empty() && !line.contains("{{time}}") {
                allowed.insert(line.to_string());
            }
        }
    }
    body.split('\n')
        .map(|line| line.trim_end())
        .filter(|line| !line.is_empty())
        .all(|line| allowed.contains(line))
}

/// Дневниковая заметка на дату: существующий файл `<папка>/<дата>.md`
/// возвращается как есть (`created=false`), отсутствующий — создаётся с
/// шаблоном дня (пользовательский `Шаблоны/Дневник.md`, иначе встроенный);
/// папка (по умолчанию «Дневник») появляется вместе с ним.
#[tauri::command(async)]
#[specta::specta]
pub fn ensure_daily_note(params: DailyNoteParams) -> Result<DailyNote, GraphiteError> {
    let (date, folder, rel) = daily_target(&params.date, params.folder)?;
    let root = current_root()?;
    let abs = root.join(&rel);
    if abs.is_file() {
        let title = read_fm(&abs)
            .title
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| date.clone());
        return Ok(DailyNote {
            r#ref: NoteRef(format!("path:{rel}")),
            created: false,
            title,
        });
    }
    let body = daily_custom_template(&root)
        .map(|tpl| substitute_daily(&tpl, &date))
        .unwrap_or_else(|| default_daily_body(&date));
    let (resp, text) = note_create_impl(
        Some(format!("path:{folder}")),
        &date,
        Some(NoteType::Journal),
        None,
        None,
        Some(body),
    )?;
    reindex_new(&resp.path);
    record_create(&resp.path, &text);
    Ok(DailyNote {
        r#ref: resp.r#ref,
        created: true,
        title: date,
    })
}

/// Проверка записи дня без побочных эффектов: существует ли файл и его
/// заголовок. Ничего не создаёт и не пишет — календарь листается свободно.
#[tauri::command(async)]
#[specta::specta]
pub fn peek_daily_note(params: DailyNoteParams) -> Result<DailyNotePeek, GraphiteError> {
    let (date, _, rel) = daily_target(&params.date, params.folder)?;
    let root = current_root()?;
    let abs = root.join(&rel);
    let exists = abs.is_file();
    let title = if exists {
        read_fm(&abs)
            .title
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| date.clone())
    } else {
        date.clone()
    };
    Ok(DailyNotePeek {
        r#ref: NoteRef(format!("path:{rel}")),
        exists,
        title,
    })
}

/// Уборка пустых записей дневника: нетронутые шаблоны уезжают в корзину тем же
/// механизмом, что и обычное удаление (журнал, обновление индекса и токены для
/// отмены). `dry_run` — только пересчитать кандидатов. Записи с реальным
/// контентом, закрепом или ручной иконкой не трогаются никогда.
#[tauri::command(async)]
#[specta::specta]
pub fn prune_empty_daily_notes(params: DailyPruneParams) -> Result<DailyPruneResponse, GraphiteError> {
    let folder = daily_folder(params.folder)?;
    let root = current_root()?;
    let dir = root.join(&folder);
    if !dir.is_dir() {
        return Ok(DailyPruneResponse { items: Vec::new() });
    }
    let custom = daily_custom_template(&root);
    // Скан кандидатов — обычным обходом ФС, без мьютекса ядра: только файлы
    // `ГГГГ-ММ-ДД.md`, отсортированные по имени для детерминизма.
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".md") else { continue };
            if is_iso_date(stem) {
                candidates.push(stem.to_string());
            }
        }
    }
    candidates.sort();
    let mut empty: Vec<(String, String)> = Vec::new();
    for date in candidates {
        let rel = format!("{folder}/{date}.md");
        let Ok(raw) = fs::read_to_string(root.join(&rel)) else { continue };
        let Ok((fm, body)) = parser::parse_frontmatter(&raw) else { continue };
        // Страховки: чужой тип заметки, закреп или ручная иконка — признак
        // намерения пользователя, такие файлы не трогаем даже с шаблонным телом.
        if !matches!(fm.r#type, Some(vault_core::NoteType::Journal)) {
            continue;
        }
        if fm.extra.get("pinned").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if yml_str(&fm, "icon").is_some() || yml_str(&fm, "icon_color").is_some() {
            continue;
        }
        if !daily_body_is_empty(&body, &date, custom.as_deref()) {
            continue;
        }
        empty.push((date, rel));
    }
    if params.dry_run == Some(true) {
        let items = empty
            .into_iter()
            .map(|(date, rel)| DailyPruneItem {
                r#ref: NoteRef(format!("path:{rel}")),
                date,
                restore_token: None,
            })
            .collect();
        return Ok(DailyPruneResponse { items });
    }
    let mut items = Vec::new();
    for (date, rel) in empty {
        let mut result = note_delete(NoteDeleteParams {
            r#ref: NoteRef(format!("path:{rel}")),
        });
        if matches!(&result, Err(err) if err.code == GraphiteErrorCode::NotFound) {
            // Файл ещё не в индексе (фоновая индексация не догнала) — вносим
            // его точечно и пробуем ровно один раз ещё; иначе пропускаем,
            // не валя всю пачку.
            reindex_new(&rel);
            result = note_delete(NoteDeleteParams {
                r#ref: NoteRef(format!("path:{rel}")),
            });
        }
        let Ok(resp) = result else { continue };
        items.push(DailyPruneItem {
            r#ref: NoteRef(format!("path:{rel}")),
            date,
            restore_token: Some(resp.restore_token),
        });
    }
    Ok(DailyPruneResponse { items })
}

/// Записывает результат экспорта по выбранному пользователем абсолютному пути.
/// Файл живёт вне хранилища: ни индекс, ни журнал не затрагиваются.
#[tauri::command(async)]
#[specta::specta]
pub fn export_write(params: ExportWriteParams) -> Result<(), GraphiteError> {
    let dest = PathBuf::from(&params.dest_path);
    if !dest.is_absolute() {
        return Err(gerr(
            GraphiteErrorCode::Validation,
            "ожидается абсолютный путь назначения",
            Some("выбери файл через системный диалог сохранения"),
        ));
    }
    fs::write(&dest, params.contents.as_bytes())
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось записать файл: {e}"), None))
}

// --- Файловый менеджер «Проводник» -------------------------------------------
// Навигация и просмотр произвольных папок/файлов на диске, вне хранилища. Всё
// read-only: ни индекс, ни журнал, ни ядро не затрагиваются. Команды свои
// (`#[tauri::command]`), поэтому не требуют правок capabilities.

/// Жёсткий потолок чтения текста (даже если фронт запросит больше).
const FS_TEXT_HARD_CAP: u64 = 4 * 1024 * 1024;
/// Жёсткий потолок для base64-картинок.
const FS_BINARY_HARD_CAP: u64 = 25 * 1024 * 1024;

fn systime_to_ms(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Скрытый элемент: имя с точки либо (на Windows) атрибут hidden/system.
fn fs_is_hidden(name: &str, md: &fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        return md.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = md;
        false
    }
}

fn ext_lower(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn mime_from_ext(p: &Path) -> String {
    match ext_lower(p).as_deref().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Содержимое папки по абсолютному пути: все файлы и подпапки. Битые записи
/// (недоступная метадата) пропускаем; недоступную саму папку возвращаем ошибкой.
#[tauri::command]
#[specta::specta]
pub fn fs_list_dir(path: String, show_hidden: bool) -> Result<FsDirListing, GraphiteError> {
    let dir = PathBuf::from(&path);
    let meta = fs::metadata(&dir)
        .map_err(|e| gerr(GraphiteErrorCode::NotFound, format!("папка недоступна: {e}"), None))?;
    if !meta.is_dir() {
        return Err(gerr(GraphiteErrorCode::Validation, "путь не является папкой", None));
    }
    let read = fs::read_dir(&dir)
        .map_err(|e| gerr(GraphiteErrorCode::Forbidden, format!("нет доступа к папке: {e}"), None))?;
    let mut entries: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(md) = entry.metadata() else { continue };
        let is_dir = md.is_dir();
        let hidden = fs_is_hidden(&name, &md);
        if hidden && !show_hidden {
            continue;
        }
        let entry_path = entry.path();
        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { None } else { Some(md.len()) },
            modified_ms: md.modified().ok().and_then(systime_to_ms),
            ext: if is_dir { None } else { ext_lower(&entry_path) },
            hidden,
        });
    }
    let parent = dir
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| !p.is_empty());
    Ok(FsDirListing {
        path: dir.to_string_lossy().to_string(),
        parent,
        entries,
    })
}

/// Текст файла до `max_bytes` (кап `FS_TEXT_HARD_CAP`). Бинарь определяем по
/// нулевому байту либо невалидному UTF-8; хвост-обрезок многобайтного символа на
/// границе среза бинарём не считаем.
#[tauri::command]
#[specta::specta]
pub fn fs_read_text(path: String, max_bytes: u64) -> Result<FsTextFile, GraphiteError> {
    use std::io::Read;
    let p = PathBuf::from(&path);
    let md = fs::metadata(&p)
        .map_err(|e| gerr(GraphiteErrorCode::NotFound, format!("файл недоступен: {e}"), None))?;
    if md.is_dir() {
        return Err(gerr(GraphiteErrorCode::Validation, "это папка, а не файл", None));
    }
    let cap = max_bytes.min(FS_TEXT_HARD_CAP);
    let mut file = fs::File::open(&p)
        .map_err(|e| gerr(GraphiteErrorCode::Forbidden, format!("нет доступа: {e}"), None))?;
    let mut buf: Vec<u8> = Vec::new();
    file.take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("ошибка чтения: {e}"), None))?;
    let truncated = md.len() > buf.len() as u64;
    if buf.iter().take(8192).any(|&b| b == 0) {
        return Ok(FsTextFile { content: String::new(), truncated, is_binary: true });
    }
    match std::str::from_utf8(&buf) {
        Ok(s) => Ok(FsTextFile { content: s.to_string(), truncated, is_binary: false }),
        Err(err) => {
            let valid = err.valid_up_to();
            // Обрыв на границе среза (≤3 хвостовых байта неполного символа) —
            // это просто усечение, а не бинарь: показываем валидный префикс.
            if valid > 0 && valid + 3 >= buf.len() {
                let content = std::str::from_utf8(&buf[..valid]).unwrap_or("").to_string();
                Ok(FsTextFile { content, truncated: true, is_binary: false })
            } else {
                Ok(FsTextFile { content: String::new(), truncated, is_binary: true })
            }
        }
    }
}

/// Файл в base64 для показа картинки через data-URL. Крупнее лимита — ошибка
/// `LIMIT` (фронт предложит открыть в системе), частичную картинку не отдаём.
#[tauri::command]
#[specta::specta]
pub fn fs_read_base64(path: String, max_bytes: u64) -> Result<FsBinaryFile, GraphiteError> {
    let p = PathBuf::from(&path);
    let md = fs::metadata(&p)
        .map_err(|e| gerr(GraphiteErrorCode::NotFound, format!("файл недоступен: {e}"), None))?;
    if md.is_dir() {
        return Err(gerr(GraphiteErrorCode::Validation, "это папка, а не файл", None));
    }
    let cap = max_bytes.min(FS_BINARY_HARD_CAP);
    if md.len() > cap {
        return Err(gerr(
            GraphiteErrorCode::Limit,
            format!("файл слишком большой для предпросмотра ({} КБ)", md.len() / 1024),
            Some("открой в системном приложении"),
        ));
    }
    let bytes = fs::read(&p)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("ошибка чтения: {e}"), None))?;
    Ok(FsBinaryFile {
        base64: BASE64.encode(&bytes),
        mime: mime_from_ext(&p),
        truncated: false,
    })
}

/// «Показать в Проводнике» для произвольного абсолютного пути (обобщение
/// `reveal_in_explorer`): открывает системный проводник с выделением элемента.
#[tauri::command]
#[specta::specta]
pub fn fs_reveal_path(path: String) -> Result<(), GraphiteError> {
    let abs = PathBuf::from(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", abs.display()))
            .spawn()
            .map_err(|e| {
                gerr(GraphiteErrorCode::Unavailable, format!("не удалось открыть проводник: {e}"), None)
            })?;
    }
    #[cfg(not(windows))]
    {
        let _ = abs;
    }
    Ok(())
}

/// Открыть файл/папку системным приложением по умолчанию (запасной путь для
/// непревьюабельных файлов: PDF, exe и т.п.).
#[tauri::command]
#[specta::specta]
pub fn fs_open_path(path: String) -> Result<(), GraphiteError> {
    let abs = PathBuf::from(&path);
    if !abs.exists() {
        return Err(gerr(GraphiteErrorCode::NotFound, "путь не найден", None));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .raw_arg(format!("/C start \"\" \"{}\"", abs.display()))
            .spawn()
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось открыть: {e}"), None))?;
    }
    #[cfg(not(windows))]
    {
        let _ = abs;
    }
    Ok(())
}

/// Корни для меню «новая панель»: доступные диски + домашняя/рабочий стол/
/// загрузки/документы (учитывая перенаправление в OneDrive).
#[tauri::command]
#[specta::specta]
pub fn fs_roots() -> Result<Vec<FsRoot>, GraphiteError> {
    let mut roots: Vec<FsRoot> = Vec::new();
    #[cfg(windows)]
    {
        // C..=Z: буквы A/B исторически за флоппи — их проба может дёргать привод.
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(FsRoot {
                    name: format!("Локальный диск ({}:)", letter as char),
                    path: drive,
                    kind: "drive".into(),
                });
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let home_path = PathBuf::from(&home);
            if home_path.is_dir() {
                roots.push(FsRoot {
                    name: "Домашняя папка".into(),
                    path: home_path.to_string_lossy().to_string(),
                    kind: "home".into(),
                });
            }
            // Рабочий стол — обычный или перенаправленный в OneDrive.
            for sub in ["Desktop", "OneDrive/Desktop", "OneDrive/Рабочий стол"] {
                let p = home_path.join(sub);
                if p.is_dir() {
                    roots.push(FsRoot {
                        name: "Рабочий стол".into(),
                        path: p.to_string_lossy().to_string(),
                        kind: "folder".into(),
                    });
                    break;
                }
            }
            for (label, sub) in [("Загрузки", "Downloads"), ("Документы", "Documents")] {
                let p = home_path.join(sub);
                if p.is_dir() {
                    roots.push(FsRoot {
                        name: label.into(),
                        path: p.to_string_lossy().to_string(),
                        kind: "folder".into(),
                    });
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            roots.push(FsRoot { name: "Домашняя папка".into(), path: home, kind: "home".into() });
        }
    }
    Ok(roots)
}
