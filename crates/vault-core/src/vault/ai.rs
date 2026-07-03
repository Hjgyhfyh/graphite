//! Сборка контекста для ассистента (SPEC §7.5): дистилляция, брифинг,
//! бандлы (основной-инструкция + второстепенные) и эвристика «идея → задачи».
//! ИИ здесь не вызывается — только детерминированный сбор и парсинг; улучшение
//! текста делает ассистент через MCP.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::limits::{DISTILL_BUDGET_CHARS_DEFAULT, STALLED_DAYS_DEFAULT};
use crate::model::{
    BundleItem, BundleRole, ContextBriefingResponse, DistillContextParams, DistillContextResponse,
    DistillSaveParams, DistillSaveResponse, DistillSections, DistillTargetStatus, Frontmatter,
    JournalOp, NextStep, NoteId, NoteMeta, NoteRef, NoteType, PlanCreateParams, PlanProgressParams,
    PlanStageDraft, PlanTaskDraft, Priority, RelType, Rev, StalledNote, Status, TaskItem,
};
use crate::txn::{self, TxnOpts};
use crate::{parser, writer};

/// Ограничения сбора дистилляции: сколько связанных/соседей брать и потолок
/// длины выдержки не-исходной заметки в символах.
const MAX_LINKED_EXCERPTS: usize = 12;
const MAX_NEIGHBOR_EXCERPTS: usize = 8;
const OTHER_EXCERPT_CAP: usize = 1500;

/// Карта пробелов: ключ ответа `distill_context` → нормализуемые заголовки,
/// присутствие любого из которых закрывает пробел (SPEC §1.4/§7.5).
const GAP_SPECS: [(&str, &[&str]); 4] = [
    ("goal", &["цель"]),
    ("why", &["зачем"]),
    ("done_criteria", &["критерии готовности", "критерии"]),
    ("first_step", &["первый шаг", "план"]),
];

/// Текст инструкции по умолчанию для главного файла бандла.
const DEFAULT_BUNDLE_INSTRUCTION: &str = "Этот файл — главный в бандле: он собирает второстепенные заметки в одну коллекцию и служит для них инструкцией. Читай состав бандла ниже вместе с этим текстом.";

/// Параметры `bundle_compose`: основной `ref`, тянуть ли связанные, лимит.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleComposeParams {
    pub r#ref: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_linked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
}

/// Один участник собранного бандла с путём и ролью.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleComposeMember {
    pub r#ref: NoteRef,
    pub title: String,
    pub path: String,
    pub role: BundleRole,
    pub chars: u32,
}

/// Результат `bundle_compose`: единый ИИ-дружественный markdown и состав.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleComposeResponse {
    pub text: String,
    pub members: Vec<BundleComposeMember>,
    pub chars: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// Параметры `bundle_create`: заголовок основной заметки-инструкции,
/// родитель, состав второстепенных, текст инструкции.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCreateParams {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<NoteRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

/// Результат `bundle_create`: созданная заметка-бандл и число прикреплённых.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCreateResponse {
    pub r#ref: NoteRef,
    pub path: String,
    pub rev: Rev,
    pub added: u32,
}

/// Черновик задачи из эвристики «идея → задачи».
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaToTaskDraft {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
}

/// Параметры `idea_to_tasks`: источник (`ref` или сырой `text`) и флаг плана.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaToTasksParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_plan: Option<bool>,
}

/// Результат `idea_to_tasks`: черновики задач и, опционально, созданный план.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaToTasksResponse {
    pub tasks: Vec<IdeaToTaskDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_ref: Option<NoteRef>,
}

