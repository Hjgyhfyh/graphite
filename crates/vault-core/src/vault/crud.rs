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
    let mut fm = parsed.frontmatter;
    let old = fm.status;
    fm.status = Some(params.status);
    fm.updated = Some(writer::now_iso_utc());
    let new_text = format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body);
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
        params.status.as_str(),
    );
    let op = write_note(root, opts, &path, new_text, &summary)?;
    Ok((
        SetStatusResponse {
            old,
            new: params.status,
        },
        op,
    ))
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
    let mut fm = parsed.frontmatter;
    let exists = fm
        .rel
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
    fm.rel
        .entry(rel_key.clone())
        .or_default()
        .push(make_wikilink(&to));
    fm.updated = Some(writer::now_iso_utc());
    let new_text = format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body);
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
    let mut fm = parsed.frontmatter;
    let type_filter = params.r#type.as_ref().map(|t| t.as_str().to_string());
    let mut removed = false;
    let keys: Vec<String> = fm.rel.keys().cloned().collect();
    for key in keys {
        if type_filter.as_ref().is_some_and(|want| want != &key) {
            continue;
        }
        if let Some(list) = fm.rel.get_mut(&key) {
            let before = list.len();
            list.retain(|entry| !link_points_to(index, &from.id, entry, &to.id));
            if list.len() != before {
                removed = true;
            }
        }
    }
    fm.rel.retain(|_, list| !list.is_empty());
    if !removed {
        let summary = format!("Связь «{}» → «{}» не найдена", from.title, to.title);
        let op = commit_empty(root, opts, &summary)?;
        return Ok((LinkRemoveResponse { removed: false }, op));
    }
    fm.updated = Some(writer::now_iso_utc());
    let new_text = format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body);
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
    let mut fm = parsed.frontmatter;
    set_extra_str(&mut fm.extra, "icon", params.icon.as_deref());
    set_extra_str(&mut fm.extra, "icon_color", params.color.as_deref());
    fm.extra.remove("iconColor");
    let new_text = format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body);
    let op = write_note(root, opts, &path, new_text, &format!("Иконка «{}»", meta.title))?;
    let icon = extra_str(&fm.extra, "icon");
    let color = extra_str(&fm.extra, "icon_color");
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
    let mut fm = parsed.frontmatter;
    if params.pinned {
        fm.extra
            .insert("pinned".to_string(), serde_yml::Value::Bool(true));
    } else {
        fm.extra.remove("pinned");
    }
    let new_text = format!("{}{}", parser::serialize_frontmatter(&fm)?, parsed.body);
    let summary = if params.pinned {
        format!("Закреплено «{}»", meta.title)
    } else {
        format!("Откреплено «{}»", meta.title)
    };
    let op = write_note(root, opts, &path, new_text, &summary)?;
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

fn line_diff(old: &str, new: &str) -> DiffStat {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let common = old_lines
        .iter()
        .zip(new_lines.iter())
        .filter(|(a, b)| a == b)
        .count();
    DiffStat {
        plus: new_lines.len().saturating_sub(common) as u32,
        minus: old_lines.len().saturating_sub(common) as u32,
    }
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

fn set_extra_str(extra: &mut BTreeMap<String, serde_yml::Value>, key: &str, value: Option<&str>) {
    match value {
        Some(s) if !s.trim().is_empty() => {
            extra.insert(key.to_string(), serde_yml::Value::String(s.to_string()));
        }
        _ => {
            extra.remove(key);
        }
    }
}

fn extra_str(extra: &BTreeMap<String, serde_yml::Value>, key: &str) -> Option<String> {
    extra.get(key).and_then(|v| v.as_str()).map(str::to_string)
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
