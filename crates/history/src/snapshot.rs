use std::path::Path;

use crate::error::HistoryError;

pub fn snapshot_file(_snapshot_dir: &Path, _content: &[u8]) -> Result<String, HistoryError> {
    todo!()
}
