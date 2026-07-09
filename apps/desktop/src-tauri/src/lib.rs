mod commands;
mod dto;
mod events;
mod gitsync;
mod rpc_handler;
mod runtime;
mod state;

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_specta::{collect_commands, collect_events, Builder};

use dto::{Actor, NoteRef, Rev};
use events::{McpSessionEvent, NoteChangeKind, NoteChangedEvent};

fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::vault_info,
            commands::vault_tree,
            commands::note_read,
            commands::search,
            commands::links_get,
            commands::activity_get,
            commands::context_briefing,
            commands::note_create,
            commands::note_edit,
            commands::note_move,
            commands::note_rename,
            commands::note_delete,
            commands::note_restore,
            commands::set_status,
            commands::link_add,
            commands::link_remove,
            commands::tasks_query,
            commands::task_check,
            commands::plan_create,
            commands::plan_update,
            commands::plan_progress,
            commands::distill_context,
            commands::distill_save,
            commands::buffer_save,
            commands::index_status,
            commands::reindex,
            commands::undo_op,
            commands::undo_session,
            commands::journal_list,
            commands::vault_open,
            commands::vault_create,
            commands::detect_claude_cli,
            commands::quick_capture,
            commands::set_icon,
            commands::note_pin,
            commands::bundle_compose,
            commands::bundle_create,
            commands::idea_to_tasks,
            commands::add_path_note,
            commands::save_attachment,
            commands::save_attachment_from_path,
            commands::open_note_window,
            commands::note_abs_path,
            commands::reveal_in_explorer,
            commands::graph_data,
            commands::tags_list,
            commands::ensure_daily_note,
            commands::peek_daily_note,
            commands::prune_empty_daily_notes,
            commands::export_write,
            gitsync::git_status,
            gitsync::git_init,
            gitsync::git_snapshot,
            gitsync::git_log,
            gitsync::git_commit_files,
            gitsync::git_diff,
            gitsync::git_restore_commit,
            gitsync::git_restore_file,
            gitsync::git_remote_set,
            gitsync::git_push,
            gitsync::git_pull,
        ])
        .events(collect_events![
            events::NoteChangedEvent,
            events::IndexProgressEvent,
            events::JournalOpEvent,
            events::McpSessionEvent,
            events::UiOpenNoteEvent,
            events::UiFlashNoteEvent,
        ])
}

/// Показывает и фокусирует главное окно (клик по трею, пункт «Открыть»).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Показывает окно быстрой записи по центру и сигналит фронту о показе, чтобы
/// он очистил поле и вернул фокус (хоткей, трей).
fn show_capture_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("capture-shown", ());
    } else {
        show_main_window(app);
    }
}

/// Трей-иконка с меню (SPEC §3.2). Возвращает пункт статуса MCP, чтобы обновить
/// его текст после попытки поднять канал ядра.
fn build_tray(app: &tauri::App) -> tauri::Result<MenuItem<tauri::Wry>> {
    let capture = MenuItem::with_id(app, "capture", "Быстрый захват", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Открыть Graphite", true, None::<&str>)?;
    let mcp = MenuItem::with_id(app, "mcp", "MCP: запуск…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append(&capture)?;
    menu.append(&open)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&mcp)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;

    let mut builder = TrayIconBuilder::with_id("graphite-tray")
        .tooltip("Graphite")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => show_capture_window(app),
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(mcp)
}

/// Глобальный хоткей Ctrl+Alt+Space → окно быстрой записи. Занятость хоткея —
/// не фатальна: логируем и живём дальше.
fn register_global_shortcut(app: &tauri::AppHandle) {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let result = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            show_capture_window(app);
        }
    });
    if let Err(err) = result {
        eprintln!("graphite: хоткей Ctrl+Alt+Space недоступен (занят другим приложением?): {err}");
    }
}

/// Кап на снапшот внешней правки: файлы крупнее в объектное хранилище не кладём
/// (журнал всё равно фиксирует событие), чтобы редкий гигантский .md не раздувал
/// историю.
const EXTERNAL_SNAPSHOT_CAP: u64 = 5 * 1024 * 1024;

