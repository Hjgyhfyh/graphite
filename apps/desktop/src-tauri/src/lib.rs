mod commands;
mod dto;
mod events;
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
use events::NoteChangedEvent;

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
            commands::open_note_window,
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

#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/bindings/src/generated.ts");
    builder
        .export(specta_typescript::Typescript::default(), path)
        .expect("failed to export typescript bindings");
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

/// Запускает наблюдение за смонтированным vault и транслирует изменения в
/// событие `note_changed`. Свои записи гасятся общим эхо-набором писателя.
fn start_vault_watcher(
    app: &tauri::AppHandle,
    root: &Path,
) -> Result<vault_core::watcher::VaultWatcher, vault_core::VaultError> {
    let echo: Arc<dyn vault_core::watcher::EchoSource> = vault_core::writer::shared_echo();
    let app = app.clone();
    vault_core::watcher::start(root, echo, move |events| {
        for event in events {
            let rev = event.rev.map(|r| Rev(r.0)).unwrap_or_else(|| Rev(String::new()));
            let payload = NoteChangedEvent {
                r#ref: NoteRef(format!("path:{}", event.path)),
                rev,
                actor: Actor::External,
            };
            let _ = app.emit("note_changed", payload);
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
                let root = state::core_cell().lock().unwrap().as_ref().map(|s| s.root.clone());
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

    #[cfg(debug_assertions)]
    export_bindings(&builder);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["capture"])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window.label(), "main" | "capture") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            commands::mount_saved_vault();

            let mcp_item = build_tray(app)?;
            register_global_shortcut(app.handle());
            spawn_watcher_supervisor(app.handle().clone());

            let rpc_slot: Arc<Mutex<Option<rpc::ServerHandle>>> = Arc::new(Mutex::new(None));
            app.manage(rpc_slot.clone());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let handler = Arc::new(rpc_handler::AppHandler::new(app_handle.clone()));
                let text = match rpc::RpcServer::new(handler).start().await {
                    Ok(server) => {
                        *rpc_slot.lock().unwrap() = Some(server);
                        "MCP: активен"
                    }
                    Err(err) => {
                        eprintln!("graphite: канал ядра {} не поднят: {err}", rpc::protocol::PIPE_PATH);
                        "MCP: не запущен"
                    }
                };
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
        super::specta_builder()
            .export(specta_typescript::Typescript::default(), &path)
            .unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        assert!(out.contains("vaultInfo"));
        assert!(out.contains("quickCapture"));
        assert!(out.contains("openNoteWindow"));
        assert!(out.contains("note_changed"));
        assert!(out.contains("ui_flash_note"));
    }
}
