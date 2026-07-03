use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{NoteId, NoteMeta, NoteRef};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRef {
    Id(NoteId),
    Path(String),
}

pub fn parse_ref(_note_ref: &NoteRef) -> Result<ParsedRef, VaultError> {
    todo!()
}

pub fn resolve(_index: &Index, _note_ref: &NoteRef) -> Result<NoteMeta, VaultError> {
    todo!()
}

pub fn resolve_wikilink(_index: &Index, _from: &NoteId, _target: &str) -> Result<Option<NoteId>, VaultError> {
    todo!()
}