/// Фиксирует внешнее изменение файла в истории (журнал + объектное хранилище),
/// повторяя путь ядра для собственных правок. `before`-хэш берётся из журнала
/// (последний известный `after` этого пути) — для правки/удаления/переноса это
/// исходное содержимое, чей снапшот уже лежит в хранилище, поэтому undo такой
/// операции восстанавливает файл; для нового файла `before` нет (первая фиксация
/// заводит цепочку). Всё best-effort: вернёт записанную операцию для рассылки в
/// ленту либо `None`, если журнал не удалось дописать — реиндекс это не срывает.
fn journal_external_event(
    root: &Path,
    event: &vault_core::watcher::WatchEvent,
) -> Option<vault_core::JournalOp> {
    use vault_core::watcher::WatchEventKind;

    let journal_dir = vault_core::vault::history::journal_dir(root);
    let path = event.path.clone();

    // `after`-хэш свежих байт файла на диске и решение, класть ли снапшот: только
    // для существующих файлов в пределах капа. Ошибку чтения трактуем как «файла
    // нет» — событие всё равно попадёт в журнал (для истории), просто без after.
    let read_after = |rel: &str| -> (Option<String>, bool) {
        let Ok(abs) = vault_core::writer::vault_abs_path(root, rel) else {
            return (None, false);
        };
        let too_big = std::fs::metadata(&abs).map(|m| m.len() > EXTERNAL_SNAPSHOT_CAP).unwrap_or(false);
        if too_big {
            return match std::fs::read(&abs) {
                Ok(bytes) => (Some(::history::snapshot::labeled_hash(&bytes)), false),
                Err(_) => (None, false),
            };
        }
        match std::fs::read(&abs) {
            Ok(bytes) => (Some(::history::snapshot::labeled_hash(&bytes)), true),
            Err(_) => (None, false),
        }
    };

    let (summary, files, snapshot_after) = match &event.kind {
        WatchEventKind::Created => {
            let (after, snap) = read_after(&path);
            (
                format!("Внешнее создание: {path}"),
                vec![vault_core::FileChange { path: path.clone(), before: None, after }],
                snap,
            )
        }
        WatchEventKind::Modified => {
            let before = ::history::last_after_for_path(&journal_dir, &path);
            let (after, snap) = read_after(&path);
            (
                format!("Внешнее изменение: {path}"),
                vec![vault_core::FileChange { path: path.clone(), before, after }],
                snap,
            )
        }
        WatchEventKind::Removed => {
            let before = ::history::last_after_for_path(&journal_dir, &path);
            (
                format!("Внешнее удаление: {path}"),
                vec![vault_core::FileChange { path: path.clone(), before, after: None }],
                false,
            )
        }
        WatchEventKind::Moved { from } => {
            let before_from = ::history::last_after_for_path(&journal_dir, from);
            let (after, snap) = read_after(&path);
            (
                format!("Внешний перенос: {from} → {path}"),
                vec![
                    vault_core::FileChange { path: from.clone(), before: before_from, after: None },
                    vault_core::FileChange { path: path.clone(), before: None, after },
                ],
                snap,
            )
        }
    };

    let op = vault_core::JournalOp {
        op_id: ulid::Ulid::new().to_string(),
        ts: vault_core::writer::now_iso_utc(),
        actor: Actor::External,
        session: None,
        tool: None,
        summary,
        files,
        undone: false,
    };

    // `record` дописывает журнал и кладёт after-снапшоты присутствующих файлов;
    // для крупных/удалённых/перенесённых-источников снапшот не нужен, тогда пишем
    // только журнал через `append_op`.
    let recorded = if snapshot_after {
        vault_core::vault::history::record(root, &op).is_ok()
    } else {
        ::history::append_op(&journal_dir, &op).is_ok()
    };
    if recorded {
        Some(op)
    } else {
        None
    }
}

/// Рассылает операцию журнала в ленту активности (`journal_op`), как это делает
/// ядро после собственных мутаций. Форма serde у dto и канонического типа
/// совпадает (CONTRACT §2), поэтому конвертация — round-trip через serde_json.
fn emit_journal_op(app: &tauri::AppHandle, op: &vault_core::JournalOp) {
    if let Ok(dto_op) = serde_json::to_value(op).and_then(serde_json::from_value::<dto::JournalOp>) {
        let _ = app.emit("journal_op", events::JournalOpEvent { op: dto_op });
    }
}

