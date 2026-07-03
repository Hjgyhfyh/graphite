//! Чтение и агрегаты поверх индекса (SPEC §5): поиск, связи, задачи,
//! отметка выполнения, активность из журнала.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{
    ActivityGetParams, ActivityGetResponse, JournalOp, LinksGetParams, LinksGetResponse, NoteId,
    NoteMeta, NoteRef, NoteType, PlanProgressBrief, SearchParams, SearchResponse, TaskCheckParams,
    TaskCheckResponse, TaskHit, TaskItem, TaskSource, TaskStatus, TaskStatusFilter,
    TasksQueryParams, TasksQueryResponse,
};
use crate::txn::{self, TxnOpts};
use crate::{parser, writer};

/// Полнотекстовый поиск с фильтрами (через индекс).
pub fn search(
    root: &Path,
    index: &Index,
    params: &SearchParams,
) -> Result<SearchResponse, VaultError> {
    let _ = root;
    index.search(params)
}

/// Исходящие/входящие связи заметки (через резолвер).
pub fn links_get(
    root: &Path,
    index: &Index,
    params: &LinksGetParams,
) -> Result<LinksGetResponse, VaultError> {
    let _ = root;
    index.links_get(params)
}

/// Задачи по фильтрам scope/status/due_before/overdue/plan, включая
/// инлайновые чекбоксы по всему vault. База берётся из индекса, семантические
/// фильтры и привязка к планам вычисляются здесь для устойчивости к состоянию
/// индексатора.
pub fn tasks_query(
    root: &Path,
    index: &Index,
    params: &TasksQueryParams,
) -> Result<TasksQueryResponse, VaultError> {
    let _ = root;
    let note_by_id = notes_by_id(index)?;

    let scope = match &params.scope {
        Some(r) => Some(resolve_scope(index, r)?),
        None => None,
    };
    let plan_id = match &params.plan {
        Some(r) => Some(index.note_by_ref(r)?.id.0),
        None => None,
    };

    let all = index.all_tasks()?;

    let status = params.status.unwrap_or(TaskStatusFilter::Open);
    let due_before = params.due_before.as_deref();
    let overdue_only = params.overdue.unwrap_or(false);
    let today = today_utc();
    let limit = params
        .limit
        .unwrap_or(crate::model::limits::TASKS_LIMIT_DEFAULT) as usize;
    if limit == 0 {
        return Ok(TasksQueryResponse { tasks: Vec::new() });
    }

    let mut hits = Vec::new();
    for task in all {
        let owner = note_by_id.get(&task.note_id.0);
        if let Some(scope) = &scope {
            match owner {
                Some(meta) if scope.matches(meta) => {}
                _ => continue,
            }
        }
        if !status_pass(status, &task) {
            continue;
        }
        let plan_note_id = task_plan_note_id(&task, owner);
        if let Some(want) = &plan_id {
            if plan_note_id.as_deref() != Some(want.as_str()) {
                continue;
            }
        }
        if let Some(cutoff) = due_before {
            match &task.due {
                Some(due) if date_lt(due, cutoff) => {}
                _ => continue,
            }
        }
        if overdue_only && !is_overdue(&task, &today) {
            continue;
        }
        hits.push(TaskHit {
            id: hit_id(&task),
            text: task.text.clone(),
            done: task.done,
            due: task.due.clone(),
            priority: task.priority,
            source: TaskSource {
                r#ref: NoteRef(format!("id:{}", task.note_id.0)),
                anchor: task.anchor.clone(),
            },
            plan: plan_note_id.map(|id| NoteRef(format!("id:{id}"))),
            stage: task.stage.clone(),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(TasksQueryResponse { tasks: hits })
}

/// Отметка выполнения задач (set-семантика по anchor в файле-источнике):
/// чекбокс переключается точечной правкой одного символа состояния, все
/// правки одного файла сливаются в одну атомарную запись, вся операция — одна
/// запись журнала. Возвращает число реально изменённых задач и обновлённый
/// прогресс затронутых планов (пересчитан по свежезаписанным файлам).
pub fn task_check(
    root: &Path,
    index: &Index,
    params: &TaskCheckParams,
    opts: &TxnOpts,
) -> Result<(TaskCheckResponse, JournalOp), VaultError> {
    let all_tasks = index.all_tasks()?;
    let mut task_by_id: HashMap<&str, &TaskItem> = HashMap::new();
    for task in &all_tasks {
        if !task.id.is_empty() {
            task_by_id.entry(task.id.as_str()).or_insert(task);
        }
    }
    let note_by_id = notes_by_id(index)?;

    let mut wanted: BTreeMap<String, HashMap<TaskTarget, bool>> = BTreeMap::new();
    let mut plan_ids: BTreeSet<String> = BTreeSet::new();
    for item in &params.tasks {
        if let Some(&task) = task_by_id.get(item.id.as_str()) {
            wanted
                .entry(task.note_id.0.clone())
                .or_default()
                .insert(TaskTarget::Anchor(task.anchor.0.clone()), item.done);
            if let Some(plan_id) = task_plan_note_id(task, note_by_id.get(&task.note_id.0)) {
                plan_ids.insert(plan_id);
            }
            continue;
        }
        // Безъякорная задача адресуется синтетическим id `loc:<note>:<line>` из
        // tasks_query: отмечаем по номеру строки и проставляем якорь на лету,
        // чтобы дальше она была стабильно адресуема.
        if let Some((note_id, line)) = parse_loc_id(&item.id) {
            if !note_by_id.contains_key(&note_id) {
                continue;
            }
            wanted
                .entry(note_id.clone())
                .or_default()
                .insert(TaskTarget::Line(line), item.done);
            if let Some(task) = all_tasks
                .iter()
                .find(|t| t.note_id.0 == note_id && t.line == line)
            {
                if let Some(plan_id) = task_plan_note_id(task, note_by_id.get(&note_id)) {
                    plan_ids.insert(plan_id);
                }
            }
        }
    }

    let mut edits: Vec<(String, String)> = Vec::new();
    let mut updated = 0u32;
    for (note_id, wants) in &wanted {
        let Some(meta) = note_by_id.get(note_id) else {
            continue;
        };
        let Some(text) = read_note_text(root, &meta.path) else {
            continue;
        };
        let (new_text, changed) = toggle_file(&text, wants);
        updated += changed;
        if new_text != text {
            edits.push((meta.path.clone(), new_text));
        }
    }

    let mut transaction = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    for (rel, content) in edits {
        transaction.stage_write(&rel, content)?;
    }
    let op = transaction.commit(&format!("Отметка задач: {updated}"))?;

    let mut progress_by_plan = Vec::new();
    for plan_id in &plan_ids {
        let Some(meta) = note_by_id.get(plan_id) else {
            continue;
        };
        let Some(text) = read_note_text(root, &meta.path) else {
            continue;
        };
        let Ok(parsed) = parser::parse_note(&text) else {
            continue;
        };
        let tasks = parser::extract_tasks(&NoteId(plan_id.clone()), &parsed.body)?;
        let total = tasks
            .iter()
            .filter(|t| t.status != TaskStatus::Dropped)
            .count() as u32;
        let done = tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Done)
            .count() as u32;
        progress_by_plan.push(PlanProgressBrief {
            r#ref: NoteRef(format!("id:{plan_id}")),
            done,
            total,
        });
    }

    Ok((
        TaskCheckResponse {
            updated,
            progress_by_plan,
        },
        op,
    ))
}

/// Активность из журнала `.graphite/journal/*.jsonl` → события; фильтры
/// since/scope/actor. Журнал принимает scope только в path-форме, поэтому
/// id-`ref` заранее резолвится в путь (для folder-note — в поддерево).
pub fn activity_get(
    root: &Path,
    index: &Index,
    params: &ActivityGetParams,
) -> Result<ActivityGetResponse, VaultError> {
    let journal_dir = super::history::journal_dir(root);
    let resolved;
    let params = match &params.scope {
        Some(scope) if scope.0.trim_start().starts_with("id:") => {
            let meta = index.note_by_ref(scope)?;
            resolved = ActivityGetParams {
                scope: journal_scope_path(&meta.path).map(|p| NoteRef(format!("path:{p}"))),
                ..params.clone()
            };
            &resolved
        }
        _ => params,
    };
    history::journal::activity(&journal_dir, params).map_err(super::history::hist_err)
}

/// Карта `id → метаданные` по всем заметкам индекса.
fn notes_by_id(index: &Index) -> Result<HashMap<String, NoteMeta>, VaultError> {
    Ok(index
        .all_notes()?
        .into_iter()
        .map(|meta| (meta.id.0.clone(), meta))
        .collect())
}

/// Область охвата `tasks_query`: весь vault, поддерево папки или одна заметка.
enum Scope {
    All,
    Subtree(String),
    Note(String),
}

impl Scope {
    fn matches(&self, meta: &NoteMeta) -> bool {
        match self {
            Scope::All => true,
            Scope::Subtree(prefix) => meta.path.starts_with(prefix.as_str()),
            Scope::Note(id) => &meta.id.0 == id,
        }
    }
}

fn resolve_scope(index: &Index, r: &NoteRef) -> Result<Scope, VaultError> {
    let meta = index.note_by_ref(r)?;
    Ok(if meta.path == "_index.md" {
        Scope::All
    } else if let Some(dir) = meta.path.strip_suffix("/_index.md") {
        Scope::Subtree(format!("{dir}/"))
    } else {
        Scope::Note(meta.id.0)
    })
}

fn status_pass(filter: TaskStatusFilter, task: &TaskItem) -> bool {
    match filter {
        TaskStatusFilter::Open => matches!(task.status, TaskStatus::Todo | TaskStatus::Doing),
        TaskStatusFilter::Done => task.status == TaskStatus::Done,
        TaskStatusFilter::All => true,
    }
}

fn is_overdue(task: &TaskItem, today: &str) -> bool {
    !task.done
        && task.status != TaskStatus::Dropped
        && task.due.as_deref().is_some_and(|due| date_lt(due, today))
}

/// Идентификатор заметки-плана для задачи: явная привязка из индекса либо
/// заметка-источник, если она типа `plan`.
fn task_plan_note_id(task: &TaskItem, owner: Option<&NoteMeta>) -> Option<String> {
    if let Some(plan) = &task.plan {
        if let Some(id) = plan.0.trim().strip_prefix("id:") {
            return Some(id.to_string());
        }
    }
    let owner = owner?;
    (owner.r#type == NoteType::Plan).then(|| owner.id.0.clone())
}

/// Сравнение дат по первым 10 символам (`YYYY-MM-DD`): строгое «раньше».
fn date_lt(a: &str, b: &str) -> bool {
    let a = a.get(..10).unwrap_or(a);
    let b = b.get(..10).unwrap_or(b);
    a < b
}

fn today_utc() -> String {
    let now = writer::now_iso_utc();
    now.get(..10).unwrap_or(&now).to_string()
}

fn read_note_text(root: &Path, rel: &str) -> Option<String> {
    let abs = writer::vault_abs_path(root, rel).ok()?;
    let bytes = std::fs::read(abs).ok()?;
    String::from_utf8(bytes).ok()
}

/// Path-форма scope для журнала: folder-note → каталог поддерева, корневой
/// `_index.md` → весь vault (без фильтра), обычная заметка → её путь.
fn journal_scope_path(note_path: &str) -> Option<String> {
    if note_path == "_index.md" {
        None
    } else if let Some(dir) = note_path.strip_suffix("/_index.md") {
        Some(dir.to_string())
    } else {
        Some(note_path.to_string())
    }
}

/// Цель отметки задачи: по якорю (стабильный id) или по номеру строки
/// (для безъякорных задач, адресованных синтетическим `loc:`-id).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum TaskTarget {
    Anchor(String),
    Line(u32),
}

const LOC_ID_PREFIX: &str = "loc:";

/// Id задачи для выдачи наружу: якорь, если есть; иначе синтетический
/// `loc:<note>:<line>`, по которому `task_check` найдёт безъякорную задачу.
fn hit_id(task: &TaskItem) -> String {
    if task.id.is_empty() {
        format!("{LOC_ID_PREFIX}{}:{}", task.note_id.0, task.line)
    } else {
        task.id.clone()
    }
}

/// Разбор синтетического id `loc:<note>:<line>` → (id заметки, номер строки).
fn parse_loc_id(id: &str) -> Option<(String, u32)> {
    let rest = id.strip_prefix(LOC_ID_PREFIX)?;
    let (note_id, line) = rest.rsplit_once(':')?;
    if note_id.is_empty() {
        return None;
    }
    Some((note_id.to_string(), line.parse().ok()?))
}

/// Применяет к телу заметки набор целей (`anchor`/номер строки) → `done`,
/// переключая символ состояния чекбокса. Безъякорная строка при первом же
/// переключении получает якорь `^t-…`, становясь стабильно адресуемой.
/// Frontmatter и стиль концов строк не трогаются; возвращает новый текст и
/// число реально изменённых задач.
fn toggle_file(text: &str, wants: &HashMap<TaskTarget, bool>) -> (String, u32) {
    let Ok(parsed) = parser::parse_note(text) else {
        return (text.to_string(), 0);
    };
    let body = &text[parsed.body_offset..];
    let mut out = String::with_capacity(text.len() + 16);
    out.push_str(&text[..parsed.body_offset]);
    let mut changed = 0u32;
    let mut line_no = 0u32;
    for piece in body.split_inclusive('\n') {
        line_no += 1;
        let content = piece.trim_end_matches(['\r', '\n']);
        let ending = &piece[content.len()..];
        if let Some(checkbox) = scan_checkbox(content) {
            let by_anchor = checkbox
                .anchor
                .as_ref()
                .and_then(|anchor| wants.get(&TaskTarget::Anchor(anchor.clone())).copied());
            let desired = by_anchor.or_else(|| wants.get(&TaskTarget::Line(line_no)).copied());
            if let Some(desired) = desired {
                let current_done = matches!(checkbox.state, 'x' | 'X');
                if desired != current_done {
                    let mut line = String::with_capacity(content.len() + 12);
                    line.push_str(&content[..checkbox.state_idx]);
                    line.push(if desired { 'x' } else { ' ' });
                    line.push_str(&content[checkbox.state_idx + 1..]);
                    if by_anchor.is_none() && checkbox.anchor.is_none() {
                        let anchor = parser::generate_anchor();
                        line = format!("{} ^{}", line.trim_end(), anchor.0);
                    }
                    out.push_str(&line);
                    out.push_str(ending);
                    changed += 1;
                    continue;
                }
            }
        }
        out.push_str(piece);
    }
    (out, changed)
}

/// Позиция символа состояния и якорь строки-чекбокса (грамматика §7.1).
struct Checkbox {
    state_idx: usize,
    state: char,
    anchor: Option<String>,
}

fn scan_checkbox(content: &str) -> Option<Checkbox> {
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    match bytes[i] {
        b'-' | b'*' | b'+' => i += 1,
        b'0'..=b'9' => {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i >= bytes.len() || (bytes[i] != b'.' && bytes[i] != b')') {
                return None;
            }
            i += 1;
        }
        _ => return None,
    }
    let after_marker = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == after_marker || i + 2 >= bytes.len() || bytes[i] != b'[' || bytes[i + 2] != b']' {
        return None;
    }
    let state_idx = i + 1;
    let state = bytes[state_idx];
    if !matches!(state, b' ' | b'/' | b'x' | b'X' | b'-') {
        return None;
    }
    let after_checkbox = i + 3;
    let mut j = after_checkbox;
    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
        j += 1;
    }
    if j == after_checkbox || j >= bytes.len() {
        return None;
    }
    Some(Checkbox {
        state_idx,
        state: state as char,
        anchor: trailing_anchor_of(&content[j..]),
    })
}

fn trailing_anchor_of(rest: &str) -> Option<String> {
    let trimmed = rest.trim_end();
    let ws = trimmed.rfind(|c: char| c.is_whitespace())?;
    let sep = trimmed[ws..].chars().next()?;
    parse_anchor_token(&trimmed[ws + sep.len_utf8()..])
}

fn parse_anchor_token(token: &str) -> Option<String> {
    let ident = token.strip_prefix('^')?;
    let bytes = ident.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 {
        return None;
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return None;
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return None;
    }
    Some(ident.to_string())
}
