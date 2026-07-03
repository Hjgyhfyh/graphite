//! Транзакции vault (SPEC §6.11): rename/move файла и поддерева с
//! переписыванием входящих `[[ссылок]]` (старый заголовок уходит в `aliases`
//! цели), promotion `Заметка.md` → `Заметка/_index.md` при появлении первого
//! ребёнка, каскад детей, поле `sort`, мягкое удаление в `.trash/` с
//! `restore_token` и восстановление. Одна транзакция — одна запись журнала;
//! содержимое чужих файлов меняется точечно (только цель ссылки и нужные
//! строки frontmatter), стиль концов строк сохраняется.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

pub use rusqlite;

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{
    Actor, FileChange, JournalOp, NoteDeleteParams, NoteDeleteResponse, NoteId, NoteMoveParams,
    NoteMoveResponse, NoteRef, NoteRenameParams, NoteRenameResponse, NoteRestoreParams,
    NoteRestoreResponse,
};
use crate::resolver::{self, ParsedRef};
use crate::writer;

const INDEX_FILE: &str = "_index.md";

/// Атрибуция транзакции для журнала.
#[derive(Debug, Clone)]
pub struct TxnOpts {
    pub actor: Actor,
    pub tool: Option<String>,
    pub session: Option<String>,
}

/// Накопитель транзакции: операции ставятся в очередь, `commit` применяет их
/// по порядку и при сбое откатывает уже применённые в обратном порядке.
#[derive(Debug)]
pub struct Txn {
    pub actor: Actor,
    pub tool: Option<String>,
    pub session: Option<String>,
    pub files: Vec<FileChange>,
    root: PathBuf,
    ops: Vec<StagedOp>,
}

#[derive(Debug)]
enum StagedOp {
    Write { rel: String, content: Vec<u8> },
    Move { from: String, to: String },
    Trash { rel: String, token: String, primary: String },
    Restore { token: String },
}

enum UndoStep {
    RestoreBytes { rel: String, before: Option<Vec<u8>> },
    MoveBack { from: String, to: String },
    Untrash { rel: String, token: String },
    Retrash { token: String, rels: Vec<String> },
}

pub fn begin(
    vault_root: &Path,
    actor: Actor,
    tool: Option<String>,
    session: Option<String>,
) -> Result<Txn, VaultError> {
    if !vault_root.is_dir() {
        return Err(VaultError::NotFound(format!(
            "корень vault: {}",
            vault_root.display()
        )));
    }
    Ok(Txn {
        actor,
        tool,
        session,
        files: Vec::new(),
        root: vault_root.to_path_buf(),
        ops: Vec::new(),
    })
}

impl Txn {
    pub fn stage_write(&mut self, rel_path: &str, content: String) -> Result<(), VaultError> {
        valid_rel(rel_path)?;
        self.ops.push(StagedOp::Write {
            rel: rel_path.to_string(),
            content: content.into_bytes(),
        });
        Ok(())
    }

    /// Удаление всегда мягкое: файл уезжает в `.trash/<token>/…`.
    pub fn stage_delete(&mut self, rel_path: &str) -> Result<(), VaultError> {
        let token = ulid::Ulid::new().to_string();
        self.stage_trash(rel_path, &token, rel_path)
    }

    pub fn stage_move(&mut self, from_rel: &str, to_rel: &str) -> Result<(), VaultError> {
        valid_rel(from_rel)?;
        valid_rel(to_rel)?;
        self.ops.push(StagedOp::Move {
            from: from_rel.to_string(),
            to: to_rel.to_string(),
        });
        Ok(())
    }

    pub fn stage_trash(
        &mut self,
        rel_path: &str,
        token: &str,
        primary: &str,
    ) -> Result<(), VaultError> {
        valid_rel(rel_path)?;
        self.ops.push(StagedOp::Trash {
            rel: rel_path.to_string(),
            token: token.to_string(),
            primary: primary.to_string(),
        });
        Ok(())
    }

    pub fn stage_restore(&mut self, token: &str) -> Result<(), VaultError> {
        if token.is_empty() {
            return Err(VaultError::Validation("пустой restore_token".to_string()));
        }
        self.ops.push(StagedOp::Restore {
            token: token.to_string(),
        });
        Ok(())
    }

    pub fn commit(mut self, summary: &str) -> Result<JournalOp, VaultError> {
        let ops = std::mem::take(&mut self.ops);
        let mut undo: Vec<UndoStep> = Vec::new();
        let mut entries: Vec<FileChange> = Vec::new();
        for op in &ops {
            if let Err(err) = apply_op(&self.root, op, &mut entries, &mut undo) {
                for step in undo.iter().rev() {
                    undo_step(&self.root, step);
                }
                return Err(err);
            }
        }
        self.files = coalesce(entries);
        Ok(JournalOp {
            op_id: ulid::Ulid::new().to_string(),
            ts: writer::now_iso_utc(),
            actor: self.actor,
            session: self.session,
            tool: self.tool,
            summary: summary.to_string(),
            files: self.files,
            undone: false,
        })
    }

    /// Откат до применения: ничего не записано, очередь просто отбрасывается.
    pub fn rollback(self) -> Result<(), VaultError> {
        Ok(())
    }
}

fn valid_rel(rel: &str) -> Result<(), VaultError> {
    if rel.trim().is_empty() {
        return Err(VaultError::Validation("пустой путь".to_string()));
    }
    if rel.split('/').any(|segment| segment == "..") {
        return Err(VaultError::Validation(format!(
            "путь выходит за пределы vault: {rel}"
        )));
    }
    Ok(())
}

