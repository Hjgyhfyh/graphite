use std::fs::File;
use std::path::Path;

use crate::error::VaultError;
use crate::model::Rev;

#[derive(Debug, Default)]
pub struct EchoSet;

impl EchoSet {
    pub fn register(&self, _rel_path: &str, _full_hash: &str) {
        todo!()
    }

    pub fn take(&self, _rel_path: &str, _full_hash: &str) -> bool {
        todo!()
    }
}

pub fn acquire_vault_lock(_vault_root: &Path) -> Result<fd_lock::RwLock<File>, VaultError> {
    todo!()
}

pub fn write_atomic(_vault_root: &Path, _rel_path: &str, _content: &[u8]) -> Result<Rev, VaultError> {
    todo!()
}

pub fn rename_atomic(_vault_root: &Path, _from_rel: &str, _to_rel: &str) -> Result<(), VaultError> {
    todo!()
}

pub fn delete_to_trash(_vault_root: &Path, _rel_path: &str) -> Result<String, VaultError> {
    todo!()
}

pub fn restore_from_trash(_vault_root: &Path, _restore_token: &str) -> Result<String, VaultError> {
    todo!()
}

pub fn compute_rev(_bytes: &[u8]) -> Rev {
    todo!()
}

pub fn compute_full_hash(_bytes: &[u8]) -> String {
    todo!()
}
