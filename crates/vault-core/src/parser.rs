use crate::error::VaultError;
use crate::model::{Anchor, Block, Frontmatter, LinkEdge, NoteId, TaskItem};

pub fn parse_frontmatter(_raw: &str) -> Result<(Frontmatter, String), VaultError> {
    todo!()
}

pub fn serialize_frontmatter(_frontmatter: &Frontmatter) -> Result<String, VaultError> {
    todo!()
}

pub fn extract_blocks(_note_id: &NoteId, _body: &str) -> Result<Vec<Block>, VaultError> {
    todo!()
}

pub fn extract_tasks(_note_id: &NoteId, _body: &str) -> Result<Vec<TaskItem>, VaultError> {
    todo!()
}

pub fn extract_links(_src_id: &NoteId, _body: &str) -> Result<Vec<LinkEdge>, VaultError> {
    todo!()
}

pub fn find_section(_body: &str, _heading: &str) -> Result<Option<(usize, usize)>, VaultError> {
    todo!()
}

pub fn generate_anchor() -> Anchor {
    todo!()
}