fn apply_op(
    root: &Path,
    op: &StagedOp,
    entries: &mut Vec<FileChange>,
    undo: &mut Vec<UndoStep>,
) -> Result<(), VaultError> {
    match op {
        StagedOp::Write { rel, content } => {
            let before = read_opt(root, rel)?;
            writer::write_atomic(root, rel, content)?;
            entries.push(FileChange {
                path: rel.clone(),
                before: before.as_deref().map(hash_label),
                after: Some(hash_label(content)),
            });
            undo.push(UndoStep::RestoreBytes {
                rel: rel.clone(),
                before,
            });
        }
        StagedOp::Move { from, to } => {
            let abs = writer::vault_abs_path(root, from)?;
            if abs.is_dir() {
                for inner in writer::walk_rel_files(&abs)? {
                    let old_rel = format!("{from}/{inner}");
                    let new_rel = format!("{to}/{inner}");
                    let bytes = fs::read(writer::vault_abs_path(root, &old_rel)?)?;
                    let label = hash_label(&bytes);
                    entries.push(FileChange {
                        path: old_rel,
                        before: Some(label.clone()),
                        after: None,
                    });
                    entries.push(FileChange {
                        path: new_rel,
                        before: None,
                        after: Some(label),
                    });
                }
            } else {
                let bytes = fs::read(&abs)?;
                let label = hash_label(&bytes);
                entries.push(FileChange {
                    path: from.clone(),
                    before: Some(label.clone()),
                    after: None,
                });
                entries.push(FileChange {
                    path: to.clone(),
                    before: None,
                    after: Some(label),
                });
            }
            writer::rename_atomic(root, from, to)?;
            undo.push(UndoStep::MoveBack {
                from: from.clone(),
                to: to.clone(),
            });
        }
        StagedOp::Trash {
            rel,
            token,
            primary,
        } => {
            let abs = writer::vault_abs_path(root, rel)?;
            if abs.is_dir() {
                for inner in writer::walk_rel_files(&abs)? {
                    let full = format!("{rel}/{inner}");
                    let bytes = fs::read(writer::vault_abs_path(root, &full)?)?;
                    entries.push(FileChange {
                        path: full,
                        before: Some(hash_label(&bytes)),
                        after: None,
                    });
                }
            } else if abs.is_file() {
                let bytes = fs::read(&abs)?;
                entries.push(FileChange {
                    path: rel.clone(),
                    before: Some(hash_label(&bytes)),
                    after: None,
                });
            }
            writer::delete_to_trash_as(root, rel, token, primary)?;
            undo.push(UndoStep::Untrash {
                rel: rel.clone(),
                token: token.clone(),
            });
        }
        StagedOp::Restore { token } => {
            let token_abs =
                writer::vault_abs_path(root, &format!("{}/{token}", writer::TRASH_DIR))?;
            let mut rels = Vec::new();
            if token_abs.is_dir() {
                for inner in writer::walk_rel_files(&token_abs)? {
                    if inner == writer::TRASH_ORIGIN {
                        continue;
                    }
                    let bytes = fs::read(token_abs.join(inner.split('/').collect::<PathBuf>()))?;
                    entries.push(FileChange {
                        path: inner.clone(),
                        before: None,
                        after: Some(hash_label(&bytes)),
                    });
                    rels.push(inner);
                }
            }
            writer::restore_from_trash(root, token)?;
            undo.push(UndoStep::Retrash {
                token: token.clone(),
                rels,
            });
        }
    }
    Ok(())
}

fn undo_step(root: &Path, step: &UndoStep) {
    match step {
        UndoStep::RestoreBytes { rel, before } => match before {
            Some(bytes) => {
                let _ = writer::write_atomic(root, rel, bytes);
            }
            None => {
                if let Ok(abs) = writer::vault_abs_path(root, rel) {
                    let _ = fs::remove_file(abs);
                }
            }
        },
        UndoStep::MoveBack { from, to } => {
            let _ = writer::rename_atomic(root, to, from);
        }
        UndoStep::Untrash { rel, token } => {
            let trashed = format!("{}/{token}/{rel}", writer::TRASH_DIR);
            let _ = writer::rename_atomic(root, &trashed, rel);
            if let Ok(abs) = writer::vault_abs_path(root, &format!("{}/{token}", writer::TRASH_DIR))
            {
                let _ = fs::remove_dir_all(abs);
            }
        }
        UndoStep::Retrash { token, rels } => {
            for rel in rels {
                let trashed = format!("{}/{token}/{rel}", writer::TRASH_DIR);
                let _ = writer::rename_atomic(root, rel, &trashed);
            }
        }
    }
}

fn coalesce(entries: Vec<FileChange>) -> Vec<FileChange> {
    let mut order: Vec<String> = Vec::new();
    let mut merged: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for entry in entries {
        match merged.get_mut(&entry.path) {
            Some(slot) => slot.1 = entry.after,
            None => {
                order.push(entry.path.clone());
                merged.insert(entry.path, (entry.before, entry.after));
            }
        }
    }
    order
        .into_iter()
        .filter_map(|path| {
            let (before, after) = merged.remove(&path)?;
            if before == after {
                return None;
            }
            Some(FileChange {
                path,
                before,
                after,
            })
        })
        .collect()
}

fn hash_label(bytes: &[u8]) -> String {
    format!("blake3:{}", writer::compute_full_hash(bytes))
}

