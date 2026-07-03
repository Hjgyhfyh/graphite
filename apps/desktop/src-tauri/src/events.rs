use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::dto::{Actor, JournalOp, NoteRef, Rev};

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "note_changed")]
pub struct NoteChangedEvent {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub actor: Actor,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "index_progress")]
pub struct IndexProgressEvent {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "journal_op")]
pub struct JournalOpEvent {
    pub op: JournalOp,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "mcp_session")]
pub struct McpSessionEvent {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "ui_open_note")]
pub struct UiOpenNoteEvent {
    pub r#ref: NoteRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "ui_flash_note")]
pub struct UiFlashNoteEvent {
    pub r#ref: NoteRef,
}
