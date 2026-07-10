//! Синхронизация хранилищ через сервер протокола v1 (тонкие обёртки над
//! `sync_core`, по образцу `gitsync.rs`). Вся логика — в крейте `sync-core`;
//! здесь только: реализация `FileStore` поверх `vault_core::writer`, tauri-
//! команды, процессное состояние активной реплики, маппинг ошибок и фоновый
//! цикл. Код доступа хранится ТОЛЬКО в `app_config_dir/sync.json`; в папке
//! реплики секрета нет.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Emitter;

use crate::dto::*;

/// Доменная ошибка sync-модуля: код + сообщение (без hint/data).
fn gerr(code: GraphiteErrorCode, msg: impl Into<String>) -> GraphiteError {
    GraphiteError {
        code,
        message: msg.into(),
        hint: None,
        data: None,
    }
}

/// Маппинг ошибки `sync_core` в доменную ошибку приложения.
fn sync_err(e: sync_core::SyncError) -> GraphiteError {
    use sync_core::SyncError;
    match e {
        SyncError::Io(err) => gerr(GraphiteErrorCode::Unavailable, format!("файловая ошибка: {err}")),
        SyncError::Http(msg) => gerr(GraphiteErrorCode::Unavailable, format!("сеть: {msg}")),
        SyncError::Protocol(msg) => gerr(GraphiteErrorCode::Unavailable, format!("протокол: {msg}")),
        SyncError::BadCode => gerr(GraphiteErrorCode::Validation, "код доступа неверного формата"),
        SyncError::Conflict { .. } => gerr(GraphiteErrorCode::Conflict, "конфликт синхронизации"),
        SyncError::Limit(msg) => gerr(GraphiteErrorCode::Limit, msg),
        SyncError::Validation(msg) => gerr(GraphiteErrorCode::Validation, msg),
    }
}

/// Имя устройства для имени файла-конфликта. На Windows — `COMPUTERNAME`.
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "graphite".to_string())
}

/// Путь к конфигу sync в каталоге приложения (`app_config_dir/sync.json`).
fn sync_config_path() -> Result<PathBuf, GraphiteError> {
    let dir = crate::runtime::config_dir()
        .ok_or_else(|| gerr(GraphiteErrorCode::Unavailable, "каталог конфигурации недоступен"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать каталог конфигурации: {e}")))?;
    Ok(dir.join("sync.json"))
}

/// Путь к индексу sync в папке реплики (`.graphite/sync/index.json`).
fn index_path(root: &Path) -> PathBuf {
    root.join(".graphite").join("sync").join("index.json")
}

/// Реализация `sync_core::engine::FileStore` поверх писателя vault: запись
/// атомарна и эхо-гасится watcher-ом (лишних note_changed нет), поэтому обновление
/// открытых вкладок и индекса делает сам sync-модуль после цикла.
struct VaultStore {
    root: PathBuf,
}

impl sync_core::engine::FileStore for VaultStore {
    fn read(&self, rel: &str) -> sync_core::SyncResult<Option<Vec<u8>>> {
        let abs = vault_core::writer::vault_abs_path(&self.root, rel)
            .map_err(|e| sync_core::SyncError::Validation(format!("{e}")))?;
        match std::fs::read(&abs) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(sync_core::SyncError::Io(err)),
        }
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> sync_core::SyncResult<()> {
        vault_core::writer::write_atomic(&self.root, rel, bytes)
            .map(|_| ())
            .map_err(|e| sync_core::SyncError::Validation(format!("{e}")))
    }

    fn remove(&self, rel: &str) -> sync_core::SyncResult<()> {
        let abs = vault_core::writer::vault_abs_path(&self.root, rel)
            .map_err(|e| sync_core::SyncError::Validation(format!("{e}")))?;
        match std::fs::remove_file(&abs) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(sync_core::SyncError::Io(err)),
        }
    }

    fn scan(&self) -> sync_core::SyncResult<std::collections::BTreeMap<String, sync_core::FileState>> {
        sync_core::index::scan_local(&self.root)
    }
}

/// Процессное состояние активной sync-реплики (одна — «пока Sync-хранилище
/// активно»). Заполняется при монтировании vault, если его корень есть в конфиге.
struct SyncRuntime {
    code: String,
    base: String,
    root: PathBuf,
    index: sync_core::SyncIndex,
    status: &'static str,
    last_sync_at: Option<String>,
    last_error: Option<String>,
    last_run: Option<Instant>,
}

static SYNC: OnceLock<Mutex<Option<SyncRuntime>>> = OnceLock::new();

fn sync_cell() -> &'static Mutex<Option<SyncRuntime>> {
    SYNC.get_or_init(|| Mutex::new(None))
}

