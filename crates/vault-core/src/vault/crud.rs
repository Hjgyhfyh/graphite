//! Мутации содержимого заметок (SPEC §7): точечная правка, перенос,
//! переименование, удаление/восстановление, статус, связи, иконка, пин.
//! Переносы/переименования/удаления идут через готовые транзакции `txn`
//! (переписывают ссылки, пишут журнал-операцию); правка тела/frontmatter —
//! через `parser`/`writer` внутри `txn::Txn` (rev-guard, один писатель).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{
    DiffStat, Frontmatter, JournalOp, LinkAddParams, LinkAddResponse, LinkRemoveParams,
    LinkRemoveResponse, NoteDeleteParams, NoteDeleteResponse, NoteEditOp, NoteEditParams,
    NoteEditResponse, NoteId, NoteMeta, NoteMoveParams, NoteMoveResponse, NoteRef,
    NoteRenameParams, NoteRenameResponse, NoteRestoreParams, NoteRestoreResponse, NoteType,
    Priority, RelType, SetStatusParams, SetStatusResponse, Status,
};
use crate::txn::{self, TxnOpts};
use crate::{parser, resolver, writer};

/// Параметры `set_icon`: иконка (имя lucide) и цвет во frontmatter
/// (`icon`/`icon_color`). Пустые значения снимают поле.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetIconParams {
    pub r#ref: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetIconResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Параметры `note_pin`: значение frontmatter `pinned`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePinParams {
    pub r#ref: NoteRef,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePinResponse {
    pub pinned: bool,
}

/// Точечная правка (ops replace/append_section/replace_section/prepend/
/// set_frontmatter) под rev-guard; `old_string` обязан встречаться один раз.
pub fn note_edit(
    root: &Path,
    index: &Index,
    params: &NoteEditParams,
    opts: &TxnOpts,
) -> Result<(NoteEditResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let path = meta.path.clone();
    let raw = read_note(root, &path)?;
    let current = writer::compute_rev(raw.as_bytes());
    if current.0 != params.rev.0 {
        return Err(VaultError::Conflict {
            path,
            current_rev: current,
            diff: None,
        });
    }
    let mut text = raw.clone();
    for op in &params.ops {
        text = apply_edit_op(&text, op)?;
    }
    let rev_new = writer::compute_rev(text.as_bytes());
    let diff_stat = line_diff(&raw, &text);
    let summary = edit_summary(&meta.title, &params.ops);
    let op = write_note(root, opts, &path, text, &summary)?;
    Ok((NoteEditResponse { rev_new, diff_stat }, op))
}

/// Перенос заметки под нового родителя (через `txn::mv`).
pub fn note_move(
    root: &Path,
    index: &Index,
    params: &NoteMoveParams,
    opts: &TxnOpts,
) -> Result<(NoteMoveResponse, JournalOp), VaultError> {
    txn::mv(root, index, params, opts)
}

/// Переименование заметки (через `txn::rename`).
pub fn note_rename(
    root: &Path,
    index: &Index,
    params: &NoteRenameParams,
    opts: &TxnOpts,
) -> Result<(NoteRenameResponse, JournalOp), VaultError> {
    txn::rename(root, index, params, opts)
}

/// Мягкое удаление в `.trash` (через `txn::delete`).
pub fn note_delete(
    root: &Path,
    index: &Index,
    params: &NoteDeleteParams,
    opts: &TxnOpts,
) -> Result<(NoteDeleteResponse, JournalOp), VaultError> {
    txn::delete(root, index, params, opts)
}

/// Восстановление из корзины (через `txn::restore`).
pub fn note_restore(
    root: &Path,
    index: &Index,
    params: &NoteRestoreParams,
    opts: &TxnOpts,
) -> Result<(NoteRestoreResponse, JournalOp), VaultError> {
    txn::restore(root, index, params, opts)
}