fn read_opt(root: &Path, rel: &str) -> Result<Option<Vec<u8>>, VaultError> {
    let abs = writer::vault_abs_path(root, rel)?;
    match fs::read(&abs) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn read_utf8(root: &Path, rel: &str) -> Result<Option<String>, VaultError> {
    match read_opt(root, rel)? {
        Some(bytes) => Ok(String::from_utf8(bytes).ok()),
        None => Ok(None),
    }
}

/// Переименование заметки (CONTRACT `note_rename`): новое имя файла из
/// санитизированного заголовка, старый заголовок — в `aliases`, входящие
/// ссылки переписываются; для folder-note переезжает вся папка.
pub fn rename(
    vault_root: &Path,
    index: &Index,
    params: &NoteRenameParams,
    opts: &TxnOpts,
) -> Result<(NoteRenameResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let new_title = params.new_title.trim().to_string();
    if new_title.is_empty() {
        return Err(VaultError::Validation("пустой new_title".to_string()));
    }
    let folder = is_folder_note(&meta.path);
    if folder && folder_dir(&meta.path).is_empty() {
        return Err(VaultError::Validation(
            "нельзя переименовать корневой _index.md".to_string(),
        ));
    }
    let stem_new = writer::sanitize_file_name(&new_title);
    let (old_root, new_root, new_note_path) = if folder {
        let dir = folder_dir(&meta.path).to_string();
        let new_dir = join_rel(parent_of(&dir), &stem_new);
        let new_note = format!("{new_dir}/{INDEX_FILE}");
        (dir, new_dir, new_note)
    } else {
        let new_path = join_rel(parent_of(&meta.path), &format!("{stem_new}.md"));
        (meta.path.clone(), new_path.clone(), new_path)
    };
    let move_needed = old_root != new_root;
    let title_changed = meta.title != new_title;
    if !move_needed && !title_changed {
        let txn = begin_with(vault_root, opts)?;
        let op = txn.commit(&format!("Переименование «{}»: без изменений", meta.title))?;
        return Ok((
            NoteRenameResponse {
                path_new: meta.path.clone(),
                links_updated: 0,
                alias_added: false,
            },
            op,
        ));
    }
    if move_needed && writer::vault_abs_path(vault_root, &new_root)?.exists() {
        return Err(VaultError::Validation(format!("путь уже занят: {new_root}")));
    }
    let notes = note_paths(index)?;
    let path_by_id: HashMap<&str, &str> = notes
        .iter()
        .map(|(id, path)| (id.as_str(), path.as_str()))
        .collect();
    let mut moved: HashMap<String, MovedNote> = HashMap::new();
    if move_needed {
        if folder {
            let prefix = format!("{old_root}/");
            for (id, path) in &notes {
                if let Some(suffix) = path.strip_prefix(&prefix) {
                    let new_path = format!("{new_root}/{suffix}");
                    moved.insert(
                        id.clone(),
                        MovedNote {
                            folder: is_folder_note(&new_path),
                            new_path,
                        },
                    );
                }
            }
        } else {
            moved.insert(
                meta.id.0.clone(),
                MovedNote {
                    new_path: new_note_path.clone(),
                    folder: false,
                },
            );
        }
    }
    let retitle = title_changed.then(|| {
        let old_stem = if folder {
            last_segment(&old_root).to_string()
        } else {
            last_segment(strip_md(&meta.path)).to_string()
        };
        let mut old_keys = vec![resolver::normalize_key(&meta.title)];
        let stem_key = resolver::normalize_key(&old_stem);
        if !old_keys.contains(&stem_key) {
            old_keys.push(stem_key);
        }
        Retitle {
            id: meta.id.0.clone(),
            old_keys,
            new_title: new_title.clone(),
            fallback: short_path_target(&new_note_path, folder),
        }
    });
    let mut scan_ids: BTreeSet<String> = moved.keys().cloned().collect();
    scan_ids.insert(meta.id.0.clone());
    let (mut edits, links_updated) = rewrite_referrers(
        vault_root,
        index,
        &scan_ids,
        &path_by_id,
        &moved,
        retitle.as_ref(),
    )?;
    let mut alias_added = false;
    if title_changed {
        let base = match edits.get(meta.path.as_str()) {
            Some(text) => Some(text.clone()),
            None => read_utf8(vault_root, &meta.path)?,
        };
        if let Some(text) = base {
            let alias = (resolver::normalize_key(&meta.title)
                != resolver::normalize_key(&new_title))
            .then_some(meta.title.as_str());
            let (patched, added) = patch_frontmatter(
                &text,
                &FmEdit {
                    set_title: Some(&new_title),
                    add_alias: alias,
                    set_sort: None,
                },
            );
            alias_added = added;
            if patched != text {
                edits.insert(meta.path.clone(), patched);
            }
        }
    }
    let mut txn = begin_with(vault_root, opts)?;
    for (rel, content) in &edits {
        txn.stage_write(rel, content.clone())?;
    }
    if move_needed {
        txn.stage_move(&old_root, &new_root)?;
    }
    let op = txn.commit(&format!(
        "Переименование «{}» → «{new_title}»",
        meta.title
    ))?;
    Ok((
        NoteRenameResponse {
            path_new: new_note_path,
            links_updated,
            alias_added,
        },
        op,
    ))
}

/// Перенос заметки под нового родителя (CONTRACT `note_move`): каскад
/// поддерева, promotion листа-родителя в `_index.md`, переписывание входящих
/// путевых ссылок, `position` → поле `sort` (дробный порядок).
pub fn mv(
    vault_root: &Path,
    index: &Index,
    params: &NoteMoveParams,
    opts: &TxnOpts,
) -> Result<(NoteMoveResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let folder = is_folder_note(&meta.path);
    if folder && folder_dir(&meta.path).is_empty() {
        return Err(VaultError::Validation(
            "нельзя перенести корневой _index.md".to_string(),
        ));
    }
    let old_root = if folder {
        folder_dir(&meta.path).to_string()
    } else {
        meta.path.clone()
    };
    let name = last_segment(&old_root).to_string();
    let mut promotion: Option<(String, String, String)> = None;
    let parent_dir = if is_root_parent(&params.new_parent) {
        String::new()
    } else {
        let parent = resolver::resolve(index, &params.new_parent)?;
        if parent.id == meta.id {
            return Err(VaultError::Validation(
                "нельзя перенести заметку в саму себя".to_string(),
            ));
        }
        if is_folder_note(&parent.path) {
            folder_dir(&parent.path).to_string()
        } else {
            let dir = strip_md(&parent.path).to_string();
            promotion = Some((
                parent.id.0.clone(),
                parent.path.clone(),
                format!("{dir}/{INDEX_FILE}"),
            ));
            dir
        }
    };
    if folder && (parent_dir == old_root || parent_dir.starts_with(&format!("{old_root}/"))) {
        return Err(VaultError::Validation(
            "нельзя перенести папку внутрь самой себя".to_string(),
        ));
    }
    let new_root = join_rel(&parent_dir, &name);
    let new_note_path = if folder {
        format!("{new_root}/{INDEX_FILE}")
    } else {
        new_root.clone()
    };
    let move_needed = new_root != old_root;
    if !move_needed && params.position.is_none() {
        let txn = begin_with(vault_root, opts)?;
        let op = txn.commit(&format!("Перенос «{}»: без изменений", meta.title))?;
        return Ok((
            NoteMoveResponse {
                path_new: new_note_path,
                links_rewritten: 0,
            },
            op,
        ));
    }
    if move_needed && writer::vault_abs_path(vault_root, &new_root)?.exists() {
        return Err(VaultError::Validation(format!("путь уже занят: {new_root}")));
    }
    let notes = note_paths(index)?;
    let path_by_id: HashMap<&str, &str> = notes
        .iter()
        .map(|(id, path)| (id.as_str(), path.as_str()))
        .collect();
    let mut moved: HashMap<String, MovedNote> = HashMap::new();
    if move_needed {
        if folder {
            let prefix = format!("{old_root}/");
            for (id, path) in &notes {
                if let Some(suffix) = path.strip_prefix(&prefix) {
                    let new_path = format!("{new_root}/{suffix}");
                    moved.insert(
                        id.clone(),
                        MovedNote {
                            folder: is_folder_note(&new_path),
                            new_path,
                        },
                    );
                }
            }
        } else {
            moved.insert(
                meta.id.0.clone(),
                MovedNote {
                    new_path: new_note_path.clone(),
                    folder: false,
                },
            );
        }
    }
    if let Some((parent_id, _, parent_new)) = &promotion {
        moved.insert(
            parent_id.clone(),
            MovedNote {
                new_path: parent_new.clone(),
                folder: true,
            },
        );
    }
    let mut scan_ids: BTreeSet<String> = moved.keys().cloned().collect();
    scan_ids.insert(meta.id.0.clone());
    let (mut edits, links_rewritten) =
        rewrite_referrers(vault_root, index, &scan_ids, &path_by_id, &moved, None)?;
    if let Some(position) = params.position {
        let base = match edits.get(meta.path.as_str()) {
            Some(text) => Some(text.clone()),
            None => read_utf8(vault_root, &meta.path)?,
        };
        if let Some(text) = base {
            let (patched, _) = patch_frontmatter(
                &text,
                &FmEdit {
                    set_title: None,
                    add_alias: None,
                    set_sort: Some(position),
                },
            );
            if patched != text {
                edits.insert(meta.path.clone(), patched);
            }
        }
    }
    let mut txn = begin_with(vault_root, opts)?;
    for (rel, content) in &edits {
        txn.stage_write(rel, content.clone())?;
    }
    if let Some((_, parent_old, parent_new)) = &promotion {
        txn.stage_move(parent_old, parent_new)?;
    }
    if move_needed {
        txn.stage_move(&old_root, &new_root)?;
    }
    let destination = if parent_dir.is_empty() {
        "корень".to_string()
    } else {
        parent_dir.clone()
    };
    let op = txn.commit(&format!("Перенос «{}» → «{destination}»", meta.title))?;
    Ok((
        NoteMoveResponse {
            path_new: new_note_path,
            links_rewritten,
        },
        op,
    ))
}

/// Promotion листа в folder-note: `Заметка.md` → `Заметка/_index.md`.
/// Идентичность (`id`) и входящие ссылки сохраняются; повтор — no-op.
pub fn promote(
    vault_root: &Path,
    index: &Index,
    note_ref: &NoteRef,
    opts: &TxnOpts,
) -> Result<(String, JournalOp), VaultError> {
    let meta = resolver::resolve(index, note_ref)?;
    if is_folder_note(&meta.path) {
        let txn = begin_with(vault_root, opts)?;
        let op = txn.commit(&format!("Продвижение «{}»: уже папка", meta.title))?;
        return Ok((meta.path, op));
    }
    let dir = strip_md(&meta.path).to_string();
    let new_path = format!("{dir}/{INDEX_FILE}");
    if writer::vault_abs_path(vault_root, &new_path)?.exists() {
        return Err(VaultError::Validation(format!("путь уже занят: {new_path}")));
    }
    let notes = note_paths(index)?;
    let path_by_id: HashMap<&str, &str> = notes
        .iter()
        .map(|(id, path)| (id.as_str(), path.as_str()))
        .collect();
    let mut moved = HashMap::new();
    moved.insert(
        meta.id.0.clone(),
        MovedNote {
            new_path: new_path.clone(),
            folder: true,
        },
    );
    let scan_ids: BTreeSet<String> = moved.keys().cloned().collect();
    let (edits, _) = rewrite_referrers(vault_root, index, &scan_ids, &path_by_id, &moved, None)?;
    let mut txn = begin_with(vault_root, opts)?;
    for (rel, content) in &edits {
        txn.stage_write(rel, content.clone())?;
    }
    txn.stage_move(&meta.path, &new_path)?;
    let op = txn.commit(&format!("Продвижение «{}» в папку", meta.title))?;
    Ok((new_path, op))
}

/// Мягкое удаление (CONTRACT `note_delete`): заметка (для folder-note — вся
/// папка) уезжает в `.trash/<restore_token>/…`; входящие ссылки не трогаются.
pub fn delete(
    vault_root: &Path,
    index: &Index,
    params: &NoteDeleteParams,
    opts: &TxnOpts,
) -> Result<(NoteDeleteResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let folder = is_folder_note(&meta.path);
    if folder && folder_dir(&meta.path).is_empty() {
        return Err(VaultError::Validation(
            "нельзя удалить корневой _index.md".to_string(),
        ));
    }
    let target_rel = if folder {
        folder_dir(&meta.path).to_string()
    } else {
        meta.path.clone()
    };
    let mut deleted: BTreeSet<String> = BTreeSet::new();
    deleted.insert(meta.id.0.clone());
    if folder {
        let prefix = format!("{target_rel}/");
        for (id, path) in note_paths(index)? {
            if path.strip_prefix(&prefix).is_some() {
                deleted.insert(id);
            }
        }
    }
    let mut backlinks_broken = 0u32;
    for id in &deleted {
        for edge in resolver::backlinks(index, &NoteId(id.clone()))? {
            if !deleted.contains(&edge.src_id.0) {
                backlinks_broken += 1;
            }
        }
    }
    let token = ulid::Ulid::new().to_string();
    let mut txn = begin_with(vault_root, opts)?;
    txn.stage_trash(&target_rel, &token, &meta.path)?;
    let op = txn.commit(&format!("Удаление «{}» в корзину", meta.title))?;
    Ok((
        NoteDeleteResponse {
            restore_token: token,
            backlinks_broken,
        },
        op,
    ))
}

/// Восстановление из корзины (CONTRACT `note_restore`): ровно одно из
/// `restore_token` и `ref`, иначе `VALIDATION`. По `ref` берётся самый
/// свежий подходящий токен.
pub fn restore(
    vault_root: &Path,
    index: &Index,
    params: &NoteRestoreParams,
    opts: &TxnOpts,
) -> Result<(NoteRestoreResponse, JournalOp), VaultError> {
    let _ = index;
    let token = match (&params.restore_token, &params.r#ref) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(VaultError::Validation(
                "нужно ровно одно из restore_token и ref".to_string(),
            ));
        }
        (Some(token), None) => token.clone(),
        (None, Some(note_ref)) => find_trash_token(vault_root, note_ref)?,
    };
    let origin = writer::trash_read_origin(vault_root, &token)?;
    let mut txn = begin_with(vault_root, opts)?;
    txn.stage_restore(&token)?;
    let summary_target = origin.clone().unwrap_or_else(|| token.clone());
    let op = txn.commit(&format!("Восстановление «{summary_target}» из корзины"))?;
    let path = origin.unwrap_or_else(|| {
        op.files
            .iter()
            .find(|change| change.after.is_some())
            .map(|change| change.path.clone())
            .unwrap_or_default()
    });
    let id = read_utf8(vault_root, &path)?
        .as_deref()
        .and_then(frontmatter_id);
    let r#ref = match id {
        Some(id) => NoteRef(format!("id:{id}")),
        None => NoteRef(format!("path:{path}")),
    };
    Ok((NoteRestoreResponse { r#ref, path }, op))
}

fn begin_with(vault_root: &Path, opts: &TxnOpts) -> Result<Txn, VaultError> {
    begin(
        vault_root,
        opts.actor.clone(),
        opts.tool.clone(),
        opts.session.clone(),
    )
}

fn find_trash_token(vault_root: &Path, note_ref: &NoteRef) -> Result<String, VaultError> {
    let parsed = resolver::parse_ref(note_ref)?;
    for token in writer::trash_tokens(vault_root)? {
        let Some(origin) = writer::trash_read_origin(vault_root, &token)? else {
            continue;
        };
        let hit = match &parsed {
            ParsedRef::Path(path) => {
                resolver::normalize_key(strip_md(&origin)) == resolver::normalize_key(strip_md(path))
            }
            ParsedRef::Id(id) => {
                let trashed_rel = format!("{}/{token}/{origin}", writer::TRASH_DIR);
                read_utf8(vault_root, &trashed_rel)?
                    .as_deref()
                    .and_then(frontmatter_id)
                    .map(|found| found.eq_ignore_ascii_case(&id.0))
                    .unwrap_or(false)
            }
        };
        if hit {
            return Ok(token);
        }
    }
    Err(VaultError::NotFound(note_ref.0.clone()))
}

fn frontmatter_id(text: &str) -> Option<String> {
    let rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = rest.split('\n');
    if lines.next()?.trim_end_matches('\r') != "---" {
        return None;
    }
    for line in lines {
        let body = line.trim_end_matches('\r');
        if body == "---" || body == "..." {
            break;
        }
        if let Some(rest) = body.strip_prefix("id:") {
            let value = rest.trim().trim_matches(['"', '\'']);
            if value.chars().count() == 26 && value.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Some(value.to_ascii_uppercase());
            }
            return None;
        }
    }
    None
}

fn note_paths(index: &Index) -> Result<Vec<(String, String)>, VaultError> {
    let mut stmt = index
        .conn
        .prepare("SELECT id, path FROM notes")
        .map_err(index_err)?;
    let mut rows = stmt.query([]).map_err(index_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(index_err)? {
        let id: String = row.get(0).map_err(index_err)?;
        let path: String = row.get(1).map_err(index_err)?;
        out.push((id, path));
    }
    Ok(out)
}

fn index_err(err: rusqlite::Error) -> VaultError {
    VaultError::Index(err.to_string())
}

fn backlink_sources(index: &Index, ids: &BTreeSet<String>) -> Result<BTreeSet<String>, VaultError> {
    let mut out = BTreeSet::new();
    for id in ids {
        for edge in resolver::backlinks(index, &NoteId(id.clone()))? {
            out.insert(edge.src_id.0);
        }
    }
    Ok(out)
}

fn rewrite_referrers(
    vault_root: &Path,
    index: &Index,
    scan_ids: &BTreeSet<String>,
    path_by_id: &HashMap<&str, &str>,
    moved: &HashMap<String, MovedNote>,
    retitle: Option<&Retitle>,
) -> Result<(BTreeMap<String, String>, u32), VaultError> {
    let mut candidates = scan_ids.clone();
    for src in backlink_sources(index, scan_ids)? {
        candidates.insert(src);
    }
    let mut edits: BTreeMap<String, String> = BTreeMap::new();
    let mut rewritten = 0u32;
    for id in &candidates {
        let Some(path) = path_by_id.get(id.as_str()) else {
            continue;
        };
        let Some(text) = read_utf8(vault_root, path)? else {
            continue;
        };
        let (new_text, count) =
            rewrite_content(index, &NoteId(id.clone()), &text, moved, retitle)?;
        rewritten += count;
        if new_text != text {
            edits.insert((*path).to_string(), new_text);
        }
    }
    Ok((edits, rewritten))
}

struct MovedNote {
    new_path: String,
    folder: bool,
}

struct Retitle {
    id: String,
    old_keys: Vec<String>,
    new_title: String,
    fallback: String,
}

fn is_folder_note(path: &str) -> bool {
    path == INDEX_FILE || path.ends_with("/_index.md")
}

fn folder_dir(path: &str) -> &str {
    path.strip_suffix("/_index.md").unwrap_or("")
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")
}

fn last_segment(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn strip_md(path: &str) -> &str {
    strip_md_suffix(path).unwrap_or(path)
}

fn strip_md_suffix(path: &str) -> Option<&str> {
    if path.len() < 3 {
        return None;
    }
    let tail = path.get(path.len() - 3..)?;
    if tail.eq_ignore_ascii_case(".md") {
        path.get(..path.len() - 3)
    } else {
        None
    }
}

fn short_path_target(note_path: &str, folder: bool) -> String {
    if folder {
        folder_dir(note_path).to_string()
    } else {
        strip_md(note_path).to_string()
    }
}

fn is_root_parent(note_ref: &NoteRef) -> bool {
    note_ref
        .0
        .trim()
        .strip_prefix(resolver::REF_PATH_PREFIX)
        .map(|rest| matches!(rest.trim(), "" | "/" | "."))
        .unwrap_or(false)
}

fn rewrite_content(
    index: &Index,
    src_id: &NoteId,
    text: &str,
    moved: &HashMap<String, MovedNote>,
    retitle: Option<&Retitle>,
) -> Result<(String, u32), VaultError> {
    if moved.is_empty() && retitle.is_none() {
        return Ok((text.to_string(), 0));
    }
    let fm_end = frontmatter_end(text);
    let mut out = String::with_capacity(text.len());
    let mut total = 0u32;
    let mut fence: Option<(char, usize)> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        if start >= fm_end {
            let body = line.trim_end_matches(['\r', '\n']);
            if let Some((marker, len)) = fence_marker(body) {
                match fence {
                    None => {
                        fence = Some((marker, len));
                        out.push_str(line);
                        continue;
                    }
                    Some((open_marker, open_len)) if marker == open_marker && len >= open_len => {
                        fence = None;
                        out.push_str(line);
                        continue;
                    }
                    Some(_) => {
                        out.push_str(line);
                        continue;
                    }
                }
            }
            if fence.is_some() {
                out.push_str(line);
                continue;
            }
        }
        let (new_line, count) = rewrite_line(index, src_id, line, moved, retitle)?;
        total += count;
        out.push_str(&new_line);
    }
    Ok((out, total))
}

fn frontmatter_end(text: &str) -> usize {
    let bom_len = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let rest = &text[bom_len..];
    let mut offset = bom_len;
    let mut lines = rest.split_inclusive('\n');
    let Some(first) = lines.next() else { return 0 };
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return 0;
    }
    offset += first.len();
    for line in lines {
        offset += line.len();
        let body = line.trim_end_matches(['\r', '\n']);
        if body == "---" || body == "..." {
            return offset;
        }
    }
    0
}

fn fence_marker(body: &str) -> Option<(char, usize)> {
    let trimmed = body.trim_start();
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|&c| c == first).count();
    (run >= 3).then_some((first, run))
}

