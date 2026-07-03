//! Планы (SPEC §7.4): заметка `type: plan`, стадии — H2, задачи — чекбоксы с
//! `^t-` якорями, связи `distilled_from` к источникам; правки под rev-guard;
//! прогресс по чекбоксам (по стадиям, overdue/stalled, ближайшие задачи).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{
    Frontmatter, JournalOp, NoteId, NoteMeta, NoteRef, NoteType, PlanCreateParams,
    PlanCreateProgress, PlanCreateResponse, PlanProgress, PlanProgressParams, PlanProgressResponse,
    PlanStageDraft, PlanUpdateOp, PlanUpdateParams, PlanUpdateResponse, Priority, RelType,
    StageProgress, Status, TaskItem, TaskStatus,
};
use crate::txn::{self, TxnOpts};
use crate::{parser, writer};

/// Создаёт план: заметка со стадиями и задачами, связи к источникам.
pub fn plan_create(
    root: &Path,
    index: &Index,
    params: &PlanCreateParams,
    opts: &TxnOpts,
) -> Result<(PlanCreateResponse, JournalOp), VaultError> {
    let (rel, content, resp) = build_plan_write(root, index, params)?;
    let mut t = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    t.stage_write(&rel, content)?;
    let op = t.commit(&format!("Создание плана «{}»", params.title.trim()))?;
    Ok((resp, op))
}

/// Стейджит новый план в переданную транзакцию (без собственного коммита),
/// чтобы источник дистилляции и созданный план писались и откатывались одной
/// операцией (SPEC §7.5).
pub(crate) fn stage_plan(
    root: &Path,
    index: &Index,
    params: &PlanCreateParams,
    tx: &mut txn::Txn,
) -> Result<PlanCreateResponse, VaultError> {
    let (rel, content, resp) = build_plan_write(root, index, params)?;
    tx.stage_write(&rel, content)?;
    Ok(resp)
}

/// Готовит запись плана без транзакции: свободный путь, frontmatter, тело со
/// стадиями и задачами, связи `distilled_from` к источникам. Возвращает
/// относительный путь, содержимое файла и ответ создания.
fn build_plan_write(
    root: &Path,
    index: &Index,
    params: &PlanCreateParams,
) -> Result<(String, String, PlanCreateResponse), VaultError> {
    let title = params.title.trim();
    let parent_dir = parent_dir_from_ref(index, params.parent.as_ref())?;
    let base = writer::sanitize_file_name(title);
    let mut rel = join_rel(&parent_dir, &format!("{base}.md"));
    let mut n = 2u32;
    while abs_join(root, &rel).exists() {
        rel = join_rel(&parent_dir, &format!("{base} {n}.md"));
        n += 1;
    }

    let now = writer::now_iso_utc();
    let goal = params.goal.trim();
    let mut fm = Frontmatter {
        id: Some(NoteId(ulid::Ulid::new().to_string())),
        r#type: Some(NoteType::Plan),
        title: Some(title.to_string()),
        status: Some(Status::Planned),
        goal: (!goal.is_empty()).then(|| goal.to_string()),
        target_date: params
            .target_date
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string),
        created: Some(now.clone()),
        updated: Some(now),
        ..Frontmatter::default()
    };
    let links = source_links(root, index, params.sources.as_deref());
    if !links.is_empty() {
        fm.rel
            .insert(RelType::DistilledFrom.as_str().to_string(), links);
    }
    let fm_text = parser::serialize_frontmatter(&fm)?;
    let (body, task_ids, total) = build_plan_body(&params.stages);
    let content = writer::normalize_lf(&format!("{fm_text}\n{body}"));

    Ok((
        rel.clone(),
        content,
        PlanCreateResponse {
            r#ref: NoteRef(format!("path:{rel}")),
            task_ids,
            progress: PlanCreateProgress { done: 0, total },
        },
    ))
}

