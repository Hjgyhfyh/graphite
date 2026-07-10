//! Оркестратор одного цикла синхронизации: склейка client + diff + диск. Доступ
//! к диску абстрагирован трейтом [`FileStore`], чтобы движок был тестируемым и не
//! зависел от vault_core. Применение планов вынесено в чистые функции
//! ([`apply_pull_step`], [`apply_push_step`]) над `FileStore` — их и тестируем;
//! [`run_cycle`] остаётся тонкой склейкой поверх реального [`SyncClient`].

use std::collections::BTreeMap;

use crate::client::{SyncClient, IF_HASH_ABSENT};
use crate::diff::{self, PlanStep};
use crate::error::{SyncError, SyncResult};
use crate::index::{FileState, SyncIndex};

/// Доступ к файлам реплики. Приложение реализует поверх своего писателя
/// (атомарная запись, эхо-гашение watcher-а), тесты — поверх карты в памяти.
pub trait FileStore {
    /// Прочитать файл (None — если его нет).
    fn read(&self, rel: &str) -> SyncResult<Option<Vec<u8>>>;
    /// Атомарно записать файл (создав каталоги).
    fn write(&self, rel: &str, bytes: &[u8]) -> SyncResult<()>;
    /// Удалить файл (отсутствие — не ошибка).
    fn remove(&self, rel: &str) -> SyncResult<()>;
    /// Снять текущее состояние синхронизируемых файлов.
    fn scan(&self) -> SyncResult<BTreeMap<String, FileState>>;
}

/// Итог одного цикла: новый rev и счётчики применённого.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub new_rev: i64,
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
    /// Пути, изменённые локально в этом цикле (для реиндекса и note_changed).
    pub changed_paths: Vec<String>,
}

impl SyncOutcome {
    fn note(&mut self, path: &str) {
        if !self.changed_paths.iter().any(|p| p == path) {
            self.changed_paths.push(path.to_string());
        }
    }
}

/// Применяет один шаг «притягивания» удалённого состояния к диску через store.
/// Для конфликта: локальную версию переносит в `conflict_path`, затем при
/// непустом `remote_hash` кладёт в канон удалённую версию (её байты движок
/// передаёт заранее через `fetch`), иначе (сервер удалил) — канон удаляет.
/// Возвращает пути, затронутые на диске.
pub fn apply_pull_step(
    store: &dyn FileStore,
    step: &PlanStep,
    fetch: &mut dyn FnMut(&str) -> SyncResult<Option<Vec<u8>>>,
    outcome: &mut SyncOutcome,
) -> SyncResult<()> {
    match step {
        PlanStep::PullWrite { path, remote_hash } => {
            let bytes = fetch(path)?.ok_or_else(|| {
                SyncError::Protocol(format!("сервер не отдал файл {path} ({remote_hash})"))
            })?;
            store.write(path, &bytes)?;
            outcome.pulled += 1;
            outcome.note(path);
        }
        PlanStep::PullDelete { path } => {
            store.remove(path)?;
            outcome.pulled += 1;
            outcome.note(path);
        }
        PlanStep::ConflictLocalRename {
            path,
            conflict_path,
            remote_hash,
        } => {
            // Локальную правку сохраняем под именем конфликта.
            if let Some(local_bytes) = store.read(path)? {
                store.write(conflict_path, &local_bytes)?;
                outcome.note(conflict_path);
            }
            if remote_hash.is_empty() {
                // Сервер удалил канон — убираем и локально (правка спасена рядом).
                store.remove(path)?;
            } else {
                let bytes = fetch(path)?.ok_or_else(|| {
                    SyncError::Protocol(format!("сервер не отдал канон {path}"))
                })?;
                store.write(path, &bytes)?;
            }
            outcome.note(path);
            outcome.conflicts += 1;
        }
        // Push-шаги здесь не обрабатываются.
        _ => {}
    }
    Ok(())
}