fn rewrite_line(
    index: &Index,
    src_id: &NoteId,
    line: &str,
    moved: &HashMap<String, MovedNote>,
    retitle: Option<&Retitle>,
) -> Result<(String, u32), VaultError> {
    let mut out = String::with_capacity(line.len());
    let mut count = 0u32;
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < line.len() {
        let rest = &line[i..];
        if rest.starts_with('`') {
            let run = rest.chars().take_while(|&c| c == '`').count();
            match find_backtick_close(&line[i + run..], run) {
                Some(offset) => {
                    let end = i + run + offset + run;
                    out.push_str(&line[i..end]);
                    i = end;
                }
                None => {
                    out.push_str(&line[i..i + run]);
                    i += run;
                }
            }
            continue;
        }
        let escaped = i > 0 && bytes[i - 1] == b'\\';
        if rest.starts_with("[[") && !escaped {
            if let Some(close) = rest.find("]]") {
                let inner = &rest[2..close];
                let (new_inner, rewritten) = rewrite_span(index, src_id, inner, moved, retitle)?;
                out.push_str("[[");
                out.push_str(&new_inner);
                out.push_str("]]");
                if rewritten {
                    count += 1;
                }
                i += close + 2;
                continue;
            }
            out.push_str(rest);
            break;
        }
        let c = rest.chars().next().unwrap_or('\u{0}');
        out.push(c);
        i += c.len_utf8().max(1);
    }
    Ok((out, count))
}