/// Правит план: add_stage/add_task/edit_task/remove_task/reorder под rev-guard.
pub fn plan_update(
    root: &Path,
    index: &Index,
    params: &PlanUpdateParams,
    opts: &TxnOpts,
) -> Result<(PlanUpdateResponse, JournalOp), VaultError> {
    let meta = resolve_meta(root, index, &params.r#ref)?;
    let rel = meta.path.clone();
    let abs = abs_join(root, &rel);
    let raw = fs::read_to_string(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound(rel.clone()),
        _ => VaultError::from(e),
    })?;

    let cur_rev = writer::compute_rev(raw.as_bytes());
    if cur_rev.0 != params.rev.0 {
        return Err(VaultError::Conflict {
            path: rel,
            current_rev: cur_rev,
            diff: None,
        });
    }

    let parsed = parser::parse_note(&raw)?;
    if parsed.frontmatter_error.is_some() {
        return Err(VaultError::Validation(
            "frontmatter плана повреждён — почини вручную".to_string(),
        ));
    }

    let eol = detect_eol(&raw);
    let mut body = writer::normalize_lf(&parsed.body);
    for op in &params.ops {
        body = apply_plan_op(body, op)?;
    }

    let tasks = parser::extract_tasks(&meta.id, &body)?;
    let total = tasks
        .iter()
        .filter(|t| t.status != TaskStatus::Dropped)
        .count() as u32;
    let done = tasks.iter().filter(|t| t.done).count() as u32;

    let mut fm = parsed.frontmatter.clone();
    fm.updated = Some(writer::now_iso_utc());
    let fm_text = parser::serialize_frontmatter(&fm)?;
    let lf_content = if fm_text.is_empty() {
        body
    } else {
        format!("{fm_text}{body}")
    };
    let content = if eol == "\n" {
        lf_content
    } else {
        lf_content.replace('\n', eol)
    };
    let rev_new = writer::compute_rev(content.as_bytes());

    let mut t = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    t.stage_write(&rel, content)?;
    let op = t.commit(&format!("Правка плана «{}»", meta.title))?;

    Ok((
        PlanUpdateResponse {
            rev_new,
            progress: PlanCreateProgress { done, total },
        },
        op,
    ))
}

/// Прогресс по одному плану или всем активным (проценты, по стадиям,
/// overdue/stalled, ближайшие задачи).
pub fn plan_progress(
    root: &Path,
    index: &Index,
    params: &PlanProgressParams,
) -> Result<PlanProgressResponse, VaultError> {
    let stalled_days = params.stalled_days.unwrap_or(7);
    let today = today_str();
    let today_days = date_to_days(&today).unwrap_or(0);

    let targets: Vec<NoteMeta> = match &params.r#ref {
        Some(r) => vec![resolve_meta(root, index, r)?],
        None => {
            let active_only = params.all_active.unwrap_or(true);
            index
                .all_notes()
                .unwrap_or_default()
                .into_iter()
                .filter(|m| {
                    m.r#type == NoteType::Plan
                        && (!active_only
                            || matches!(m.status, Some(Status::Active) | Some(Status::Planned)))
                })
                .collect()
        }
    };

    let mut plans = Vec::new();
    for meta in targets {
        if let Some(progress) = plan_progress_one(root, &meta, &today, today_days, stalled_days)? {
            plans.push(progress);
        }
    }
    Ok(PlanProgressResponse { plans })
}

fn plan_progress_one(
    root: &Path,
    meta: &NoteMeta,
    today: &str,
    today_days: i64,
    stalled_days: u32,
) -> Result<Option<PlanProgress>, VaultError> {
    let abs = abs_join(root, &meta.path);
    let Ok(raw) = fs::read_to_string(&abs) else {
        return Ok(None);
    };
    let parsed = parser::parse_note(&raw)?;
    let plan_ref = NoteRef(format!("path:{}", meta.path));
    let mut tasks = parser::extract_tasks(&meta.id, &parsed.body)?;
    for t in &mut tasks {
        t.note_id = meta.id.clone();
        t.plan = Some(plan_ref.clone());
    }

    let counted = tasks
        .iter()
        .filter(|t| t.status != TaskStatus::Dropped)
        .count() as u32;
    let done = tasks.iter().filter(|t| t.done).count() as u32;
    let percent = if counted == 0 {
        0.0
    } else {
        (done as f32) * 100.0 / (counted as f32)
    };

    let by_stage = stage_progress(&parsed.body, &tasks)?;
    let overdue: Vec<TaskItem> = tasks
        .iter()
        .filter(|t| is_open(t) && is_overdue(t, today))
        .cloned()
        .collect();
    let stalled: Vec<TaskItem> = if note_age_days(&parsed.frontmatter, &abs, today_days) >= stalled_days as i64 {
        tasks.iter().filter(|t| is_open(t)).cloned().collect()
    } else {
        Vec::new()
    };
    let next_tasks = pick_next_tasks(&tasks, 3);

    Ok(Some(PlanProgress {
        r#ref: plan_ref,
        title: meta.title.clone(),
        percent,
        done,
        total: counted,
        by_stage,
        overdue,
        stalled,
        next_tasks,
    }))
}