/// Смена статуса заметки (валидация словаря §6.3). Статус приходит уже как
/// член словаря `Status`; запись во frontmatter обновляет `updated`.
pub fn set_status(
    root: &Path,
    index: &Index,
    params: &SetStatusParams,
    opts: &TxnOpts,
) -> Result<(SetStatusResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let path = meta.path.clone();
    let raw = read_note(root, &path)?;
    let parsed = parser::parse_note(&raw)?;
    ensure_frontmatter_ok(&parsed)?;
    let old = parsed.frontmatter.status;
    let status = params.status;
    let now = writer::now_iso_utc();
    let mut target = parsed.frontmatter.clone();
    target.status = Some(status);
    target.updated = Some(now.clone());
    let edits = [
        (
            "status",
            FmSet::Set(render_key_lines(|f| f.status = Some(status))?),
        ),
        (
            "updated",
            FmSet::Set(render_key_lines(|f| f.updated = Some(now.clone()))?),
        ),
    ];
    let new_text = patch_or_serialize(&raw, &parsed, &target, &edits)?;
    let reason = params
        .reason
        .as_deref()
        .filter(|r| !r.trim().is_empty())
        .map(|r| format!(" ({r})"))
        .unwrap_or_default();
    let summary = format!(
        "Статус «{}»: {} → {}{reason}",
        meta.title,
        old.map(Status::as_str).unwrap_or("—"),
        status.as_str(),
    );
    let op = write_note(root, opts, &path, new_text, &summary)?;
    Ok((SetStatusResponse { old, new: status }, op))
}

/// Добавление типизированной связи в frontmatter `rel:` (set-семантика).
pub fn link_add(
    root: &Path,
    index: &Index,
    params: &LinkAddParams,
    opts: &TxnOpts,
) -> Result<(LinkAddResponse, JournalOp), VaultError> {
    let from = resolver::resolve(index, &params.from)?;
    let to = resolver::resolve(index, &params.to)?;
    let rel = params.r#type.clone().unwrap_or(RelType::Related);
    let rel_key = rel.as_str().to_string();
    let path = from.path.clone();
    let raw = read_note(root, &path)?;
    let parsed = parser::parse_note(&raw)?;
    ensure_frontmatter_ok(&parsed)?;
    let mut rel_map = parsed.frontmatter.rel.clone();
    let exists = rel_map
        .get(&rel_key)
        .map(|list| {
            list.iter()
                .any(|entry| link_points_to(index, &from.id, entry, &to.id))
        })
        .unwrap_or(false);
    if exists {
        let summary = format!(
            "Связь {rel_key}: «{}» → «{}» (уже была)",
            from.title, to.title
        );
        let op = commit_empty(root, opts, &summary)?;
        return Ok((LinkAddResponse { created: false }, op));
    }
    rel_map
        .entry(rel_key.clone())
        .or_default()
        .push(make_wikilink(&to));
    let now = writer::now_iso_utc();
    let mut target = parsed.frontmatter.clone();
    target.rel = rel_map.clone();
    target.updated = Some(now.clone());
    let edits = [
        ("rel", rel_edit(&rel_map)?),
        (
            "updated",
            FmSet::Set(render_key_lines(|f| f.updated = Some(now.clone()))?),
        ),
    ];
    let new_text = patch_or_serialize(&raw, &parsed, &target, &edits)?;
    let summary = format!("Связь {rel_key}: «{}» → «{}»", from.title, to.title);
    let op = write_note(root, opts, &path, new_text, &summary)?;
    Ok((LinkAddResponse { created: true }, op))
}

/// Снятие связи из frontmatter `rel:` (set-семантика). Без `type` снимает
/// связь с целью во всех типах отношений.
pub fn link_remove(
    root: &Path,
    index: &Index,
    params: &LinkRemoveParams,
    opts: &TxnOpts,
) -> Result<(LinkRemoveResponse, JournalOp), VaultError> {
    let from = resolver::resolve(index, &params.from)?;
    let to = resolver::resolve(index, &params.to)?;
    let path = from.path.clone();
    let raw = read_note(root, &path)?;
    let parsed = parser::parse_note(&raw)?;
    ensure_frontmatter_ok(&parsed)?;
    let mut rel_map = parsed.frontmatter.rel.clone();
    let type_filter = params.r#type.as_ref().map(|t| t.as_str().to_string());
    let mut removed = false;
    let keys: Vec<String> = rel_map.keys().cloned().collect();
    for key in keys {
        if type_filter.as_ref().is_some_and(|want| want != &key) {
            continue;
        }
        if let Some(list) = rel_map.get_mut(&key) {
            let before = list.len();
            list.retain(|entry| !link_points_to(index, &from.id, entry, &to.id));
            if list.len() != before {
                removed = true;
            }
        }
    }
    rel_map.retain(|_, list| !list.is_empty());
    if !removed {
        let summary = format!("Связь «{}» → «{}» не найдена", from.title, to.title);
        let op = commit_empty(root, opts, &summary)?;
        return Ok((LinkRemoveResponse { removed: false }, op));
    }
    let now = writer::now_iso_utc();
    let mut target = parsed.frontmatter.clone();
    target.rel = rel_map.clone();
    target.updated = Some(now.clone());
    let edits = [
        ("rel", rel_edit(&rel_map)?),
        (
            "updated",
            FmSet::Set(render_key_lines(|f| f.updated = Some(now.clone()))?),
        ),
    ];
    let new_text = patch_or_serialize(&raw, &parsed, &target, &edits)?;
    let summary = format!("Снята связь: «{}» → «{}»", from.title, to.title);
    let op = write_note(root, opts, &path, new_text, &summary)?;
    Ok((LinkRemoveResponse { removed: true }, op))
}

