use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::dto::{Actor, JournalOp, NoteRef, Rev};

/// Вид изменения заметки — позволяет фронту отличить внешнее удаление/
/// переименование от обычной правки (закрыть вкладку, обновить путь).
/// `BufferBody` — автосейв тела из редактора: структура vault не менялась,
/// поэтому фронт обновляет дерево/счётчики ленивым дебаунсом, а не сразу.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum NoteChangeKind {
    Created,
    Modified,
    Removed,
    Moved,
    BufferBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "note_changed")]
pub struct NoteChangedEvent {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<NoteChangeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<NoteRef>,
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

/// Статус синхронизации на фронт: перерисовать индикатор при idle/syncing/error.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sync_status")]
pub struct SyncStatusEvent {
    /// "idle" | "syncing" | "error".
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub active: bool,
}