fn stage_progress(body: &str, tasks: &[TaskItem]) -> Result<Vec<StageProgress>, VaultError> {
    let headings = parser::extract_headings(body)?;
    let mut out = Vec::new();
    for (pos, heading) in headings.iter().enumerate() {
        if heading.level != 2 {
            continue;
        }
        let start = heading.line;
        let end = headings[pos + 1..]
            .iter()
            .find(|h| h.level <= 2)
            .map(|h| h.line)
            .unwrap_or(u32::MAX);
        let mut done = 0u32;
        let mut total = 0u32;
        for task in tasks {
            if task.status == TaskStatus::Dropped {
                continue;
            }
            if task.line > start && task.line < end {
                total += 1;
                if task.done {
                    done += 1;
                }
            }
        }
        out.push(StageProgress {
            title: heading.text.clone(),
            done,
            total,
        });
    }
    Ok(out)
}

/// Ближайшие шаги: сначала начатые (`doing`), затем по сроку, приоритету и
/// порядку в документе; только открытые задачи, не более `limit`.
fn pick_next_tasks(tasks: &[TaskItem], limit: usize) -> Vec<TaskItem> {
    let mut open: Vec<&TaskItem> = tasks.iter().filter(|t| is_open(t)).collect();
    open.sort_by(|a, b| {
        let doing = |t: &TaskItem| (t.status != TaskStatus::Doing) as u8;
        doing(a)
            .cmp(&doing(b))
            .then_with(|| due_key(a).cmp(&due_key(b)))
            .then_with(|| prio_rank(b).cmp(&prio_rank(a)))
            .then_with(|| a.line.cmp(&b.line))
    });
    open.into_iter().take(limit).cloned().collect()
}

fn is_open(task: &TaskItem) -> bool {
    !task.done && task.status != TaskStatus::Dropped
}

fn is_overdue(task: &TaskItem, today: &str) -> bool {
    match task.due.as_deref() {
        Some(d) if is_date(d) => &d[..10] < today,
        _ => false,
    }
}

fn due_key(task: &TaskItem) -> String {
    match task.due.as_deref() {
        Some(d) if is_date(d) => d[..10].to_string(),
        _ => "\u{7e}".to_string(),
    }
}

fn prio_rank(task: &TaskItem) -> i32 {
    match task.priority {
        Some(Priority::Urgent) => 3,
        Some(Priority::High) => 2,
        Some(Priority::Normal) => 1,
        Some(Priority::Low) | None => 0,
    }
}

fn apply_plan_op(body: String, op: &PlanUpdateOp) -> Result<String, VaultError> {
    match op {
        PlanUpdateOp::AddStage { title, after } => add_stage(&body, title, after.as_deref()),
        PlanUpdateOp::AddTask { stage, text, due } => add_task(&body, stage, text, due.as_deref()),
        PlanUpdateOp::EditTask { task_id, text, due } => {
            edit_task(&body, task_id, text.as_deref(), due)
        }
        PlanUpdateOp::RemoveTask { task_id } => remove_task(&body, task_id),
        PlanUpdateOp::Reorder { order } => reorder_tasks(&body, order),
    }
}

fn add_stage(body: &str, title: &str, after: Option<&str>) -> Result<String, VaultError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(VaultError::Validation("пустой заголовок стадии".to_string()));
    }
    let lines = body_lines(body);
    let insert_at = match after {
        Some(name) => find_stage_region(body, name)?.map(|(_, end)| end),
        None => None,
    }
    .unwrap_or(lines.len())
    .min(lines.len());

    let mut out: Vec<String> = lines[..insert_at].to_vec();
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    if !out.is_empty() {
        out.push(String::new());
    }
    out.push(format!("## {title}"));
    out.push(String::new());
    let mut tail = insert_at;
    while tail < lines.len() && lines[tail].trim().is_empty() {
        tail += 1;
    }
    out.extend_from_slice(&lines[tail..]);
    Ok(out.join("\n"))
}

