//! План отката операции/сессии (SPEC §6.8, матрица undo).
//! История только строит план по журналу и снапшотам; применение плана
//! (запись в vault, 3-way merge) — на стороне vault-core.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::HistoryError;
use crate::journal::{read_op, read_session_ops};
use crate::model::JournalOp;
use crate::snapshot::{hash_hex, HASH_LABEL};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRestore {
    pub path: String,
    /// before-снапшот (`blake3:<64hex>`); `None` — файл создан операцией, откат = удаление.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_to: Option<String>,
    /// Файл менялся после отменяемой операции (текущий hash != after) —
    /// простое восстановление затрёт чужие правки, требуется 3-way merge.
    pub needs_merge: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPlan {
    pub op_id: String,
    pub restores: Vec<FileRestore>,
}

/// План отката одной операции: каждый её файл → before-снапшот.
pub fn undo_plan(
    journal_dir: &Path,
    vault_root: &Path,
    op_id: &str,
) -> Result<UndoPlan, HistoryError> {
    let op = read_op(journal_dir, op_id)?;
    plan_for_op(vault_root, &op)
}

/// План отката сессии: все её неотменённые операции в обратном
/// хронологическом порядке, по плану на операцию.
pub fn undo_session_plan(
    journal_dir: &Path,
    vault_root: &Path,
    session: &str,
) -> Result<Vec<UndoPlan>, HistoryError> {
    let ops = read_session_ops(journal_dir, session)?;
    if ops.is_empty() {
        return Err(HistoryError::NotFound(format!("session {session}")));
    }
    ops.iter()
        .filter(|op| !op.undone)
        .map(|op| plan_for_op(vault_root, op))
        .collect()
}

fn plan_for_op(vault_root: &Path, op: &JournalOp) -> Result<UndoPlan, HistoryError> {
    let mut restores = Vec::with_capacity(op.files.len());
    for change in &op.files {
        let current = current_hash(vault_root, &change.path)?;
        let after = change.after.as_deref().map(strip_label);
        let needs_merge = match (&current, &after) {
            (None, None) => false,
            (Some(current), Some(after)) => current != after,
            _ => true,
        };
        restores.push(FileRestore {
            path: change.path.clone(),
            restore_to: change.before.clone(),
            needs_merge,
        });
    }
    Ok(UndoPlan {
        op_id: op.op_id.clone(),
        restores,
    })
}

fn strip_label(value: &str) -> String {
    value
        .strip_prefix(HASH_LABEL)
        .unwrap_or(value)
        .to_ascii_lowercase()
}

fn current_hash(vault_root: &Path, rel_path: &str) -> Result<Option<String>, HistoryError> {
    match std::fs::read(vault_root.join(rel_path)) {
        Ok(bytes) => Ok(Some(hash_hex(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
