use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::HistoryError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRestore {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPlan {
    pub op_id: String,
    pub restores: Vec<FileRestore>,
}

pub fn undo_plan(_journal_dir: &Path, _op_id: &str) -> Result<UndoPlan, HistoryError> {
    todo!()
}