fn add_task(body: &str, stage: &str, text: &str, due: Option<&str>) -> Result<String, VaultError> {
    let (start, end) = find_stage_region(body, stage)?
        .ok_or_else(|| VaultError::NotFound(format!("стадия «{stage}»")))?;
    let mut lines = body_lines(body);
    let region_end = end.min(lines.len());
    let mut insert_at = (start + 1).min(region_end);
    for i in (start + 1)..region_end {
        if !lines[i].trim().is_empty() {
            insert_at = i + 1;
        }
    }
    let anchor = fresh_anchor(body);
    let line = render_task_line("", "-", ' ', text, due, None, None, &anchor);
    lines.insert(insert_at.min(lines.len()), line);
    Ok(lines.join("\n"))
}

fn edit_task(
    body: &str,
    task_id: &str,
    new_text: Option<&str>,
    new_due: &Option<String>,
) -> Result<String, VaultError> {
    let want = task_id.trim().trim_start_matches('^');
    let tasks = parser::extract_tasks(&NoteId(String::new()), body)?;
    let Some(task) = tasks.iter().find(|t| t.anchor.0 == want) else {
        return Err(VaultError::NotFound(format!("задача {task_id}")));
    };
    let mut lines = body_lines(body);
    let idx = task.line as usize - 1;
    if idx >= lines.len() {
        return Err(VaultError::NotFound(format!("задача {task_id}")));
    }
    let (indent, marker, state) = parse_task_prefix(&lines[idx])
        .ok_or_else(|| VaultError::Validation(format!("строка задачи {task_id} не распознана")))?;
    let text = new_text
        .map(str::to_string)
        .unwrap_or_else(|| task.text.clone());
    let due: Option<String> = match new_due {
        None => task.due.clone(),
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value.trim().to_string()),
    };
    lines[idx] = render_task_line(
        &indent,
        &marker,
        state,
        &text,
        due.as_deref(),
        task.priority,
        task.every.as_deref(),
        want,
    );
    Ok(lines.join("\n"))
}

fn remove_task(body: &str, task_id: &str) -> Result<String, VaultError> {
    let want = task_id.trim().trim_start_matches('^');
    let tasks = parser::extract_tasks(&NoteId(String::new()), body)?;
    let Some(task) = tasks.iter().find(|t| t.anchor.0 == want) else {
        return Err(VaultError::NotFound(format!("задача {task_id}")));
    };
    let mut lines = body_lines(body);
    let idx = task.line as usize - 1;
    if idx < lines.len() {
        lines.remove(idx);
    }
    Ok(lines.join("\n"))
}

fn reorder_tasks(body: &str, order: &[String]) -> Result<String, VaultError> {
    let headings = parser::extract_headings(body)?;
    let tasks = parser::extract_tasks(&NoteId(String::new()), body)?;
    let mut lines = body_lines(body);

    // Слот задачи: физический индекс строки, якорь и стадия (строка её H2 или
    // `None` вне стадии). Порядок слотов — документный (extract_tasks).
    let slots: Vec<(usize, String, Option<u32>)> = tasks
        .iter()
        .filter(|t| !t.anchor.0.is_empty() && (t.line as usize) <= lines.len())
        .map(|t| {
            (
                t.line as usize - 1,
                t.anchor.0.clone(),
                governing_stage_line(&headings, t.line),
            )
        })
        .collect();
    if slots.is_empty() {
        return Ok(body.to_string());
    }

    let content_by_anchor: HashMap<String, String> = slots
        .iter()
        .filter_map(|(idx, anchor, _)| lines.get(*idx).map(|line| (anchor.clone(), line.clone())))
        .collect();
    let stage_of: HashMap<&str, Option<u32>> =
        slots.iter().map(|(_, a, g)| (a.as_str(), *g)).collect();

    // Запрошенный порядок — раскладываем по стадиям, чтобы анкор нельзя было
    // перенести в чужую стадию (реордер строго внутри стадии).
    let mut requested: HashMap<Option<u32>, Vec<String>> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for id in order {
        let key = id.trim().trim_start_matches('^').to_string();
        if let Some(stage) = stage_of.get(key.as_str()) {
            if seen.insert(key.clone()) {
                requested.entry(*stage).or_default().push(key);
            }
        }
    }

    // Физические слоты по стадиям (в документном порядке).
    let mut stage_slots: HashMap<Option<u32>, Vec<(usize, String)>> = HashMap::new();
    for (idx, anchor, stage) in &slots {
        stage_slots
            .entry(*stage)
            .or_default()
            .push((*idx, anchor.clone()));
    }
    for (stage, members) in &stage_slots {
        // Новый порядок стадии: запрошенные анкоры, затем остальные в документном.
        let mut new_order: Vec<String> = Vec::with_capacity(members.len());
        let mut placed: HashSet<String> = HashSet::new();
        if let Some(req) = requested.get(stage) {
            for anchor in req {
                if placed.insert(anchor.clone()) {
                    new_order.push(anchor.clone());
                }
            }
        }
        for (_, anchor) in members {
            if placed.insert(anchor.clone()) {
                new_order.push(anchor.clone());
            }
        }
        for ((idx, _), anchor) in members.iter().zip(new_order.iter()) {
            if let Some(content) = content_by_anchor.get(anchor) {
                lines[*idx] = content.clone();
            }
        }
    }
    Ok(lines.join("\n"))
}