fn lock_sync() -> std::sync::MutexGuard<'static, Option<SyncRuntime>> {
    match sync_cell().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    }
}

/// Собирает DTO статуса из текущего состояния (или «неактивно», если реплики нет).
fn status_dto(rt: Option<&SyncRuntime>) -> SyncStatusDto {
    match rt {
        Some(rt) => SyncStatusDto {
            state: rt.status.to_string(),
            last_sync_at: rt.last_sync_at.clone(),
            last_error: rt.last_error.clone(),
            active: true,
            root: Some(rt.root.to_string_lossy().to_string()),
        },
        None => SyncStatusDto {
            state: "idle".to_string(),
            last_sync_at: None,
            last_error: None,
            active: false,
            root: None,
        },
    }
}

/// Эмитит статус на фронт (событие `sync_status`), как emit_index_progress/mcp.
fn emit_status(dto: &SyncStatusDto) {
    if let Some(app) = crate::runtime::app_handle() {
        let _ = app.emit(
            "sync_status",
            crate::events::SyncStatusEvent {
                state: dto.state.clone(),
                last_sync_at: dto.last_sync_at.clone(),
                last_error: dto.last_error.clone(),
                active: dto.active,
            },
        );
    }
}

/// Рассылает `note_changed` (actor=External) и реиндексирует затронутые пути
/// после pull: эхо-подавление writer-а лишает открытые вкладки события от
/// watcher-а, а индекс vault-core не узнаёт о прямой записи. Реиндекс — под
/// core-локом, коротко и вне sync-лока (без вложенности, как watcher в lib.rs).
fn propagate_changes(root: &Path, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    {
        let mut guard = crate::commands::lock_core();
        if let Some(state) = guard.as_mut() {
            if state.root.as_path() == root {
                let _ = state.index.reindex_paths(root, paths);
            }
        }
    }
    let Some(app) = crate::runtime::app_handle() else {
        return;
    };
    for rel in paths {
        let abs = match vault_core::writer::vault_abs_path(root, rel) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Удалённые pull-ом файлы пропускаем: перечитывать нечего, вкладку
        // инициатор закрыл (как emit_paths_changed в commands.rs).
        let Ok(bytes) = std::fs::read(&abs) else {
            continue;
        };
        let rev = vault_core::writer::compute_rev(&bytes).0;
        let _ = app.emit(
            "note_changed",
            crate::events::NoteChangedEvent {
                r#ref: NoteRef(format!("path:{rel}")),
                rev: Rev(rev),
                actor: Actor::External,
                kind: Some(crate::events::NoteChangeKind::Modified),
                from: None,
            },
        );
    }
}

/// Копирует синхронизируемые файлы текущего открытого vault в новую реплику
/// (без `.graphite`/`.trash`/служебного). Для sync_create(copy_from_current).
fn copy_vault_contents(from_root: &Path, to_root: &Path) -> Result<(), GraphiteError> {
    let files = sync_core::index::scan_local(from_root).map_err(sync_err)?;
    for rel in files.keys() {
        let src = vault_core::writer::vault_abs_path(from_root, rel)
            .map_err(|e| gerr(GraphiteErrorCode::Validation, format!("{e}")))?;
        let Ok(bytes) = std::fs::read(&src) else { continue };
        vault_core::writer::write_atomic(to_root, rel, &bytes)
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("копирование {rel}: {e}")))?;
    }
    Ok(())
}

/// Строит клиента для реплики (валидирует код).
fn client_for(base: &str, code: &str) -> Result<sync_core::SyncClient, GraphiteError> {
    sync_core::SyncClient::new(base, code).map_err(sync_err)
}

/// Сохраняет запись реплики в конфиг приложения (создаёт/заменяет).
fn persist_config(vault_id: &str, code: &str, root: &Path, base: &str, last_rev: i64) -> Result<(), GraphiteError> {
    let path = sync_config_path()?;
    let mut cfg = sync_core::SyncConfig::load(&path);
    cfg.upsert(sync_core::SyncVaultConfig {
        vault_id: vault_id.to_string(),
        code: code.to_string(),
        root: root.to_string_lossy().to_string(),
        base_url: base.to_string(),
        last_rev,
    });
    cfg.save_atomic(&path).map_err(sync_err)
}