/// Сбор контекста заметки под бюджет: источник + связанные + соседи,
/// карта пробелов (Цель/Зачем/Критерии/Первый шаг) и покрытие.
pub fn distill_context(
    root: &Path,
    index: &Index,
    params: &DistillContextParams,
) -> Result<DistillContextResponse, VaultError> {
    let source = index.note_by_ref(&params.r#ref)?;
    let budget = params
        .budget_chars
        .map(|b| b as usize)
        .unwrap_or(DISTILL_BUDGET_CHARS_DEFAULT as usize);

    let (_, src_body) = read_note_body(root, &source.path)?;
    let gaps = compute_gaps(&src_body)?;
    let coverage = (GAP_SPECS.len() - gaps.len()) as f32 / GAP_SPECS.len() as f32;

    let mut bundle: Vec<BundleItem> = Vec::new();
    let mut used = 0usize;
    let mut seen: HashSet<NoteId> = HashSet::new();
    seen.insert(source.id.clone());

    let source_cap = ((budget * 3) / 5).max(2000).min(budget.max(1));
    push_excerpt(
        &mut bundle,
        &mut used,
        budget,
        &source,
        BundleRole::Source,
        &src_body,
        source_cap,
    );

    let mut linked_ids: Vec<NoteId> = Vec::new();
    for edge in index.outgoing(&source.id)? {
        if let Some(dst) = &edge.dst_id {
            if seen.insert(dst.clone()) {
                linked_ids.push(dst.clone());
            }
        }
    }
    for edge in index.backlinks(&source.id)? {
        if seen.insert(edge.src_id.clone()) {
            linked_ids.push(edge.src_id.clone());
        }
    }
    for id in linked_ids.iter().take(MAX_LINKED_EXCERPTS) {
        if used >= budget {
            break;
        }
        if let Some(meta) = index.note_by_id(id)? {
            if let Ok((_, body)) = read_note_body(root, &meta.path) {
                push_excerpt(
                    &mut bundle,
                    &mut used,
                    budget,
                    &meta,
                    BundleRole::Linked,
                    &body,
                    OTHER_EXCERPT_CAP,
                );
            }
        }
    }

    if used < budget {
        let src_dir = file_dir(&source.path).to_string();
        let mut neighbors = 0usize;
        for meta in index.all_notes()? {
            if used >= budget || neighbors >= MAX_NEIGHBOR_EXCERPTS {
                break;
            }
            if seen.contains(&meta.id) || file_dir(&meta.path) != src_dir {
                continue;
            }
            seen.insert(meta.id.clone());
            if let Ok((_, body)) = read_note_body(root, &meta.path) {
                if push_excerpt(
                    &mut bundle,
                    &mut used,
                    budget,
                    &meta,
                    BundleRole::Neighbor,
                    &body,
                    OTHER_EXCERPT_CAP,
                ) {
                    neighbors += 1;
                }
            }
        }
    }

    Ok(DistillContextResponse {
        bundle,
        gaps,
        coverage,
    })
}

/// Запись секций дистилляции в заметку (обязательные цель/зачем/критерии),
/// опционально статус и создание плана. Мутация — пишет журнал-операцию.
pub fn distill_save(
    root: &Path,
    index: &Index,
    params: &DistillSaveParams,
    opts: &TxnOpts,
) -> Result<(DistillSaveResponse, JournalOp), VaultError> {
    let source = index.note_by_ref(&params.r#ref)?;

    require_nonempty(&params.sections.goal, "цель")?;
    require_nonempty(&params.sections.why, "зачем")?;
    require_nonempty(&params.sections.done_criteria, "критерии_готовности")?;

    let plan_params = if params.create_plan.unwrap_or(false) {
        Some(build_plan_params(&source, &params.sections)?)
    } else {
        None
    };

    let abs = writer::vault_abs_path(root, &source.path)?;
    let raw = std::fs::read_to_string(&abs)?;
    let current_rev = writer::compute_rev(raw.as_bytes());
    if current_rev != params.rev {
        return Err(VaultError::Conflict {
            path: source.path.clone(),
            current_rev,
            diff: None,
        });
    }

    let eol = detect_eol(&raw);
    let parsed = parser::parse_note(&raw)?;
    let mut fm = parsed.frontmatter.clone();
    let new_body = apply_sections(&parsed.body, &params.sections, eol)?;
    if let Some(target) = params.set_status {
        fm.status = Some(match target {
            DistillTargetStatus::Shaping => Status::Shaping,
            DistillTargetStatus::Planned => Status::Planned,
        });
    }
    fm.updated = Some(writer::now_iso_utc());
    let content = compose_note(&fm, &new_body, eol)?;
    let rev_new = writer::compute_rev(content.as_bytes());

    let mut plan_pair = None;
    if let Some(pp) = plan_params {
        plan_pair = Some(super::planning::plan_create(root, index, &pp, opts)?);
    }

    let mut tx = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    tx.stage_write(&source.path, content)?;
    let mut op = tx.commit(&format!("Выжимка «{}»", source.title))?;

    let mut plan_ref = None;
    if let Some((plan_resp, plan_op)) = plan_pair {
        plan_ref = Some(plan_resp.r#ref);
        op = merge_ops(op, plan_op);
    }

    Ok((DistillSaveResponse { rev_new, plan_ref }, op))
}

/// Утренний брифинг: входящие, ближайшие шаги активных планов, застой,
/// просрочки, недавнее, кандидаты на дистилляцию.
pub fn context_briefing(
    root: &Path,
    index: &Index,
) -> Result<ContextBriefingResponse, VaultError> {
    let notes = index.all_notes()?;
    let today = today_utc();

    let inbox_count = notes
        .iter()
        .filter(|n| n.status == Some(Status::Inbox))
        .count() as u32;

    let mut next_steps: Vec<NextStep> = Vec::new();
    let progress = super::planning::plan_progress(
        root,
        index,
        &PlanProgressParams {
            r#ref: None,
            all_active: Some(true),
            stalled_days: None,
        },
    )?;
    for plan in progress.plans {
        if let Some(task) = plan.next_tasks.into_iter().next() {
            next_steps.push(NextStep {
                plan: plan.r#ref,
                task,
            });
        }
    }

    let mut overdue: Vec<TaskItem> = Vec::new();
    for task in index.all_tasks()? {
        if task.done {
            continue;
        }
        let is_overdue = task
            .due
            .as_deref()
            .map(|due| due.get(..10).unwrap_or(due) < today.as_str())
            .unwrap_or(false);
        if is_overdue {
            overdue.push(task);
        }
    }
    overdue.sort_by(|a, b| a.due.cmp(&b.due));
    overdue.truncate(50);

    let mut stalled: Vec<StalledNote> = Vec::new();
    for note in &notes {
        if !matches!(note.status, Some(Status::Inbox) | Some(Status::Shaping)) {
            continue;
        }
        if let Some(days) = days_between(&note.updated, &today) {
            if days >= STALLED_DAYS_DEFAULT as i64 {
                stalled.push(StalledNote {
                    r#ref: meta_ref(note),
                    days: days as u32,
                });
            }
        }
    }
    stalled.sort_by(|a, b| b.days.cmp(&a.days));
    stalled.truncate(20);

    let mut recent = notes.clone();
    recent.sort_by(|a, b| b.updated.cmp(&a.updated));
    recent.truncate(5);

    let mut candidates: Vec<&NoteMeta> = notes
        .iter()
        .filter(|n| matches!(n.status, Some(Status::Inbox) | Some(Status::Shaping)))
        .collect();
    candidates.sort_by(|a, b| b.updated.cmp(&a.updated));
    let suggest_distill: Vec<NoteRef> = candidates.into_iter().take(3).map(meta_ref).collect();

    Ok(ContextBriefingResponse {
        inbox_count,
        next_steps,
        stalled,
        overdue,
        recent,
        suggest_distill,
    })
}

/// Сборка основного и второстепенных файлов бандла в один markdown для ИИ
/// (секции с путём и заголовком каждого файла).
pub fn bundle_compose(
    root: &Path,
    index: &Index,
    params: &BundleComposeParams,
) -> Result<BundleComposeResponse, VaultError> {
    let source = index.note_by_ref(&params.r#ref)?;
    let include_linked = params.include_linked.unwrap_or(true);
    let max = params
        .max_chars
        .map(|m| m as usize)
        .unwrap_or(DISTILL_BUDGET_CHARS_DEFAULT as usize);

    let mut seen: HashSet<NoteId> = HashSet::new();
    seen.insert(source.id.clone());
    let mut ordered: Vec<(NoteMeta, BundleRole)> = vec![(source.clone(), BundleRole::Source)];

    let mut member_ids: Vec<NoteId> = Vec::new();
    for edge in index.backlinks(&source.id)? {
        if is_bundle_rel(&edge.rel_type) && seen.insert(edge.src_id.clone()) {
            member_ids.push(edge.src_id.clone());
        }
    }
    for edge in index.outgoing(&source.id)? {
        if let Some(dst) = &edge.dst_id {
            if is_bundle_rel(&edge.rel_type) && seen.insert(dst.clone()) {
                member_ids.push(dst.clone());
            }
        }
    }
    let mut member_metas = resolve_metas(index, &member_ids)?;
    member_metas.sort_by(|a, b| a.path.cmp(&b.path));
    for meta in member_metas {
        ordered.push((meta, BundleRole::Linked));
    }

    if include_linked {
        let mut extra_ids: Vec<NoteId> = Vec::new();
        for edge in index.outgoing(&source.id)? {
            if let Some(dst) = &edge.dst_id {
                if !is_bundle_rel(&edge.rel_type) && seen.insert(dst.clone()) {
                    extra_ids.push(dst.clone());
                }
            }
        }
        let mut extra_metas = resolve_metas(index, &extra_ids)?;
        extra_metas.sort_by(|a, b| a.path.cmp(&b.path));
        for meta in extra_metas {
            ordered.push((meta, BundleRole::Linked));
        }
    }

    let mut text = String::new();
    let mut members: Vec<BundleComposeMember> = Vec::new();
    let mut truncated = false;
    for (meta, role) in ordered {
        let body = read_note_body(root, &meta.path)
            .map(|(_, body)| body)
            .unwrap_or_default();
        let piece = build_piece(&meta, &body);
        let piece_len = piece.chars().count();
        let current = text.chars().count();
        if current + piece_len <= max {
            text.push_str(&piece);
            members.push(bundle_member(&meta, role, piece_len as u32));
        } else {
            let remaining = max.saturating_sub(current);
            if remaining > 0 {
                let clipped = clip_to_chars(&piece, remaining);
                let clen = clipped.chars().count();
                text.push_str(&clipped);
                members.push(bundle_member(&meta, role, clen as u32));
            }
            truncated = true;
            break;
        }
    }

    let chars = text.chars().count() as u32;
    Ok(BundleComposeResponse {
        text,
        members,
        chars,
        truncated: truncated.then_some(true),
    })
}

/// Создание бандла: основной-инструкция + прикрепление второстепенных
/// связями. Мутация — пишет журнал-операцию.
pub fn bundle_create(
    root: &Path,
    index: &Index,
    params: &BundleCreateParams,
    opts: &TxnOpts,
) -> Result<(BundleCreateResponse, JournalOp), VaultError> {
    let title = params.title.trim();
    if title.is_empty() {
        return Err(VaultError::Validation("пустой заголовок бандла".to_string()));
    }

    let mut members: Vec<NoteMeta> = Vec::new();
    let mut member_seen: HashSet<NoteId> = HashSet::new();
    if let Some(refs) = &params.members {
        for r in refs {
            let meta = index.note_by_ref(r)?;
            if member_seen.insert(meta.id.clone()) {
                members.push(meta);
            }
        }
    }

    let parent_dir = match &params.parent {
        Some(parent) => {
            let bare = parent
                .0
                .strip_prefix("path:")
                .map(|p| p.replace('\\', "/").trim_matches('/').to_string())
                .filter(|p| !p.is_empty() && !p.to_lowercase().ends_with(".md") && root.join(p).is_dir());
            match bare {
                Some(dir) => dir,
                None => container_dir(&index.note_by_ref(parent)?.path),
            }
        }
        None => String::new(),
    };

    let main_id = ulid::Ulid::new().to_string();
    let stem = writer::sanitize_file_name(title);
    let rel_path = unique_rel_path(root, &parent_dir, &stem)?;
    let now = writer::now_iso_utc();
    let fm = Frontmatter {
        id: Some(NoteId(main_id.clone())),
        r#type: Some(NoteType::Note),
        title: Some(title.to_string()),
        created: Some(now.clone()),
        updated: Some(now),
        ..Frontmatter::default()
    };
    let body = build_bundle_body(params.instruction.as_deref(), &members);
    let main_content = compose_note(&fm, &body, "\n")?;
    let rev = writer::compute_rev(main_content.as_bytes());

    let mut tx = txn::begin(root, opts.actor, opts.tool.clone(), opts.session.clone())?;
    tx.stage_write(&rel_path, main_content)?;

    let link_to_main = format!("[[id:{}|{}]]", main_id, title);
    let mut added = 0u32;
    for member in &members {
        let member_abs = writer::vault_abs_path(root, &member.path)?;
        let Ok(member_raw) = std::fs::read_to_string(&member_abs) else {
            continue;
        };
        let member_eol = detect_eol(&member_raw);
        let member_parsed = parser::parse_note(&member_raw)?;
        let mut member_fm = member_parsed.frontmatter.clone();
        let entry = member_fm
            .rel
            .entry(RelType::PartOf.as_str().to_string())
            .or_default();
        if entry.iter().any(|target| target.contains(&main_id)) {
            continue;
        }
        entry.push(link_to_main.clone());
        let member_content = compose_note(&member_fm, &member_parsed.body, member_eol)?;
        tx.stage_write(&member.path, member_content)?;
        added += 1;
    }

    let op = tx.commit(&format!("Бандл «{title}»: {added} второстепенных"))?;
    Ok((
        BundleCreateResponse {
            r#ref: NoteRef(format!("id:{main_id}")),
            path: rel_path,
            rev,
            added,
        },
        op,
    ))
}

/// Эвристика «идея → задачи»: нумерованные/маркированные строки → черновики
/// задач. Чистый парсинг без ИИ.
pub fn idea_to_tasks(
    root: &Path,
    index: &Index,
    params: &IdeaToTasksParams,
) -> Result<IdeaToTasksResponse, VaultError> {
    let source_text = if let Some(text) = &params.text {
        text.clone()
    } else if let Some(r) = &params.r#ref {
        let meta = index.note_by_ref(r)?;
        read_note_body(root, &meta.path)?.1
    } else {
        return Err(VaultError::Validation(
            "нужен text или ref для разбора идеи в задачи".to_string(),
        ));
    };

    Ok(IdeaToTasksResponse {
        tasks: parse_idea_lines(&source_text),
        plan_ref: None,
    })
}

fn require_nonempty(value: &str, name: &str) -> Result<(), VaultError> {
    if value.trim().is_empty() {
        Err(VaultError::Validation(format!(
            "обязательная секция «{name}» пуста"
        )))
    } else {
        Ok(())
    }
}

/// Разбор секции «План» дистилляции в параметры создания плана: голова из
/// цели, единственная стадия из чекбоксов, связь `distilled_from` к источнику.
fn build_plan_params(
    source: &NoteMeta,
    sections: &DistillSections,
) -> Result<PlanCreateParams, VaultError> {
    let plan_text = opt_nonempty(&sections.plan).ok_or_else(|| {
        VaultError::Validation("нужен первый шаг в секции «План» для создания плана".to_string())
    })?;
    let drafts = parse_idea_lines(plan_text);
    if drafts.is_empty() {
        return Err(VaultError::Validation(
            "в секции «План» не найдено ни одной задачи".to_string(),
        ));
    }
    let tasks = drafts
        .into_iter()
        .map(|draft| PlanTaskDraft {
            text: draft.text,
            due: draft.due,
        })
        .collect();
    Ok(PlanCreateParams {
        title: format!("План: {}", source.title),
        goal: sections.goal.trim().to_string(),
        target_date: None,
        parent: None,
        stages: vec![PlanStageDraft {
            title: "План".to_string(),
            tasks,
        }],
        sources: Some(vec![meta_ref(source)]),
    })
}

/// Апсерт всех секций дистилляции в тело: обязательные, затем присутствующие
/// опциональные — в каноническом порядке (SPEC §7.5, п.5).
fn apply_sections(body: &str, sections: &DistillSections, eol: &str) -> Result<String, VaultError> {
    let mut out = body.to_string();
    out = upsert_section(out, "Цель", &sections.goal, eol)?;
    out = upsert_section(out, "Зачем", &sections.why, eol)?;
    out = upsert_section(out, "Критерии готовности", &sections.done_criteria, eol)?;
    if let Some(plan) = opt_nonempty(&sections.plan) {
        out = upsert_section(out, "План", plan, eol)?;
    }
    if let Some(risks) = opt_nonempty(&sections.risks) {
        out = upsert_section(out, "Риски", risks, eol)?;
    }
    if let Some(assumptions) = opt_nonempty(&sections.assumptions) {
        out = upsert_section(out, "Допущения", assumptions, eol)?;
    }
    if let Some(blind_spots) = opt_nonempty(&sections.blind_spots) {
        out = upsert_section(out, "Ты об этом ещё не думал", blind_spots, eol)?;
    }
    Ok(out)
}

/// Заменяет секцию по заголовку H2, если она есть, иначе дописывает в конец
/// тела с отбивкой в одну пустую строку.
fn upsert_section(
    body: String,
    heading: &str,
    content: &str,
    eol: &str,
) -> Result<String, VaultError> {
    let clean = normalize_block_content(content, eol);
    let block = format!("## {heading}{eol}{eol}{clean}{eol}");
    match parser::find_section(&body, heading)? {
        Some((start, end)) => {
            let mut out = String::with_capacity(body.len() + block.len());
            out.push_str(&body[..start]);
            out.push_str(&block);
            let rest = &body[end..];
            if !rest.is_empty() {
                if !rest.starts_with(eol) && !rest.starts_with('\n') {
                    out.push_str(eol);
                }
                out.push_str(rest);
            }
            Ok(out)
        }
        None => {
            let mut out = body;
            let trimmed = out.trim_end_matches(['\n', '\r']).len();
            out.truncate(trimmed);
            if !out.is_empty() {
                out.push_str(eol);
                out.push_str(eol);
            }
            out.push_str(&block);
            Ok(out)
        }
    }
}

fn normalize_block_content(content: &str, eol: &str) -> String {
    let normalized = writer::normalize_lf(content);
    let trimmed = normalized.trim();
    if eol == "\n" {
        trimmed.to_string()
    } else {
        trimmed.replace('\n', eol)
    }
}

/// Пересобирает файл заметки из frontmatter и тела, сохраняя стиль концов
/// строк исходника.
fn compose_note(fm: &Frontmatter, body: &str, eol: &str) -> Result<String, VaultError> {
    let serialized = parser::serialize_frontmatter(fm)?;
    let front = if eol == "\n" || serialized.is_empty() {
        serialized
    } else {
        serialized.replace('\n', eol)
    };
    Ok(format!("{front}{body}"))
}

fn detect_eol(raw: &str) -> &'static str {
    if raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Карта пробелов по заголовкам тела: для каждой ожидаемой секции — есть ли
/// заголовок, чей нормализованный текст совпадает с одним из синонимов.
fn compute_gaps(body: &str) -> Result<Vec<String>, VaultError> {
    let headings = parser::extract_headings(body)?;
    let present: HashSet<String> = headings
        .iter()
        .map(|h| parser::normalize_for_compare(&h.text))
        .collect();
    let mut gaps = Vec::new();
    for (gap, aliases) in GAP_SPECS {
        let covered = aliases
            .iter()
            .any(|&alias| present.contains(&parser::normalize_for_compare(alias)));
        if !covered {
            gaps.push(gap.to_string());
        }
    }
    Ok(gaps)
}

fn push_excerpt(
    bundle: &mut Vec<BundleItem>,
    used: &mut usize,
    budget: usize,
    meta: &NoteMeta,
    role: BundleRole,
    body: &str,
    cap: usize,
) -> bool {
    if *used >= budget {
        return false;
    }
    let limit = (budget - *used).min(cap);
    let excerpt = clip_to_chars(body.trim(), limit);
    *used += excerpt.chars().count();
    bundle.push(BundleItem {
        r#ref: meta_ref(meta),
        role,
        excerpt,
    });
    true
}

fn build_piece(meta: &NoteMeta, body: &str) -> String {
    format!(
        "## {}\n\n_Путь: {}_\n\n{}\n\n---\n\n",
        meta.title,
        meta.path,
        body.trim()
    )
}

fn bundle_member(meta: &NoteMeta, role: BundleRole, chars: u32) -> BundleComposeMember {
    BundleComposeMember {
        r#ref: meta_ref(meta),
        title: meta.title.clone(),
        path: meta.path.clone(),
        role,
        chars,
    }
}

fn build_bundle_body(instruction: Option<&str>, members: &[NoteMeta]) -> String {
    let instr = instruction
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BUNDLE_INSTRUCTION);
    let instr = writer::normalize_lf(instr);
    let mut body = instr.trim().to_string();
    body.push('\n');
    if !members.is_empty() {
        body.push('\n');
        body.push_str("## Состав бандла\n\n");
        for member in members {
            body.push_str(&format!("- {}\n", member_wikilink(member)));
        }
    }
    body
}

fn member_wikilink(meta: &NoteMeta) -> String {
    format!("[[id:{}|{}]]", meta.id.0, meta.title)
}

fn merge_ops(mut base: JournalOp, extra: JournalOp) -> JournalOp {
    base.files.extend(extra.files);
    if !extra.summary.is_empty() {
        base.summary = format!("{}; {}", base.summary, extra.summary);
    }
    base
}

fn resolve_metas(index: &Index, ids: &[NoteId]) -> Result<Vec<NoteMeta>, VaultError> {
    let mut metas = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(meta) = index.note_by_id(id)? {
            metas.push(meta);
        }
    }
    Ok(metas)
}

fn is_bundle_rel(rel: &RelType) -> bool {
    matches!(rel, RelType::PartOf | RelType::CollectedIn)
}

fn meta_ref(meta: &NoteMeta) -> NoteRef {
    NoteRef(format!("id:{}", meta.id.0))
}

/// Каталог для размещения детей заметки-родителя: для folder-note — её папка,
/// для листа — папка, где он лежит.
fn container_dir(path: &str) -> String {
    if let Some(dir) = path.strip_suffix("/_index.md") {
        return dir.to_string();
    }
    if path == "_index.md" {
        return String::new();
    }
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn file_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")
}

/// Свободный rel-путь `<dir>/<stem>.md`; при коллизии добавляет « N».
fn unique_rel_path(root: &Path, dir: &str, stem: &str) -> Result<String, VaultError> {
    let build = |name: &str| {
        if dir.is_empty() {
            format!("{name}.md")
        } else {
            format!("{dir}/{name}.md")
        }
    };
    let mut candidate = build(stem);
    let mut n = 2;
    while writer::vault_abs_path(root, &candidate)?.exists() {
        candidate = build(&format!("{stem} {n}"));
        n += 1;
    }
    Ok(candidate)
}

fn read_note_body(root: &Path, rel_path: &str) -> Result<(Frontmatter, String), VaultError> {
    let abs = writer::vault_abs_path(root, rel_path)?;
    let raw = std::fs::read_to_string(&abs)?;
    let parsed = parser::parse_note(&raw)?;
    Ok((parsed.frontmatter, parsed.body))
}

fn opt_nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn clip_to_chars(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn today_utc() -> String {
    let now = writer::now_iso_utc();
    match now.get(..10) {
        Some(date) => date.to_string(),
        None => now,
    }
}

fn days_between(from: &str, to: &str) -> Option<i64> {
    let (fy, fm, fd) = parse_ymd(from)?;
    let (ty, tm, td) = parse_ymd(to)?;
    Some(days_from_civil(ty, tm, td) - days_from_civil(fy, fm, fd))
}

fn parse_ymd(value: &str) -> Option<(i64, i64, i64)> {
    let date = value.get(..10)?;
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if ![0, 1, 2, 3, 5, 6, 8, 9]
        .iter()
        .all(|&i| bytes[i].is_ascii_digit())
    {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[5..7].parse().ok()?;
    let day: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

/// Число дней с эпохи Unix для даты (алгоритм Говарда Хиннанта).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let yoe = year - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Разбор идеи в черновики задач: маркированные/нумерованные строки вне
/// код-блоков → текст (со снятыми `@due(...)`/`@p(...)`) + метаданные.
fn parse_idea_lines(source: &str) -> Vec<IdeaToTaskDraft> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(after_marker) = strip_list_marker(line) else {
            continue;
        };
        let (text, due, priority) = extract_annotations(strip_checkbox(after_marker));
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(IdeaToTaskDraft {
            text,
            due,
            priority,
        });
    }
    out
}

/// Снимает маркер списка: `-`/`*`/`+`/`•`, `N.`/`N)`, `N - `. Возвращает текст
/// после маркера или `None`, если строка не элемент списка.
fn strip_list_marker(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let first = t.chars().next()?;
    if matches!(first, '-' | '*' | '+' | '•') {
        let rest = &t[first.len_utf8()..];
        if rest.starts_with(char::is_whitespace) {
            return Some(rest.trim_start());
        }
        return None;
    }
    if first.is_ascii_digit() {
        let digits_end = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
        let after = &t[digits_end..];
        if let Some(rest) = after.strip_prefix('.').or_else(|| after.strip_prefix(')')) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return Some(rest.trim_start());
            }
            return None;
        }
        let after_ws = after.trim_start();
        if after_ws.len() < after.len() {
            if let Some(rest) = after_ws.strip_prefix('-') {
                if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                    return Some(rest.trim_start());
                }
            }
        }
    }
    None
}