/// Строка H2-заголовка, управляющего задачей на строке `line_no`, либо `None`
/// вне стадии. Зеркалит parser::stage_for_line, но ключ — строка заголовка
/// (уникальна для каждого вхождения), поэтому одноимённые стадии не сливаются.
fn governing_stage_line(headings: &[parser::Heading], line_no: u32) -> Option<u32> {
    let mut current = None;
    for heading in headings {
        if heading.line >= line_no {
            break;
        }
        match heading.level {
            1 => current = None,
            2 => current = Some(heading.line),
            _ => {}
        }
    }
    current
}

/// Границы стадии по её H2-заголовку: 0-based индекс строки заголовка и
/// индекс следующего заголовка уровня ≤2 (эксклюзивный конец региона).
fn find_stage_region(body: &str, title: &str) -> Result<Option<(usize, usize)>, VaultError> {
    let headings = parser::extract_headings(body)?;
    let wanted = parser::normalize_for_compare(title);
    let Some(pos) = headings
        .iter()
        .position(|h| h.level == 2 && parser::normalize_for_compare(&h.text) == wanted)
    else {
        return Ok(None);
    };
    let start = headings[pos].line as usize - 1;
    let end = headings[pos + 1..]
        .iter()
        .find(|h| h.level <= 2)
        .map(|h| h.line as usize - 1)
        .unwrap_or_else(|| body.split('\n').count());
    Ok(Some((start, end)))
}

fn body_lines(body: &str) -> Vec<String> {
    body.split('\n').map(str::to_string).collect()
}

/// Рендер строки задачи: `отступ маркер " [" state "] " текст [@due] [@p] [@every]
/// " ^" якорь`. Приоритет и повтор сохраняются при пересборке строки, иначе
/// правка текста/срока стёрла бы их (§7.1). Пустой текст заменяется
/// плейсхолдером — иначе якорь примыкает к чекбоксу и не распознаётся.
fn render_task_line(
    indent: &str,
    marker: &str,
    state: char,
    text: &str,
    due: Option<&str>,
    priority: Option<Priority>,
    every: Option<&str>,
    anchor: &str,
) -> String {
    let mut clean = clean_inline(text);
    if clean.is_empty() {
        clean.push_str("Задача");
    }
    let mut line = String::new();
    line.push_str(indent);
    line.push_str(marker);
    line.push_str(" [");
    line.push(state);
    line.push_str("] ");
    line.push_str(&clean);
    if let Some(d) = due.map(str::trim).filter(|d| !d.is_empty()) {
        line.push_str(" @due(");
        line.push_str(d);
        line.push(')');
    }
    if let Some(p) = priority {
        line.push_str(" @p(");
        line.push_str(p.as_str());
        line.push(')');
    }
    if let Some(e) = every.map(str::trim).filter(|e| !e.is_empty()) {
        line.push_str(" @every(");
        line.push_str(e);
        line.push(')');
    }
    if !anchor.is_empty() {
        line.push_str(" ^");
        line.push_str(anchor);
    }
    line
}