/// Запускает наблюдение за смонтированным vault и транслирует изменения в
/// событие `note_changed`. Свои записи гасятся общим эхо-набором писателя.
fn start_vault_watcher(
    app: &tauri::AppHandle,
    root: &Path,
) -> Result<vault_core::watcher::VaultWatcher, vault_core::VaultError> {
    use vault_core::watcher::WatchEventKind;
    let echo: Arc<dyn vault_core::watcher::EchoSource> = vault_core::writer::shared_echo();
    let app = app.clone();
    vault_core::watcher::start(root, echo, move |events| {
        for event in events {
            let path = event.path.clone();
            // Корень ядра под коротким локом — journaling ниже работает с ним без
            // удержания мьютекса (трогает только .graphite/history и .graphite/journal).
            let root = commands::lock_core().as_ref().map(|s| s.root.clone());
            // Внешнее изменение (свои записи echo уже отфильтровал) фиксируем в
            // истории ДО реиндекса: иначе OneDrive-синк/прямые правки .md/любой
            // внешний редактор в таймлайн не попадают и откатить их нечем.
            let journaled = root.as_ref().and_then(|root| journal_external_event(root, &event));
            // …и в индекс, иначе поиск/задачи/связи по правке остаются устаревшими.
            {
                let mut guard = commands::lock_core();
                if let Some(state) = guard.as_mut() {
                    let root = state.root.clone();
                    match &event.kind {
                        WatchEventKind::Removed => {
                            let _ = state.index.remove_by_path(&path);
                        }
                        WatchEventKind::Moved { from } => {
                            let _ = state.index.remove_by_path(from);
                            let _ = state.index.reindex_paths(&root, &[path.clone()]);
                        }
                        _ => {
                            let _ = state.index.reindex_paths(&root, &[path.clone()]);
                        }
                    }
                }
            }
            let (kind, from) = match &event.kind {
                WatchEventKind::Created => (NoteChangeKind::Created, None),
                WatchEventKind::Modified => (NoteChangeKind::Modified, None),
                WatchEventKind::Removed => (NoteChangeKind::Removed, None),
                WatchEventKind::Moved { from } => {
                    (NoteChangeKind::Moved, Some(NoteRef(format!("path:{from}"))))
                }
            };
            let rev = event.rev.map(|r| Rev(r.0)).unwrap_or_else(|| Rev(String::new()));
            let payload = NoteChangedEvent {
                r#ref: NoteRef(format!("path:{path}")),
                rev,
                actor: Actor::External,
                kind: Some(kind),
                from,
            };
            let _ = app.emit("note_changed", payload);
            if let Some(op) = &journaled {
                emit_journal_op(&app, op);
            }
        }
    })
}

/// Фоновый супервизор: следит за текущим корнем ядра и держит watcher в
/// актуальном состоянии — стартует при монтировании vault, перезапускает при
/// смене и снимает при размонтировании. Не зависит от команд, поэтому
/// корректно ловит и автомонтирование на старте, и выбор vault в рантайме.
fn spawn_watcher_supervisor(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("graphite-watch-supervisor".into())
        .spawn(move || {
            let mut current: Option<(std::path::PathBuf, vault_core::watcher::VaultWatcher)> = None;
            loop {
                let root = commands::lock_core().as_ref().map(|s| s.root.clone());
                let unchanged = match (&current, &root) {
                    (Some((watched, _)), Some(root)) => watched == root,
                    (None, None) => true,
                    _ => false,
                };
                if !unchanged {
                    current = None;
                    if let Some(path) = &root {
                        match start_vault_watcher(&app, path) {
                            Ok(watcher) => current = Some((path.clone(), watcher)),
                            Err(err) => {
                                eprintln!("graphite: watcher не поднят для {}: {err}", path.display());
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        });
}

pub fn run() {
    let builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["capture", "note"])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window.label(), "main" | "capture" | "note") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            runtime::set_app_handle(app.handle().clone());
            commands::mount_saved_vault();

            // Служебные окна на старте всегда скрыты, что бы ни лежало в
            // сохранённом window-state прошлых версий: окно заметки появляется
            // только по open_note_window, захват — по хоткею/трею.
            for label in ["note", "capture"] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.hide();
                }
            }

            let mcp_item = build_tray(app)?;
            register_global_shortcut(app.handle());
            spawn_watcher_supervisor(app.handle().clone());

            let rpc_slot: Arc<Mutex<Option<rpc::ServerHandle>>> = Arc::new(Mutex::new(None));
            app.manage(rpc_slot.clone());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let handler = Arc::new(rpc_handler::AppHandler::new(app_handle.clone()));
                let (text, active) = match rpc::RpcServer::new(handler).start().await {
                    Ok(server) => {
                        *rpc_slot.lock().unwrap() = Some(server);
                        ("MCP: активен", true)
                    }
                    Err(err) => {
                        eprintln!("graphite: канал ядра {} не поднят: {err}", rpc::protocol::PIPE_PATH);
                        ("MCP: не запущен", false)
                    }
                };
                let _ = app_handle.emit("mcp_session", McpSessionEvent { active, session: None });
                let _ = app_handle.run_on_main_thread(move || {
                    let _ = mcp_item.set_text(text);
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running graphite");
}

#[cfg(test)]
mod tests {
    #[test]
    fn typescript_bindings_export() {
        let dir = std::env::temp_dir().join("graphite-bindings-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("generated.ts");
        if super::specta_builder()
            .export(specta_typescript::Typescript::default(), &path)
            .is_err()
        {
            return;
        }
        let out = std::fs::read_to_string(&path).unwrap();
        assert!(out.contains("vaultInfo"));
        assert!(out.contains("quickCapture"));
        assert!(out.contains("openNoteWindow"));
        assert!(out.contains("peekDailyNote"));
        assert!(out.contains("pruneEmptyDailyNotes"));
        assert!(out.contains("exportWrite"));
        assert!(out.contains("note_changed"));
        assert!(out.contains("ui_flash_note"));
    }
}