/// Снимает ведущий чекбокс `[ ]`/`[x]`/`[X]`/`[/]`/`[-]`, если за ним пробел.
fn strip_checkbox(text: &str) -> &str {
    let t = text.trim_start();
    let bytes = t.as_bytes();
    if bytes.len() >= 3
        && bytes[0] == b'['
        && bytes[2] == b']'
        && matches!(bytes[1], b' ' | b'x' | b'X' | b'/' | b'-')
    {
        let rest = &t[3..];
        if rest.is_empty() {
            return "";
        }
        if rest.starts_with(char::is_whitespace) {
            return rest.trim_start();
        }
    }
    t
}

/// Извлекает первые `@due(ГГГГ-ММ-ДД)` и `@p(low|normal|high|urgent)`,
/// вырезает их из текста и схлопывает пробелы.
fn extract_annotations(text: &str) -> (String, Option<String>, Option<Priority>) {
    let mut due = None;
    let mut priority = None;
    let mut removed: Vec<(usize, usize)> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < text.len() {
        if bytes[i] != b'@' {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        if let Some(tail) = rest.strip_prefix("@due(") {
            if let Some(close) = tail.find(')') {
                let content = &tail[..close];
                if due.is_none() && is_plain_date(content) {
                    due = Some(content.to_string());
                    let len = "@due(".len() + close + 1;
                    removed.push((i, i + len));
                    i += len;
                    continue;
                }
            }
        } else if let Some(tail) = rest.strip_prefix("@p(") {
            if let Some(close) = tail.find(')') {
                if priority.is_none() {
                    if let Ok(parsed) = tail[..close].parse::<Priority>() {
                        priority = Some(parsed);
                        let len = "@p(".len() + close + 1;
                        removed.push((i, i + len));
                        i += len;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    let mut cleaned = String::with_capacity(text.len());
    let mut cursor = 0;
    for (from, to) in removed {
        cleaned.push_str(&text[cursor..from]);
        cursor = to;
    }
    cleaned.push_str(&text[cursor..]);
    let text = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    (text, due, priority)
}

fn is_plain_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit())
}