fn clean_inline(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Разбор префикса строки-задачи: отступ, маркер списка и символ состояния
/// чекбокса; `None`, если строка не является задачей.
fn parse_task_prefix(line: &str) -> Option<(String, String, char)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    let indent = line[..i].to_string();
    let marker_start = i;
    match *bytes.get(i)? {
        b'-' | b'*' | b'+' => i += 1,
        b'0'..=b'9' => {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            match *bytes.get(i)? {
                b'.' | b')' => i += 1,
                _ => return None,
            }
        }
        _ => return None,
    }
    let marker = line[marker_start..i].to_string();
    let after_marker = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == after_marker {
        return None;
    }
    if *bytes.get(i)? != b'[' || *bytes.get(i + 2)? != b']' {
        return None;
    }
    let state = *bytes.get(i + 1)? as char;
    if !matches!(state, ' ' | 'x' | 'X' | '/' | '-') {
        return None;
    }
    Some((indent, marker, state))
}

fn fresh_anchor(body: &str) -> String {
    let existing: HashSet<String> = parser::extract_tasks(&NoteId(String::new()), body)
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.anchor.0)
        .collect();
    loop {
        let anchor = parser::generate_anchor().0;
        if !anchor.is_empty() && !existing.contains(&anchor) {
            return anchor;
        }
    }
}

fn build_plan_body(stages: &[PlanStageDraft]) -> (String, Vec<Vec<String>>, u32) {
    let mut used: HashSet<String> = HashSet::new();
    let mut blocks: Vec<String> = Vec::new();
    let mut task_ids: Vec<Vec<String>> = Vec::new();
    let mut total = 0u32;
    for stage in stages {
        let title = stage.title.trim();
        let title = if title.is_empty() { "Этап" } else { title };
        let mut block = format!("## {title}\n");
        let mut ids = Vec::new();
        if !stage.tasks.is_empty() {
            block.push('\n');
            for task in &stage.tasks {
                let anchor = gen_unique_anchor(&mut used);
                block.push_str(&render_task_line(
                    "",
                    "-",
                    ' ',
                    &task.text,
                    task.due.as_deref(),
                    None,
                    None,
                    &anchor,
                ));
                block.push('\n');
                ids.push(anchor);
                total += 1;
            }
        }
        blocks.push(block);
        task_ids.push(ids);
    }
    (blocks.join("\n"), task_ids, total)
}

fn gen_unique_anchor(used: &mut HashSet<String>) -> String {
    loop {
        let anchor = parser::generate_anchor().0;
        if !anchor.is_empty() && used.insert(anchor.clone()) {
            return anchor;
        }
    }
}

fn source_links(root: &Path, index: &Index, sources: Option<&[NoteRef]>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(sources) = sources else {
        return out;
    };
    for src in sources {
        let link = match resolve_meta(root, index, src) {
            Ok(meta) if !meta.id.0.is_empty() => {
                format!("[[id:{}|{}]]", meta.id.0, escape_link_alias(&meta.title))
            }
            _ => fallback_link(src),
        };
        if !link.is_empty() && !out.contains(&link) {
            out.push(link);
        }
    }
    out
}

fn fallback_link(src: &NoteRef) -> String {
    let raw = src.0.trim();
    let target = if let Some(rest) = raw.strip_prefix("path:") {
        let cleaned = rest.replace('\\', "/");
        strip_md(&cleaned).unwrap_or(&cleaned).trim_matches('/').to_string()
    } else {
        raw.to_string()
    };
    if target.is_empty() {
        String::new()
    } else {
        format!("[[{target}]]")
    }
}

/// Экранирует заголовок под алиас wiki-ссылки `[[target|alias]]`: убирает
/// переносы строк, экранирует `|` и не даёт `]]` оборвать ссылку раньше срока.
pub(crate) fn escape_link_alias(title: &str) -> String {
    let mut out = title.replace(['\n', '\r'], " ").replace('|', "\\|");
    while out.contains("]]") {
        out = out.replace("]]", "] ]");
    }
    out
}

