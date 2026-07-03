mod commands;
mod dto;
mod events;

use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

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

pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
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
        assert!(out.contains("note_changed"));
        assert!(out.contains("ui_flash_note"));
    }
}