fn find_backtick_close(s: &str, run_len: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if i - start == run_len {
                return Some(start);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn rewrite_span(
    index: &Index,
    src_id: &NoteId,
    inner: &str,
    moved: &HashMap<String, MovedNote>,
    retitle: Option<&Retitle>,
) -> Result<(String, bool), VaultError> {
    let parsed = resolver::parse_wikilink_target(inner);
    if parsed.target.is_empty() || parsed.target.starts_with(resolver::REF_ID_PREFIX) {
        return Ok((inner.to_string(), false));
    }
    let resolved = match resolver::resolve_wikilink(index, src_id, inner) {
        Ok(found) => found,
        Err(VaultError::Ambiguous { .. }) => None,
        Err(err) => return Err(err),
    };
    let Some(dst) = resolved else {
        return Ok((inner.to_string(), false));
    };
    let path_form = parsed.target.contains('/') || parsed.target.contains('\\');
    let new_target = if path_form {
        let Some(note) = moved.get(&dst.0) else {
            return Ok((inner.to_string(), false));
        };
        rebuild_path_target(&parsed.target, note)
    } else {
        let Some(rt) = retitle else {
            return Ok((inner.to_string(), false));
        };
        if dst.0 != rt.id || !rt.old_keys.contains(&resolver::normalize_key(&parsed.target)) {
            return Ok((inner.to_string(), false));
        }
        title_target(rt)
    };
    let (_, tail) = split_target(inner);
    Ok((format!("{new_target}{tail}"), true))
}

fn split_target(inner: &str) -> (&str, &str) {
    let mut skip_next = false;
    for (i, c) in inner.char_indices() {
        if skip_next {
            skip_next = false;
            continue;
        }
        match c {
            '\\' => skip_next = true,
            '#' | '|' => return (&inner[..i], &inner[i..]),
            _ => {}
        }
    }
    (inner, "")
}

fn rebuild_path_target(original: &str, note: &MovedNote) -> String {
    let cleaned = original.trim().replace('\\', "/");
    let sans_md = strip_md_suffix(&cleaned);
    let had_md = sans_md.is_some();
    let stem = sans_md.unwrap_or(&cleaned);
    let stem_key = resolver::normalize_key(stem);
    let had_index = stem_key.ends_with("/_index") || stem_key == "_index";
    if note.folder {
        let dir = note
            .new_path
            .strip_suffix("/_index.md")
            .unwrap_or(&note.new_path);
        match (had_index, had_md) {
            (true, true) => format!("{dir}/_index.md"),
            (true, false) => format!("{dir}/_index"),
            (false, true) => format!("{dir}.md"),
            (false, false) => dir.to_string(),
        }
    } else if had_md {
        note.new_path.clone()
    } else {
        strip_md(&note.new_path).to_string()
    }
}

fn title_target(rt: &Retitle) -> String {
    let title = &rt.new_title;
    if title.contains('/')
        || title.contains('\\')
        || title.contains('#')
        || title.starts_with(resolver::REF_ID_PREFIX)
    {
        return rt.fallback.clone();
    }
    title.replace('|', "\\|")
}

struct FmEdit<'a> {
    set_title: Option<&'a str>,
    add_alias: Option<&'a str>,
    set_sort: Option<f64>,
}

fn line_body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn replace_line_body(line: &mut String, new_body: &str) {
    let ending = line[line_body(line).len()..].to_string();
    *line = format!("{new_body}{ending}");
}

fn find_key_line(lines: &[String], key: &str) -> Option<usize> {
    lines.iter().position(|line| {
        let body = line_body(line);
        match body.strip_prefix(key).and_then(|rest| rest.strip_prefix(':')) {
            Some(rest) => rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t'),
            None => false,
        }
    })
}

fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn flow_items(after: &str) -> Vec<String> {
    let open = after.find('[').map(|i| i + 1).unwrap_or(0);
    let close = after.rfind(']').unwrap_or(after.len()).max(open);
    let inner = &after[open..close];
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in inner.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    current.push(c);
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                ',' => {
                    let item = current.trim().to_string();
                    if !item.is_empty() {
                        items.push(item);
                    }
                    current.clear();
                }
                _ => current.push(c),
            },
        }
    }
    let item = current.trim().to_string();
    if !item.is_empty() {
        items.push(item);
    }
    items
}