/// Обновляет `last_rev` записи реплики в конфиге (после успешного цикла).
fn update_config_rev(root: &Path, last_rev: i64) {
    let Ok(path) = sync_config_path() else { return };
    let mut cfg = sync_core::SyncConfig::load(&path);
    if let Some(existing) = cfg.find_by_root(&root.to_string_lossy()).cloned() {
        cfg.upsert(sync_core::SyncVaultConfig { last_rev, ..existing });
        let _ = cfg.save_atomic(&path);
    }
}

/// Активирует реплику в процессном состоянии (SYNC) по её корню, если она есть в
/// конфиге. Вызывается из mount_vault после монтирования vault.
pub fn activate_for_root(root: &Path) {
    let Ok(path) = sync_config_path() else { return };
    let cfg = sync_core::SyncConfig::load(&path);
    let Some(entry) = cfg.find_by_root(&root.to_string_lossy()) else {
        // Не sync-реплика — снять активную, если это был другой корень.
        let mut guard = lock_sync();
        if guard.as_ref().map(|rt| rt.root.as_path() != root).unwrap_or(false) {
            *guard = None;
        }
        return;
    };
    let index = sync_core::SyncIndex::load(&index_path(root));
    let rt = SyncRuntime {
        code: entry.code.clone(),
        base: entry.base_url.clone(),
        root: root.to_path_buf(),
        index,
        status: "idle",
        last_sync_at: None,
        last_error: None,
        last_run: None,
    };
    *lock_sync() = Some(rt);
}