/// Каталог-родитель для новой заметки из `ref`. `path:`-форма трактуется без
/// индекса (папка / folder-note / лист → каталог), иначе — резолв через индекс.
fn parent_dir_from_ref(index: &Index, parent: Option<&NoteRef>) -> Result<String, VaultError> {
    let Some(parent) = parent else {
        return Ok("Входящие".to_string());
    };
    let raw = parent.0.trim();
    if let Some(rest) = raw.strip_prefix("path:") {
        let cleaned = rest.replace('\\', "/");
        return Ok(dir_of_note_path(cleaned.trim_matches('/')));
    }
    let path = index.note_by_ref(parent)?.path;
    Ok(dir_of_note_path(&path))
}

fn dir_of_note_path(path: &str) -> String {
    let path = path.trim_matches('/');
    if let Some(dir) = path.strip_suffix("/_index.md") {
        dir.to_string()
    } else if path.eq_ignore_ascii_case("_index.md") {
        String::new()
    } else if let Some(stem) = strip_md(path) {
        stem.to_string()
    } else {
        path.to_string()
    }
}

/// Резолв `ref` → метаданные. Для `path:`-формы читается напрямую с диска
/// (без индекса), иначе делегируется резолверу поверх индекса.
fn resolve_meta(root: &Path, index: &Index, r: &NoteRef) -> Result<NoteMeta, VaultError> {
    let raw = r.0.trim();
    if let Some(rest) = raw.strip_prefix("path:") {
        let cleaned = rest.replace('\\', "/");
        let rel = cleaned.trim_matches('/');
        if !rel.is_empty() {
            if abs_join(root, rel).is_file() {
                return meta_from_file(root, rel);
            }
            let index_rel = format!("{rel}/_index.md");
            if abs_join(root, &index_rel).is_file() {
                return meta_from_file(root, &index_rel);
            }
        }
    }
    index.note_by_ref(r)
}

fn meta_from_file(root: &Path, rel: &str) -> Result<NoteMeta, VaultError> {
    let abs = abs_join(root, rel);
    let raw = fs::read_to_string(&abs)?;
    let parsed = parser::parse_note(&raw)?;
    let fm = parsed.frontmatter;
    Ok(NoteMeta {
        id: fm.id.clone().unwrap_or_else(|| NoteId(String::new())),
        path: rel.to_string(),
        title: fm
            .title
            .clone()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| file_stem(rel)),
        r#type: fm.r#type.unwrap_or(NoteType::Note),
        status: fm.status,
        tags: fm.tags.clone(),
        updated: fm.updated.clone().unwrap_or_default(),
        rev: writer::compute_rev(raw.as_bytes()),
        children_count: 0,
    })
}

fn file_stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let stem = strip_md(name).unwrap_or(name);
    if stem.eq_ignore_ascii_case("_index") {
        rel.rsplit('/').nth(1).unwrap_or("").to_string()
    } else {
        stem.to_string()
    }
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn abs_join(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in rel.split('/') {
        if !segment.is_empty() && segment != "." {
            path.push(segment);
        }
    }
    path
}

fn strip_md(path: &str) -> Option<&str> {
    let n = path.len();
    if n >= 3 && path.as_bytes()[n - 3..].eq_ignore_ascii_case(b".md") {
        Some(&path[..n - 3])
    } else {
        None
    }
}

/// Стиль концов строк исходника: `\r\n`, если он встречается, иначе `\n`.
fn detect_eol(raw: &str) -> &'static str {
    if raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn today_str() -> String {
    writer::now_iso_utc().chars().take(10).collect()
}

fn is_date(value: &str) -> bool {
    parse_ymd(value).is_some()
}

fn note_age_days(fm: &Frontmatter, abs: &Path, today_days: i64) -> i64 {
    let recorded = fm
        .updated
        .as_deref()
        .or(fm.created.as_deref())
        .and_then(date_to_days)
        .or_else(|| file_mtime_days(abs));
    match recorded {
        Some(days) => (today_days - days).max(0),
        None => 0,
    }
}

fn file_mtime_days(abs: &Path) -> Option<i64> {
    let modified = fs::metadata(abs).ok()?.modified().ok()?;
    let secs = modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(secs / 86_400)
}

fn date_to_days(value: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(value)?;
    Some(days_from_civil(y, m, d))
}

fn parse_ymd(value: &str) -> Option<(i64, u32, u32)> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
