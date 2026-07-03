use crate::error::VaultError;
use crate::model::{Actor, FileChange, JournalOp};

pub struct Txn {
    pub actor: Actor,
    pub tool: Option<String>,
    pub session: Option<String>,
    pub files: Vec<FileChange>,
}

pub fn begin(_actor: Actor, _tool: Option<String>, _session: Option<String>) -> Result<Txn, VaultError> {
    todo!()
}

impl Txn {
    pub fn stage_write(&mut self, _rel_path: &str, _content: String) -> Result<(), VaultError> {
        todo!()
    }

    pub fn stage_delete(&mut self, _rel_path: &str) -> Result<(), VaultError> {
        todo!()
    }

    pub fn commit(self, _summary: &str) -> Result<JournalOp, VaultError> {
        todo!()
    }

    pub fn rollback(self) -> Result<(), VaultError> {
        todo!()
    }
}