/// Прогоняет один цикл синхронизации активной реплики. HTTP+файлы идут вне
/// core-лока; реиндекс/note_changed — после, коротким локом (см. propagate_changes).
/// Возвращает актуальный DTO статуса. Ошибку сети/сервера фиксирует в статусе, а
/// не роняет вызывающего (фоновый цикл продолжит попытки).
fn run_active_cycle() -> SyncStatusDto {
    // Снимок параметров реплики под локом (быстро), затем работаем без него.
    let (code, base, root, mut index) = {
        let guard = lock_sync();
        match guard.as_ref() {
            Some(rt) => (rt.code.clone(), rt.base.clone(), rt.root.clone(), rt.index.clone()),
            None => return status_dto(None),
        }
    };
    // Пометить «идёт синхронизация».
    {
        let mut guard = lock_sync();
        if let Some(rt) = guard.as_mut() {
            rt.status = "syncing";
            rt.last_run = Some(Instant::now());
        }
    }
    emit_status(&SyncStatusDto {
        state: "syncing".to_string(),
        last_sync_at: None,
        last_error: None,
        active: true,
        root: Some(root.to_string_lossy().to_string()),
    });

    let store = VaultStore { root: root.clone() };
    let host = hostname();
    let result = client_for(&base, &code)
        .and_then(|client| sync_core::engine::run_cycle(&client, &store, &mut index, &host).map_err(sync_err));

    match result {
        Ok(outcome) => {
            // Обновить открытые вкладки/индекс по изменённым путям.
            propagate_changes(&root, &outcome.changed_paths);
            // Записать новый индекс реплики.
            let _ = index.save_atomic(&index_path(&root));
            update_config_rev(&root, outcome.new_rev);
            let now = vault_core::writer::now_iso_utc();
            let mut guard = lock_sync();
            if let Some(rt) = guard.as_mut() {
                rt.index = index;
                rt.status = "idle";
                rt.last_sync_at = Some(now);
                rt.last_error = None;
            }
            let dto = status_dto(guard.as_ref());
            drop(guard);
            emit_status(&dto);
            dto
        }
        Err(err) => {
            let mut guard = lock_sync();
            if let Some(rt) = guard.as_mut() {
                rt.status = "error";
                rt.last_error = Some(err.message.clone());
            }
            let dto = status_dto(guard.as_ref());
            drop(guard);
            emit_status(&dto);
            dto
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn sync_create(dest_path: String, copy_from_current: bool) -> Result<SyncCreateResult, GraphiteError> {
    let dest = PathBuf::from(dest_path.trim());
    if dest.as_os_str().is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "не выбран путь реплики"));
    }
    // Корень текущего открытого vault (owned-снимок; core-лок сразу отпускаем,
    // чтобы не держать его во время копирования).
    let current_root = crate::commands::lock_core().as_ref().map(|s| s.root.clone());
    if let Some(current) = &current_root {
        if sync_core::config::root_key(&dest.to_string_lossy())
            == sync_core::config::root_key(&current.to_string_lossy())
        {
            return Err(gerr(GraphiteErrorCode::Validation, "нельзя создать реплику поверх текущего хранилища"));
        }
        if copy_from_current {
            std::fs::create_dir_all(&dest)
                .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать папку реплики: {e}")))?;
            copy_vault_contents(current, &dest)?;
        }
    }
    std::fs::create_dir_all(&dest)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать папку реплики: {e}")))?;

    let code = sync_core::code::generate();
    let base = sync_core::DEFAULT_BASE_URL.to_string();
    let client = client_for(&base, &code)?;
    let (vault_id, _rev) = client.ensure_vault().map_err(sync_err)?;

    let store = VaultStore { root: dest.clone() };
    let mut index = sync_core::SyncIndex::default();
    let outcome = sync_core::engine::initial_push(&client, &store, &mut index).map_err(sync_err)?;
    let _ = index.save_atomic(&index_path(&dest));
    persist_config(&vault_id, &code, &dest, &base, outcome.new_rev)?;

    Ok(SyncCreateResult {
        code,
        path: dest.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn sync_join(dest_path: String, code: String) -> Result<SyncJoinResult, GraphiteError> {
    let dest = PathBuf::from(dest_path.trim());
    if dest.as_os_str().is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "не выбран путь реплики"));
    }
    let normalized = sync_core::code::normalize(&code)
        .ok_or_else(|| gerr(GraphiteErrorCode::Validation, "код доступа неверного формата"))?;
    std::fs::create_dir_all(&dest)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать папку реплики: {e}")))?;

    let base = sync_core::DEFAULT_BASE_URL.to_string();
    let client = client_for(&base, &normalized)?;
    let (vault_id, _rev) = client.ensure_vault().map_err(sync_err)?;

    let store = VaultStore { root: dest.clone() };
    let mut index = sync_core::SyncIndex::default();
    let outcome = sync_core::engine::initial_pull(&client, &store, &mut index).map_err(sync_err)?;
    let _ = index.save_atomic(&index_path(&dest));
    persist_config(&vault_id, &normalized, &dest, &base, outcome.new_rev)?;

    Ok(SyncJoinResult {
        path: dest.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn sync_status() -> Result<SyncStatusDto, GraphiteError> {
    let guard = lock_sync();
    Ok(status_dto(guard.as_ref()))
}

#[tauri::command]
#[specta::specta]
pub fn sync_now() -> Result<SyncStatusDto, GraphiteError> {
    if lock_sync().is_none() {
        return Err(gerr(GraphiteErrorCode::Unavailable, "нет активного sync-хранилища"));
    }
    Ok(run_active_cycle())
}

#[tauri::command]
#[specta::specta]
pub fn sync_detach() -> Result<(), GraphiteError> {
    // Определить корень активной реплики (или снять любую).
    let root = lock_sync().as_ref().map(|rt| rt.root.clone());
    let path = sync_config_path()?;
    let mut cfg = sync_core::SyncConfig::load(&path);
    if let Some(root) = &root {
        cfg.remove(&root.to_string_lossy());
        let _ = cfg.save_atomic(&path);
    }
    *lock_sync() = None;
    emit_status(&status_dto(None));
    Ok(())
}

/// Фоновый супервизор: раз в ~15с прогоняет активную реплику (интервал + внешние
/// триггеры фронта покрывают дебаунс сохранений). Отдельный std-thread, как
/// spawn_watcher_supervisor; core-лок берётся только внутри run_active_cycle
/// коротко и невложенно.
pub fn spawn_sync_supervisor(_app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("graphite-sync-supervisor".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let due = {
                    let guard = lock_sync();
                    match guard.as_ref() {
                        Some(rt) if rt.status != "syncing" => rt
                            .last_run
                            .map(|t| t.elapsed() >= Duration::from_secs(15))
                            .unwrap_or(true),
                        _ => false,
                    }
                };
                if due {
                    let _ = run_active_cycle();
                }
            }
        });
}
