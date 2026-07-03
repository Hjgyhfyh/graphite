//! Канонические типы ядра (CONTRACT §2–§3) объявлены в крейте `rpc`
//! и реэкспортируются отсюда без дублей (CONTRACT §9, правило 3).
//! Здесь остаются только типы оболочки (CONTRACT §5–§6), которых нет в реестре IPC.

use serde::{Deserialize, Serialize};

pub use rpc::protocol::{IndexState, IndexStatus};
pub use rpc::types::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferSaveParams {
    pub r#ref: NoteRef,
    pub base_rev: Rev,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub restored_files: u32,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliInfo {
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub mcp_add_command: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChangedEvent {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub actor: Actor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressEvent {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOpEvent {
    pub op: JournalOp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionEvent {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}