fn patch_frontmatter(text: &str, edit: &FmEdit) -> (String, bool) {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (bom, rest) = match text.strip_prefix('\u{feff}') {
        Some(stripped) => ("\u{feff}", stripped),
        None => ("", text),
    };
    let mut lines: Vec<String> = rest.split_inclusive('\n').map(str::to_string).collect();
    let has_fm = lines
        .first()
        .map(|line| line_body(line) == "---")
        .unwrap_or(false);
    let close_idx = if has_fm {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| {
                let body = line_body(line);
                body == "---" || body == "..."
            })
            .map(|(i, _)| i)
    } else {
        None
    };
    let Some(mut close) = close_idx else {
        let mut block = format!("---{eol}");
        if let Some(title) = edit.set_title {
            block.push_str(&format!("title: {}{eol}", yaml_quote(title)));
        }
        let alias_added = edit.add_alias.is_some();
        if let Some(alias) = edit.add_alias {
            block.push_str(&format!("aliases: [{}]{eol}", yaml_quote(alias)));
        }
        if let Some(sort) = edit.set_sort {
            block.push_str(&format!("sort: {sort}{eol}"));
        }
        block.push_str(&format!("---{eol}"));
        return (format!("{bom}{block}{rest}"), alias_added);
    };
    if let Some(title) = edit.set_title {
        let new_body = format!("title: {}", yaml_quote(title));
        match find_key_line(&lines[1..close], "title").map(|i| i + 1) {
            Some(i) => replace_line_body(&mut lines[i], &new_body),
            None => {
                lines.insert(1, format!("{new_body}{eol}"));
                close += 1;
            }
        }
    }
    let mut alias_added = false;
    if let Some(alias) = edit.add_alias {
        alias_added = add_alias_line(&mut lines, &mut close, alias, eol);
    }
    if let Some(sort) = edit.set_sort {
        let new_body = format!("sort: {sort}");
        match find_key_line(&lines[1..close], "sort").map(|i| i + 1) {
            Some(i) => replace_line_body(&mut lines[i], &new_body),
            None => {
                lines.insert(close, format!("{new_body}{eol}"));
            }
        }
    }
    (format!("{bom}{}", lines.concat()), alias_added)
}

