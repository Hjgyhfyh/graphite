use std::path::Path;

use crate::error::VaultError;
use crate::model::{Block, IndexStatus, LinkEdge, NoteId, NoteMeta, SearchParams, SearchResponse, TaskItem};

pub struct Index {
    pub conn: rusqlite::Connection,
}

impl Index {
    pub fn open(_db_path: &Path) -> Result<Self, VaultError> {
        todo!()
    }

    pub fn rebuild(&mut self, _vault_root: &Path) -> Result<(), VaultError> {
        todo!()
    }

    pub fn upsert_note(
        &mut self,
        _meta: &NoteMeta,
        _blocks: &[Block],
        _tasks: &[TaskItem],
        _links: &[LinkEdge],
    ) -> Result<(), VaultError> {
        todo!()
    }

    pub fn remove_note(&mut self, _note_id: &NoteId) -> Result<(), VaultError> {
        todo!()
    }

    pub fn search(&self, _params: &SearchParams) -> Result<SearchResponse, VaultError> {
        todo!()
    }

    pub fn status(&self) -> Result<IndexStatus, VaultError> {
        todo!()
    }
}