/// Применяет один push-шаг: заливает/удаляет файл на сервере с `X-If-Hash`. На
/// 409 деградирует в конфликт по той же схеме — перечитывает серверную версию,
/// локаль кладёт в conflict_path и заливает, канон принимает удалённый. Обновляет
/// счётчики и `max_rev`.
pub fn apply_push_step(
    client: &SyncClient,
    store: &dyn FileStore,
    step: &PlanStep,
    hostname: &str,
    max_rev: &mut i64,
    outcome: &mut SyncOutcome,
) -> SyncResult<()> {
    match step {
        PlanStep::PushPut { path, base_hash } => {
            let Some(bytes) = store.read(path)? else {
                // Файл исчез между сканом и пушем — пропускаем молча.
                return Ok(());
            };
            let if_hash = base_hash.as_deref().unwrap_or(IF_HASH_ABSENT);
            match client.put_file(path, &bytes, Some(if_hash)) {
                Ok((rev, _hash)) => {
                    *max_rev = (*max_rev).max(rev);
                    outcome.pushed += 1;
                }
                Err(SyncError::Conflict { .. }) => {
                    resolve_push_conflict(client, store, path, hostname, max_rev, outcome)?;
                }
                Err(other) => return Err(other),
            }
        }
        PlanStep::PushDelete { path, base_hash } => {
            let if_hash = base_hash.as_deref().unwrap_or(IF_HASH_ABSENT);
            match client.delete_file(path, Some(if_hash)) {
                Ok(rev) => {
                    *max_rev = (*max_rev).max(rev);
                    outcome.pushed += 1;
                }
                Err(SyncError::Conflict { .. }) => {
                    // Кто-то воскресил/изменил файл на сервере, пока мы удаляли:
                    // забираем серверную версию в канон, локального удаления не
                    // навязываем (файл вернулся).
                    if let Some(bytes) = client.get_file(path)? {
                        store.write(path, &bytes)?;
                        outcome.note(path);
                    }
                    outcome.conflicts += 1;
                }
                Err(other) => return Err(other),
            }
        }
        _ => {}
    }
    Ok(())
}

/// Разрешение 409 при пуше файла: локаль → conflict_path (+залить absent),
/// серверная версия → канон локально.
fn resolve_push_conflict(
    client: &SyncClient,
    store: &dyn FileStore,
    path: &str,
    hostname: &str,
    max_rev: &mut i64,
    outcome: &mut SyncOutcome,
) -> SyncResult<()> {
    let now = chrono::Local::now();
    let conflict = diff::conflict_name(path, hostname, now);
    if let Some(local_bytes) = store.read(path)? {
        // Копию локальной правки заливаем под именем конфликта (её на сервере нет).
        store.write(&conflict, &local_bytes)?;
        outcome.note(&conflict);
        if let Ok((rev, _)) = client.put_file(&conflict, &local_bytes, Some(IF_HASH_ABSENT)) {
            *max_rev = (*max_rev).max(rev);
        }
    }
    // Канон принимает серверную версию.
    if let Some(server_bytes) = client.get_file(path)? {
        store.write(path, &server_bytes)?;
        outcome.note(path);
    }
    outcome.conflicts += 1;
    Ok(())
}