fn add_alias_line(lines: &mut Vec<String>, close: &mut usize, alias: &str, eol: &str) -> bool {
    let key = resolver::normalize_key(alias);
    let quoted = yaml_quote(alias);
    let Some(idx) = find_key_line(&lines[1..*close], "aliases").map(|i| i + 1) else {
        let anchor = find_key_line(&lines[1..*close], "title")
            .map(|i| i + 2)
            .unwrap_or(1);
        lines.insert(anchor, format!("aliases: [{quoted}]{eol}"));
        *close += 1;
        return true;
    };
    let body = line_body(&lines[idx]).to_string();
    let after = body
        .split_once(':')
        .map(|(_, rest)| rest.trim())
        .unwrap_or("");
    if after.starts_with('[') {
        if flow_items(after)
            .iter()
            .any(|item| resolver::normalize_key(item) == key)
        {
            return false;
        }
        let Some(open) = body.find('[') else {
            return false;
        };
        let Some(close_bracket) = body.rfind(']') else {
            return false;
        };
        let inside = body[open + 1..close_bracket].trim_end();
        let new_body = if inside.trim().is_empty() {
            format!("{}{quoted}{}", &body[..open + 1], &body[close_bracket..])
        } else {
            format!(
                "{}{inside}, {quoted}{}",
                &body[..open + 1],
                &body[close_bracket..]
            )
        };
        replace_line_body(&mut lines[idx], &new_body);
        return true;
    }
    if after.is_empty() {
        let mut j = idx + 1;
        let mut items_end = idx + 1;
        let mut item_indent: Option<String> = None;
        while j < *close {
            let body = line_body(&lines[j]).to_string();
            let trimmed = body.trim_start();
            if trimmed.starts_with("- ") || trimmed == "-" {
                if item_indent.is_none() {
                    item_indent = Some(body[..body.len() - trimmed.len()].to_string());
                }
                let value = trimmed.trim_start_matches('-').trim().trim_matches(['"', '\'']);
                if resolver::normalize_key(value) == key {
                    return false;
                }
                items_end = j + 1;
                j += 1;
            } else {
                break;
            }
        }
        match item_indent {
            Some(indent) => {
                lines.insert(items_end, format!("{indent}- {quoted}{eol}"));
                *close += 1;
            }
            None => replace_line_body(&mut lines[idx], &format!("aliases: [{quoted}]")),
        }
        return true;
    }
    if resolver::normalize_key(after.trim_matches(['"', '\''])) == key {
        return false;
    }
    replace_line_body(&mut lines[idx], &format!("aliases: [{after}, {quoted}]"));
    true
}