/// Иконка и цвет заметки во frontmatter (`icon`/`icon_color`). Пустые значения
/// снимают соответствующее поле; косметическая правка не двигает `updated`.
pub fn set_icon(
    root: &Path,
    index: &Index,
    params: &SetIconParams,
    opts: &TxnOpts,
) -> Result<(SetIconResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let path = meta.path.clone();
    let raw = read_note(root, &path)?;
    let parsed = parser::parse_note(&raw)?;
    ensure_frontmatter_ok(&parsed)?;
    let icon = clean_opt(params.icon.as_deref());
    let color = clean_opt(params.color.as_deref());
    let mut target = parsed.frontmatter.clone();
    apply_extra_opt(&mut target.extra, "icon", icon.as_deref());
    apply_extra_opt(&mut target.extra, "icon_color", color.as_deref());
    target.extra.remove("iconColor");
    let edits = [
        ("icon", extra_edit("icon", icon.as_deref())?),
        ("icon_color", extra_edit("icon_color", color.as_deref())?),
        ("iconColor", FmSet::Remove),
    ];
    let new_text = patch_or_serialize(&raw, &parsed, &target, &edits)?;
    let summary = format!("Иконка «{}»", meta.title);
    let op = if new_text == raw {
        commit_empty(root, opts, &summary)?
    } else {
        write_note(root, opts, &path, new_text, &summary)?
    };
    Ok((SetIconResponse { icon, color }, op))
}

/// Закрепление заметки (`pinned: true|false` во frontmatter). Снятие убирает
/// ключ; косметическая правка не двигает `updated`.
pub fn note_pin(
    root: &Path,
    index: &Index,
    params: &NotePinParams,
    opts: &TxnOpts,
) -> Result<(NotePinResponse, JournalOp), VaultError> {
    let meta = resolver::resolve(index, &params.r#ref)?;
    let path = meta.path.clone();
    let raw = read_note(root, &path)?;
    let parsed = parser::parse_note(&raw)?;
    ensure_frontmatter_ok(&parsed)?;
    let mut target = parsed.frontmatter.clone();
    let edit = if params.pinned {
        target
            .extra
            .insert("pinned".to_string(), serde_yml::Value::Bool(true));
        FmSet::Set(render_key_lines(|f| {
            f.extra
                .insert("pinned".to_string(), serde_yml::Value::Bool(true));
        })?)
    } else {
        target.extra.remove("pinned");
        FmSet::Remove
    };
    let edits = [("pinned", edit)];
    let new_text = patch_or_serialize(&raw, &parsed, &target, &edits)?;
    let summary = if params.pinned {
        format!("Закреплено «{}»", meta.title)
    } else {
        format!("Откреплено «{}»", meta.title)
    };
    let op = if new_text == raw {
        commit_empty(root, opts, &summary)?
    } else {
        write_note(root, opts, &path, new_text, &summary)?
    };
    Ok((
        NotePinResponse {
            pinned: params.pinned,
        },
        op,
    ))
}

fn read_note(root: &Path, rel: &str) -> Result<String, VaultError> {
    let abs = writer::vault_abs_path(root, rel)?;
    match fs::read_to_string(&abs) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(VaultError::NotFound(rel.to_string()))
        }
        Err(err) => Err(err.into()),
    }
}

fn write_note(
    root: &Path,
    opts: &TxnOpts,
    rel: &str,
    content: String,
    summary: &str,
) -> Result<JournalOp, VaultError> {
    let mut txn = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    txn.stage_write(rel, content)?;
    txn.commit(summary)
}

