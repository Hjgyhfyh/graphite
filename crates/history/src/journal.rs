use std::path::Path;

use crate::error::HistoryError;
use crate::model::JournalOp;

pub fn append_op(_journal_dir: &Path, _op: &JournalOp) -> Result<(), HistoryError> {
    todo!()
}

pub fn read_ops(
    _journal_dir: &Path,
    _since: Option<&str>,
    _limit: Option<u32>,
) -> Result<Vec<JournalOp>, HistoryError> {
    todo!()
}