/// Один цикл синхронизации ровно по спеке:
/// (1) `changes(since=index.last_rev)`; (2) применить удалённые (pull + конфликты);
/// (3) пересканировать локаль и запушить локальные изменения (409 → конфликт);
/// (4) обновить индекс (перескан финального состояния) и `last_rev = max(rev)`.
pub fn run_cycle(
    client: &SyncClient,
    store: &dyn FileStore,
    index: &mut SyncIndex,
    hostname: &str,
) -> SyncResult<SyncOutcome> {
    let mut outcome = SyncOutcome::default();
    let now = chrono::Local::now();

    // (1) удалённые изменения с прошлого rev.
    let changes = client.changes(index.last_rev)?;
    let mut max_rev = index.last_rev.max(changes.rev);

    // (2) применить удалённые.
    let local = store.scan()?;
    let pull_plan = diff::plan_apply_remote(index, &local, &changes.files, hostname, now);
    for step in &pull_plan.steps {
        let mut fetch = |p: &str| -> SyncResult<Option<Vec<u8>>> { client.get_file(p) };
        apply_pull_step(store, step, &mut fetch, &mut outcome)?;
    }

    // Свернуть применённые удалённые изменения в базу (index.files): канонический
    // путь после pull равен серверному состоянию, поэтому его нельзя считать
    // «локально изменённым» и пушить обратно (иначе спорный 409 на следующем
    // шаге). Файл-конфликт (новое имя) в базу НЕ вносим — его как раз надо залить.
    let after_pull = store.scan()?;
    for step in &pull_plan.steps {
        match step {
            PlanStep::PullWrite { path, .. } | PlanStep::ConflictLocalRename { path, .. } => {
                match after_pull.get(path) {
                    Some(state) => {
                        index.files.insert(path.clone(), state.clone());
                    }
                    None => {
                        index.files.remove(path);
                    }
                }
            }
            PlanStep::PullDelete { path } => {
                index.files.remove(path);
            }
            _ => {}
        }
    }

    // (3) собрать и применить локальные изменения.
    let local = after_pull;
    let push_steps = diff::plan_push_local(index, &local);
    for step in &push_steps {
        apply_push_step(client, store, step, hostname, &mut max_rev, &mut outcome)?;
    }

    // (4) зафиксировать финальное состояние.
    let final_scan = store.scan()?;
    index.files = final_scan;
    index.last_rev = max_rev;
    outcome.new_rev = max_rev;
    Ok(outcome)
}

/// Первичный pull для join: полный манифест → скачать всё → записать индекс.
/// `ensure_vault` вызывает приложение до этого (нужен rev/vaultId для конфига).
pub fn initial_pull(
    client: &SyncClient,
    store: &dyn FileStore,
    index: &mut SyncIndex,
) -> SyncResult<SyncOutcome> {
    let mut outcome = SyncOutcome::default();
    let manifest = client.manifest()?;
    for entry in &manifest.files {
        if entry.deleted {
            continue;
        }
        if let Some(bytes) = client.get_file(&entry.path)? {
            store.write(&entry.path, &bytes)?;
            outcome.pulled += 1;
            outcome.note(&entry.path);
        }
    }
    index.files = store.scan()?;
    index.last_rev = manifest.rev;
    outcome.new_rev = manifest.rev;
    Ok(outcome)
}

