use std::path::{Path, PathBuf};

use crate::error::VaultError;

pub const DEBOUNCE_MS: u64 = 300;

pub struct VaultWatcher;

impl VaultWatcher {
    pub fn stop(self) -> Result<(), VaultError> {
        todo!()
    }
}

pub fn start<F>(_vault_root: &Path, _on_change: F) -> Result<VaultWatcher, VaultError>
where
    F: FnMut(Vec<PathBuf>) + Send + 'static,
{
    todo!()
}