fn commit_empty(root: &Path, opts: &TxnOpts, summary: &str) -> Result<JournalOp, VaultError> {
    txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?.commit(summary)
}

/// Реальный построчный diff (LCS): вставка/удаление строки в начале или
/// середине не рассинхронизирует хвост, поэтому plus/minus не завышаются.
fn line_diff(old: &str, new: &str) -> DiffStat {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let common = lcs_len(&old_lines, &new_lines);
    DiffStat {
        plus: new_lines.len().saturating_sub(common) as u32,
        minus: old_lines.len().saturating_sub(common) as u32,
    }
}

/// Длина наибольшей общей подпоследовательности строк (rolling-DP, O(n·m)).
fn lcs_len(a: &[&str], b: &[&str]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut curr = vec![0usize; b.len() + 1];
    for &ai in a {
        for (j, &bj) in b.iter().enumerate() {
            curr[j + 1] = if ai == bj {
                prev[j] + 1
            } else {
                curr[j].max(prev[j + 1])
            };
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// Отвергает изменение метаданных при повреждённом frontmatter: парсер при
/// битом YAML отдаёт тело целиком (`body_offset` в начало текста), и пересборка
/// продублировала бы блок `---…---`, осиротев старые поля в теле.
fn ensure_frontmatter_ok(parsed: &parser::ParsedNote) -> Result<(), VaultError> {
    if parsed.frontmatter_error.is_some() {
        return Err(VaultError::Validation(
            "frontmatter повреждён — исправьте YAML перед изменением метаданных".to_string(),
        ));
    }
    Ok(())
}

/// Правка одного ключа frontmatter в строковом виде.
enum FmSet {
    /// Заменить/вставить блок строк ключа (значение отрендерено сериализатором).
    Set(Vec<String>),
    /// Удалить ключ вместе с его отступным блоком-продолжением.
    Remove,
}

/// Патчит frontmatter точечно и сверяет результат: если строковый патч даёт
/// валидный YAML, семантически равный целевому, берётся он (порядок ключей и
/// комментарии сохранены, поля не переставлены); иначе — безопасная полная
/// пересборка через сериализатор (как раньше).
fn patch_or_serialize(
    raw: &str,
    parsed: &parser::ParsedNote,
    target: &Frontmatter,
    edits: &[(&str, FmSet)],
) -> Result<String, VaultError> {
    let patched = patch_note_frontmatter(raw, parsed.body_offset, edits);
    let faithful = match parser::parse_note(&patched) {
        Ok(reparsed) => reparsed.frontmatter_error.is_none() && &reparsed.frontmatter == target,
        Err(_) => false,
    };
    if faithful {
        Ok(patched)
    } else {
        Ok(format!(
            "{}{}",
            parser::serialize_frontmatter(target)?,
            parsed.body
        ))
    }
}

/// Строки одного ключа frontmatter ровно как их выдал бы сериализатор: строится
/// frontmatter с единственным заполненным ключом и берётся его тело.
fn render_key_lines(build: impl FnOnce(&mut Frontmatter)) -> Result<Vec<String>, VaultError> {
    let mut fm = Frontmatter::default();
    build(&mut fm);
    let serialized = parser::serialize_frontmatter(&fm)?;
    if serialized.is_empty() {
        return Ok(Vec::new());
    }
    let inner = serialized
        .strip_prefix("---\n")
        .and_then(|s| s.strip_suffix("---\n"))
        .unwrap_or(serialized.as_str());
    Ok(inner
        .trim_end_matches('\n')
        .split('\n')
        .map(str::to_string)
        .collect())
}

/// Правка `extra`-скаляра: значение → установить строку, пусто → удалить ключ.
fn extra_edit(key: &str, value: Option<&str>) -> Result<FmSet, VaultError> {
    match value {
        Some(v) => {
            let key = key.to_string();
            let value = v.to_string();
            Ok(FmSet::Set(render_key_lines(move |fm| {
                fm.extra.insert(key, serde_yml::Value::String(value));
            })?))
        }
        None => Ok(FmSet::Remove),
    }
}

/// Правка `rel:`: непустая карта → блок, пустая → удалить ключ.
fn rel_edit(rel: &BTreeMap<String, Vec<String>>) -> Result<FmSet, VaultError> {
    if rel.is_empty() {
        return Ok(FmSet::Remove);
    }
    let rel = rel.clone();
    Ok(FmSet::Set(render_key_lines(move |fm| fm.rel = rel)?))
}

fn clean_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn apply_extra_opt(extra: &mut BTreeMap<String, serde_yml::Value>, key: &str, value: Option<&str>) {
    match value {
        Some(v) => {
            extra.insert(key.to_string(), serde_yml::Value::String(v.to_string()));
        }
        None => {
            extra.remove(key);
        }
    }
}

/// Строковый патч блока `---…---`: правит только строки указанных ключей,
/// сохраняя прочие ключи, их порядок и комментарии; тело не трогается. При
/// отсутствии frontmatter `Set`-правки создают новый блок.
fn patch_note_frontmatter(raw: &str, body_offset: usize, edits: &[(&str, FmSet)]) -> String {
    let region = &raw[..body_offset];
    let body = &raw[body_offset..];
    let eol = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let (bom, rest) = match region.strip_prefix('\u{feff}') {
        Some(stripped) => ("\u{feff}", stripped),
        None => ("", region),
    };
    let mut lines: Vec<String> = rest.split_inclusive('\n').map(str::to_string).collect();
    let has_open = lines.first().map(|line| is_fm_delim(line)).unwrap_or(false);
    let close = if has_open {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| is_fm_delim(line))
            .map(|(i, _)| i)
    } else {
        None
    };
    let Some(mut close) = close else {
        let mut fresh: Vec<String> = Vec::new();
        for (_, set) in edits {
            if let FmSet::Set(block) = set {
                fresh.extend(block.iter().cloned());
            }
        }
        if fresh.is_empty() {
            return raw.to_string();
        }
        let mut out = String::with_capacity(raw.len() + 32);
        out.push_str(bom);
        out.push_str("---");
        out.push_str(eol);
        for line in &fresh {
            out.push_str(line);
            out.push_str(eol);
        }
        out.push_str("---");
        out.push_str(eol);
        out.push_str(body);
        return out;
    };
    for (key, set) in edits {
        apply_fm_edit(&mut lines, &mut close, key, set, eol);
    }
    let mut out = String::with_capacity(raw.len() + 32);
    out.push_str(bom);
    for line in &lines {
        out.push_str(line);
    }
    out.push_str(body);
    out
}

fn apply_fm_edit(lines: &mut Vec<String>, close: &mut usize, key: &str, set: &FmSet, eol: &str) {
    let found = (1..*close).find(|&i| is_top_level_key(&lines[i], key));
    match set {
        FmSet::Remove => {
            if let Some(i) = found {
                let end = fm_block_end(lines, i, *close);
                lines.drain(i..end);
                *close -= end - i;
            }
        }
        FmSet::Set(block) => {
            let new_lines: Vec<String> = block.iter().map(|b| format!("{b}{eol}")).collect();
            let added = new_lines.len();
            match found {
                Some(i) => {
                    let end = fm_block_end(lines, i, *close);
                    let removed = end - i;
                    let _: Vec<String> = lines.splice(i..end, new_lines).collect();
                    *close = *close + added - removed;
                }
                None => {
                    for (k, line) in new_lines.into_iter().enumerate() {
                        lines.insert(*close + k, line);
                    }
                    *close += added;
                }
            }
        }
    }
}

/// Индекс строки за блоком ключа: сам ключ плюс последующие отступные строки.
fn fm_block_end(lines: &[String], key_line: usize, close: usize) -> usize {
    let mut end = key_line + 1;
    while end < close {
        let body = fm_line_body(&lines[end]);
        if body.starts_with(' ') || body.starts_with('\t') {
            end += 1;
        } else {
            break;
        }
    }
    end
}

fn is_top_level_key(line: &str, key: &str) -> bool {
    let body = fm_line_body(line);
    if body.starts_with(' ') || body.starts_with('\t') {
        return false;
    }
    match body.strip_prefix(key).and_then(|rest| rest.strip_prefix(':')) {
        Some(rest) => rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t'),
        None => false,
    }
}

fn fm_line_body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

/// Разделитель frontmatter — как в парсере (`trim_end() == "---"`), допускает
/// хвостовые пробелы и любой стиль концов строк.
fn is_fm_delim(line: &str) -> bool {
    line.trim_end() == "---"
}

fn edit_summary(title: &str, ops: &[NoteEditOp]) -> String {
    let labels: Vec<String> = ops.iter().map(op_label).collect();
    if labels.is_empty() {
        return format!("Правка «{title}»");
    }
    format!("Правка «{title}»: {}", labels.join(", "))
}

fn op_label(op: &NoteEditOp) -> String {
    match op {
        NoteEditOp::Replace { .. } => "replace".to_string(),
        NoteEditOp::AppendSection { heading, .. } => {
            format!("append_section «{}»", heading.trim())
        }
        NoteEditOp::ReplaceSection { heading, .. } => {
            format!("replace_section «{}»", heading.trim())
        }
        NoteEditOp::Prepend { .. } => "prepend".to_string(),
        NoteEditOp::SetFrontmatter { key, .. } => format!("set_frontmatter {key}"),
    }
}

fn apply_edit_op(text: &str, op: &NoteEditOp) -> Result<String, VaultError> {
    match op {
        NoteEditOp::Replace {
            old_string,
            new_string,
        } => replace_once(text, old_string, new_string),
        NoteEditOp::Prepend { content } => {
            let (prefix, body) = split_body(text);
            Ok(format!("{prefix}{}", prepend_body(&body, content)))
        }
        NoteEditOp::AppendSection { heading, content } => {
            let (prefix, body) = split_body(text);
            Ok(format!("{prefix}{}", append_section_body(&body, heading, content)?))
        }
        NoteEditOp::ReplaceSection { heading, content } => {
            let (prefix, body) = split_body(text);
            Ok(format!(
                "{prefix}{}",
                replace_section_body(&body, heading, content)?
            ))
        }
        NoteEditOp::SetFrontmatter { key, value } => set_frontmatter_op(text, key, value),
    }
}

fn replace_once(text: &str, old: &str, new: &str) -> Result<String, VaultError> {
    if old.is_empty() {
        return Err(VaultError::Validation("пустой old_string".to_string()));
    }
    match text.matches(old).count() {
        1 => Ok(text.replacen(old, new, 1)),
        0 => Err(VaultError::Validation(format!(
            "old_string не найден: «{}»",
            preview(old)
        ))),
        n => Err(VaultError::Validation(format!(
            "old_string встречается {n} раз, требуется ровно один"
        ))),
    }
}

/// Делит файл на префикс (BOM + frontmatter-блок) и тело так, что
/// `prefix + body == text`. Битый/отсутствующий frontmatter → тело целиком.
fn split_body(text: &str) -> (String, String) {
    match parser::parse_note(text) {
        Ok(parsed) => (text[..parsed.body_offset].to_string(), parsed.body),
        Err(_) => (String::new(), text.to_string()),
    }
}

fn prepend_body(body: &str, content: &str) -> String {
    let block = content.trim_end_matches('\n');
    if block.is_empty() {
        return body.to_string();
    }
    if body.trim().is_empty() {
        return format!("{block}\n");
    }
    format!("{block}\n\n{}", body.trim_start_matches('\n'))
}

fn append_section_body(body: &str, heading: &str, content: &str) -> Result<String, VaultError> {
    let block = content.trim_matches('\n');
    match parser::find_section(body, heading)? {
        Some((_, end)) => {
            let head = body[..end].trim_end_matches('\n');
            let tail = &body[end..];
            if tail.is_empty() {
                Ok(format!("{head}\n\n{block}\n"))
            } else {
                Ok(format!("{head}\n\n{block}\n\n{tail}"))
            }
        }
        None => {
            let heading_line = new_heading_line(heading);
            if body.trim().is_empty() {
                Ok(format!("{heading_line}\n\n{block}\n"))
            } else {
                Ok(format!(
                    "{}\n\n{heading_line}\n\n{block}\n",
                    body.trim_end_matches('\n')
                ))
            }
        }
    }
}

fn replace_section_body(body: &str, heading: &str, content: &str) -> Result<String, VaultError> {
    let block = content.trim_matches('\n');
    match parser::find_section(body, heading)? {
        Some((start, end)) => {
            let section = &body[start..end];
            let head_len = section.find('\n').map(|i| i + 1).unwrap_or(section.len());
            let heading_line = section[..head_len].trim_end_matches('\n');
            let prefix = &body[..start];
            let tail = &body[end..];
            if tail.is_empty() {
                Ok(format!("{prefix}{heading_line}\n\n{block}\n"))
            } else {
                Ok(format!("{prefix}{heading_line}\n\n{block}\n\n{tail}"))
            }
        }
        None => Err(VaultError::NotFound(format!(
            "секция «{}» не найдена — заголовок исчез, правка не применена",
            heading.trim()
        ))),
    }
}

fn new_heading_line(heading: &str) -> String {
    let trimmed = heading.trim_start();
    let hashes: String = trimmed.chars().take_while(|&c| c == '#').collect();
    let title = trimmed.trim_start_matches('#').trim();
    if hashes.is_empty() {
        format!("## {}", title)
    } else if title.is_empty() {
        format!("## {}", heading.trim())
    } else {
        format!("{hashes} {title}")
    }
}

fn set_frontmatter_op(
    text: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<String, VaultError> {
    let parsed = parser::parse_note(text)?;
    ensure_frontmatter_ok(&parsed)?;
    let mut fm = parsed.frontmatter;
    apply_fm_key(&mut fm, key, value);
    Ok(format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body))
}

/// Кладёт `value` во frontmatter под ключом `key`, повторяя раскладку парсера:
/// зарезервированные ключи — в типизированные поля, значение неверной формы
/// или неизвестный ключ — в `extra` (мягкая валидация §6.2); `null` снимает ключ.
fn apply_fm_key(fm: &mut Frontmatter, key: &str, value: &serde_json::Value) {
    fm.extra.remove(key);
    if value.is_null() {
        clear_known(fm, key);
        return;
    }
    let y = json_to_yaml(value);
    match key {
        "id" => match y.as_str().map(str::to_string) {
            Some(s) => fm.id = Some(NoteId(s)),
            None => {
                fm.id = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "type" => match y.as_str().and_then(|s| s.parse::<NoteType>().ok()) {
            Some(t) => fm.r#type = Some(t),
            None => {
                fm.r#type = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "title" => match y.as_str().map(str::to_string) {
            Some(s) => fm.title = Some(s),
            None => {
                fm.title = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "aliases" => match as_string_list(&y) {
            Some(list) => fm.aliases = list,
            None => {
                fm.aliases.clear();
                fm.extra.insert(key.to_string(), y);
            }
        },
        "tags" => match as_string_list(&y) {
            Some(list) => fm.tags = list,
            None => {
                fm.tags.clear();
                fm.extra.insert(key.to_string(), y);
            }
        },
        "status" => match y.as_str().and_then(|s| s.parse::<Status>().ok()) {
            Some(s) => fm.status = Some(s),
            None => {
                fm.status = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "priority" => match y.as_str().and_then(|s| s.parse::<Priority>().ok()) {
            Some(p) => fm.priority = Some(p),
            None => {
                fm.priority = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "due" => route_str(&mut fm.due, key, y, &mut fm.extra),
        "scheduled" => route_str(&mut fm.scheduled, key, y, &mut fm.extra),
        "goal" => route_str(&mut fm.goal, key, y, &mut fm.extra),
        "target_date" => route_str(&mut fm.target_date, key, y, &mut fm.extra),
        "created" => route_str(&mut fm.created, key, y, &mut fm.extra),
        "updated" => route_str(&mut fm.updated, key, y, &mut fm.extra),
        "sort" => match y.as_f64() {
            Some(n) => fm.sort = Some(n),
            None => {
                fm.sort = None;
                fm.extra.insert(key.to_string(), y);
            }
        },
        "rel" => match as_rel_map(&y) {
            Some(map) => fm.rel = map,
            None => {
                fm.rel.clear();
                fm.extra.insert(key.to_string(), y);
            }
        },
        _ => {
            fm.extra.insert(key.to_string(), y);
        }
    }
}

fn route_str(
    slot: &mut Option<String>,
    key: &str,
    y: serde_yml::Value,
    extra: &mut BTreeMap<String, serde_yml::Value>,
) {
    match y.as_str().map(str::to_string) {
        Some(s) => *slot = Some(s),
        None => {
            *slot = None;
            extra.insert(key.to_string(), y);
        }
    }
}

fn clear_known(fm: &mut Frontmatter, key: &str) {
    match key {
        "id" => fm.id = None,
        "type" => fm.r#type = None,
        "title" => fm.title = None,
        "aliases" => fm.aliases.clear(),
        "tags" => fm.tags.clear(),
        "status" => fm.status = None,
        "priority" => fm.priority = None,
        "due" => fm.due = None,
        "scheduled" => fm.scheduled = None,
        "goal" => fm.goal = None,
        "target_date" => fm.target_date = None,
        "sort" => fm.sort = None,
        "created" => fm.created = None,
        "updated" => fm.updated = None,
        "rel" => fm.rel.clear(),
        _ => {}
    }
}

fn json_to_yaml(value: &serde_json::Value) -> serde_yml::Value {
    serde_yml::to_value(value).unwrap_or(serde_yml::Value::Null)
}

fn as_string_list(value: &serde_yml::Value) -> Option<Vec<String>> {
    let seq = value.as_sequence()?;
    let mut out = Vec::with_capacity(seq.len());
    for item in seq {
        out.push(item.as_str()?.to_string());
    }
    Some(out)
}

fn as_rel_map(value: &serde_yml::Value) -> Option<BTreeMap<String, Vec<String>>> {
    let mapping = value.as_mapping()?;
    let mut out = BTreeMap::new();
    for (key, targets) in mapping {
        out.insert(key.clone(), as_string_list(targets)?);
    }
    Some(out)
}

/// Проверяет, ведёт ли запись `rel:` в заметку `target`. Битая/неоднозначная
/// цель трактуется как «не та» (для set-семантики link_add/link_remove).
fn link_points_to(index: &Index, from: &NoteId, entry: &str, target: &NoteId) -> bool {
    matches!(
        resolver::resolve_wikilink(index, from, entry),
        Ok(Some(id)) if &id == target
    )
}

fn make_wikilink(meta: &NoteMeta) -> String {
    let title = meta.title.trim();
    if title.is_empty() || title.contains(['[', ']', '|', '\\', '#']) {
        format!("[[id:{}]]", meta.id.0)
    } else {
        format!("[[id:{}|{}]]", meta.id.0, title)
    }
}

fn preview(text: &str) -> String {
    let head: String = text.chars().take(40).collect();
    if text.chars().count() > 40 {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_offset(raw: &str) -> usize {
        crate::parser::parse_note(raw).unwrap().body_offset
    }

    #[test]
    fn line_diff_prepend_counts_single_line() {
        let d = line_diff("a\nb\nc", "x\na\nb\nc");
        assert_eq!((d.plus, d.minus), (1, 0));
    }

    #[test]
    fn line_diff_middle_insert_not_inflated() {
        let d = line_diff("a\nb\nc\nd", "a\nb\nZ\nc\nd");
        assert_eq!((d.plus, d.minus), (1, 0));
    }

    #[test]
    fn patch_replaces_scalar_and_keeps_order() {
        let raw = "---\nid: 01\nstatus: active\nicon: rocket\n---\nтело\n";
        let edits = [("status", FmSet::Set(vec!["status: done".to_string()]))];
        let out = patch_note_frontmatter(raw, body_offset(raw), &edits);
        assert!(out.contains("status: done"));
        assert!(out.contains("icon: rocket"));
        assert!(out.find("status:").unwrap() < out.find("icon:").unwrap());
        assert!(out.ends_with("тело\n"));
    }

    #[test]
    fn patch_preserves_comment_and_crlf() {
        let raw = "---\r\nid: 01\r\n# заметка автора\r\nstatus: active\r\n---\r\nтело\r\n";
        let edits = [("status", FmSet::Set(vec!["status: done".to_string()]))];
        let out = patch_note_frontmatter(raw, body_offset(raw), &edits);
        assert!(out.contains("# заметка автора"));
        assert!(out.contains("status: done\r\n"));
        assert!(out.ends_with("тело\r\n"));
    }

    #[test]
    fn patch_removes_key_block() {
        let raw = "---\nid: 01\npinned: true\nstatus: active\n---\nx\n";
        let edits = [("pinned", FmSet::Remove)];
        let out = patch_note_frontmatter(raw, body_offset(raw), &edits);
        assert!(!out.contains("pinned"));
        assert!(out.contains("status: active"));
    }

    #[test]
    fn patch_creates_frontmatter_when_absent() {
        let raw = "просто текст\n";
        let edits = [("pinned", FmSet::Set(vec!["pinned: true".to_string()]))];
        let out = patch_note_frontmatter(raw, body_offset(raw), &edits);
        assert!(out.starts_with("---\npinned: true\n---\n"));
        assert!(out.ends_with("просто текст\n"));
    }
}