/// Первичный push для create: залить всё локальное (absent) → записать индекс.
pub fn initial_push(
    client: &SyncClient,
    store: &dyn FileStore,
    index: &mut SyncIndex,
) -> SyncResult<SyncOutcome> {
    let mut outcome = SyncOutcome::default();
    let local = store.scan()?;
    let mut max_rev = index.last_rev;
    for (path, state) in &local {
        if state.size > diff::MAX_FILE_BYTES {
            continue;
        }
        let Some(bytes) = store.read(path)? else {
            continue;
        };
        match client.put_file(path, &bytes, Some(IF_HASH_ABSENT)) {
            Ok((rev, _)) => {
                max_rev = max_rev.max(rev);
                outcome.pushed += 1;
            }
            // Файл уже есть на сервере (повторный create в ту же реплику) — берём
            // серверный rev дальше, не считаем ошибкой.
            Err(SyncError::Conflict { .. }) => {}
            Err(other) => return Err(other),
        }
    }
    index.files = store.scan()?;
    index.last_rev = max_rev;
    outcome.new_rev = max_rev;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::sha256_hex;
    use std::cell::RefCell;

    /// Файловое хранилище в памяти для тестов чистых применителей планов.
    struct MemStore {
        files: RefCell<BTreeMap<String, Vec<u8>>>,
    }

    impl MemStore {
        fn new(pairs: &[(&str, &[u8])]) -> Self {
            let map = pairs
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_vec()))
                .collect();
            Self {
                files: RefCell::new(map),
            }
        }
    }

    impl FileStore for MemStore {
        fn read(&self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
            Ok(self.files.borrow().get(rel).cloned())
        }
        fn write(&self, rel: &str, bytes: &[u8]) -> SyncResult<()> {
            self.files.borrow_mut().insert(rel.to_string(), bytes.to_vec());
            Ok(())
        }
        fn remove(&self, rel: &str) -> SyncResult<()> {
            self.files.borrow_mut().remove(rel);
            Ok(())
        }
        fn scan(&self) -> SyncResult<BTreeMap<String, FileState>> {
            Ok(self
                .files
                .borrow()
                .iter()
                .map(|(p, c)| {
                    (
                        p.clone(),
                        FileState {
                            hash: sha256_hex(c),
                            size: c.len() as u64,
                            mtime_utc: String::new(),
                        },
                    )
                })
                .collect())
        }
    }

    #[test]
    fn pull_write_fetches_and_writes() {
        let store = MemStore::new(&[]);
        let step = PlanStep::PullWrite {
            path: "a.md".to_string(),
            remote_hash: sha256_hex(b"remote"),
        };
        let mut outcome = SyncOutcome::default();
        let mut fetch = |_p: &str| -> SyncResult<Option<Vec<u8>>> { Ok(Some(b"remote".to_vec())) };
        apply_pull_step(&store, &step, &mut fetch, &mut outcome).unwrap();
        assert_eq!(store.read("a.md").unwrap().unwrap(), b"remote");
        assert_eq!(outcome.pulled, 1);
        assert_eq!(outcome.changed_paths, vec!["a.md".to_string()]);
    }

    #[test]
    fn pull_delete_removes() {
        let store = MemStore::new(&[("a.md", b"x")]);
        let step = PlanStep::PullDelete {
            path: "a.md".to_string(),
        };
        let mut outcome = SyncOutcome::default();
        let mut fetch = |_p: &str| -> SyncResult<Option<Vec<u8>>> { Ok(None) };
        apply_pull_step(&store, &step, &mut fetch, &mut outcome).unwrap();
        assert!(store.read("a.md").unwrap().is_none());
        assert_eq!(outcome.pulled, 1);
    }

    #[test]
    fn conflict_branch_creates_conflict_file_and_writes_canon() {
        // Локальная правка «local»; сервер прислал «remote». Ветка конфликта
        // должна создать файл-конфликт с локальным содержимым и положить канон.
        let store = MemStore::new(&[("note.md", b"local")]);
        let step = PlanStep::ConflictLocalRename {
            path: "note.md".to_string(),
            conflict_path: "note (конфликт PC 2026-07-10 14-30).md".to_string(),
            remote_hash: sha256_hex(b"remote"),
        };
        let mut outcome = SyncOutcome::default();
        let mut fetch = |_p: &str| -> SyncResult<Option<Vec<u8>>> { Ok(Some(b"remote".to_vec())) };
        apply_pull_step(&store, &step, &mut fetch, &mut outcome).unwrap();
        // Канон = серверная версия.
        assert_eq!(store.read("note.md").unwrap().unwrap(), b"remote");
        // Конфликт-файл = локальная версия.
        assert_eq!(
            store
                .read("note (конфликт PC 2026-07-10 14-30).md")
                .unwrap()
                .unwrap(),
            b"local"
        );
        assert_eq!(outcome.conflicts, 1);
    }

    #[test]
    fn conflict_with_empty_remote_deletes_canon_keeps_local_copy() {
        // Сервер удалил файл (remote_hash пуст): канон убираем, копию сохраняем.
        let store = MemStore::new(&[("note.md", b"local")]);
        let step = PlanStep::ConflictLocalRename {
            path: "note.md".to_string(),
            conflict_path: "note (конфликт H 2026-07-10 14-30).md".to_string(),
            remote_hash: String::new(),
        };
        let mut outcome = SyncOutcome::default();
        let mut fetch = |_p: &str| -> SyncResult<Option<Vec<u8>>> { Ok(None) };
        apply_pull_step(&store, &step, &mut fetch, &mut outcome).unwrap();
        assert!(store.read("note.md").unwrap().is_none());
        assert_eq!(
            store
                .read("note (конфликт H 2026-07-10 14-30).md")
                .unwrap()
                .unwrap(),
            b"local"
        );
        assert_eq!(outcome.conflicts, 1);
    }
}
