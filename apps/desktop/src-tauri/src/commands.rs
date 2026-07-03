use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::dto::*;
use vault_core::{parser, writer};

static VAULT_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn root_cell() -> &'static Mutex<Option<PathBuf>> {
    VAULT_ROOT.get_or_init(|| Mutex::new(None))
}

fn gerr(code: GraphiteErrorCode, message: impl Into<String>, hint: Option<&str>) -> GraphiteError {
    GraphiteError {
        code,
        message: message.into(),
        hint: hint.map(|s| s.to_string()),
        data: None,
    }
}

fn core_err(e: vault_core::VaultError) -> GraphiteError {
    gerr(GraphiteErrorCode::Unavailable, e.to_string(), None)
}

fn current_root() -> Result<PathBuf, GraphiteError> {
    root_cell()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| gerr(GraphiteErrorCode::Unavailable, "хранилище не открыто", Some("сначала вызови vault_open")))
}

fn ref_to_rel(r: &str) -> Result<String, GraphiteError> {
    let Some(p) = r.strip_prefix("path:") else {
        return Err(gerr(
            GraphiteErrorCode::Validation,
            format!("неподдерживаемая форма ссылки: {r}"),
            Some("используй path:относительный/путь.md"),
        ));
    };
    let rel = p.replace('\\', "/");
    if rel.split('/').any(|seg| seg == "..") {
        return Err(gerr(GraphiteErrorCode::Validation, "путь выходит за пределы хранилища", None));
    }
    Ok(rel.trim_matches('/').to_string())
}

fn is_service_dir(name: &str) -> bool {
    name.starts_with('.') || name == "_assets" || name == "node_modules" || name == "target"
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_from_systime(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn walk_md_files(root: &Path, dir_rel: &str, out: &mut Vec<String>) {
    let abs = if dir_rel.is_empty() { root.to_path_buf() } else { root.join(dir_rel) };
    let Ok(entries) = fs::read_dir(&abs) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !is_service_dir(&name) {
                walk_md_files(root, &rel, out);
            }
        } else if name.to_lowercase().ends_with(".md") {
            out.push(rel);
        }
    }
}

fn vault_info_impl() -> Result<VaultInfoResponse, GraphiteError> {
    let root = current_root()?;
    let mut files = Vec::new();
    walk_md_files(&root, "", &mut files);
    let mut plans = 0u32;
    let mut tasks_open = 0u32;
    let mut inbox = 0u32;
    for rel in &files {
        if rel.starts_with("Входящие/") {
            inbox += 1;
        }
        let abs = root.join(rel);
        if let Ok(meta) = fs::metadata(&abs) {
            if meta.len() > 512 * 1024 {
                continue;
            }
        }
        if let Ok(raw) = fs::read_to_string(&abs) {
            let head = &raw[..raw.len().min(600)];
            if head.starts_with("---") && head.contains("type: plan") {
                plans += 1;
            }
            tasks_open += raw.matches("- [ ]").count() as u32;
        }
    }
    Ok(VaultInfoResponse {
        schema_version: vault_core::SCHEMA_VERSION.to_string(),
        vault_format: vault_core::VAULT_FORMAT.to_string(),
        root: root.to_string_lossy().to_string(),
        counts: VaultCounts {
            notes: files.len() as u32,
            plans,
            tasks_open,
            inbox,
        },
        capabilities: Vec::new(),
        limits: VaultLimits {
            max_response_bytes: 51_200,
            tree_limit_max: 500,
            search_limit_max: 50,
            mutations_rps: 5,
        },
        conventions_digest: "graphite-vault-format-1".to_string(),
    })
}

fn mount_vault(path: &str, create: bool) -> Result<VaultInfoResponse, GraphiteError> {
    let root = PathBuf::from(path);
    if create {
        fs::create_dir_all(root.join("Входящие"))
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать хранилище: {e}"), None))?;
    } else if !root.is_dir() {
        return Err(gerr(GraphiteErrorCode::NotFound, format!("папка не найдена: {path}"), None));
    }
    for dir in [".graphite", ".trash", "_assets"] {
        let _ = fs::create_dir_all(root.join(dir));
    }
    *root_cell().lock().unwrap() = Some(root);
    vault_info_impl()
}

fn count_md_children(abs_dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(abs_dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => !is_service_dir(&name),
                Ok(_) => name.to_lowercase().ends_with(".md") && name != "_index.md",
                Err(_) => false,
            }
        })
        .count() as u32
}

fn node_for(rel: &str, title: &str, abs: &Path, children_count: u32) -> TreeNode {
    let updated = fs::metadata(abs)
        .and_then(|m| m.modified())
        .map(iso_from_systime)
        .unwrap_or_else(|_| writer::now_iso_utc());
    TreeNode {
        r#ref: NoteRef(format!("path:{rel}")),
        path: rel.to_string(),
        title: title.to_string(),
        r#type: NoteType::Note,
        status: None,
        children_count,
        updated,
    }
}

fn build_tree(root: &Path, dir_rel: &str, out: &mut Vec<TreeNode>) {
    let abs = if dir_rel.is_empty() { root.to_path_buf() } else { root.join(dir_rel) };
    let Ok(entries) = fs::read_dir(&abs) else { return };
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                if !is_service_dir(&name) {
                    dirs.push(name);
                }
            }
            Ok(_) => {
                if name.to_lowercase().ends_with(".md") && name != "_index.md" {
                    files.push(name);
                }
            }
            Err(_) => {}
        }
    }
    dirs.sort_by_key(|a| a.to_lowercase());
    files.sort_by_key(|a| a.to_lowercase());
    for name in dirs {
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let abs_dir = root.join(&rel);
        let index_rel = format!("{rel}/_index.md");
        if root.join(&index_rel).is_file() {
            out.push(node_for(&index_rel, &name, &abs_dir, count_md_children(&abs_dir)));
        }
        build_tree(root, &rel, out);
    }
    for name in files {
        let rel = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
        let title = name.trim_end_matches(".md").trim_end_matches(".MD");
        out.push(node_for(&rel, title, &root.join(&rel), 0));
    }
}

fn frontmatter_to_dto(fm: &vault_core::Frontmatter) -> Frontmatter {
    serde_json::to_value(fm)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(|| serde_json::from_value(serde_json::json!({})).expect("пустой frontmatter"))
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn enum_str<T: serde::Serialize>(v: &T, fallback: &str) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| fallback.to_string())
}

fn note_create_impl(
    parent: Option<String>,
    title: &str,
    r#type: Option<NoteType>,
    status: Option<Status>,
    tags: Option<Vec<String>>,
    content: Option<String>,
) -> Result<NoteCreateResponse, GraphiteError> {
    let root = current_root()?;
    let mut parent_rel = match parent {
        Some(r) => ref_to_rel(&r)?,
        None => "Входящие".to_string(),
    };
    if let Some(stripped) = parent_rel.strip_suffix("/_index.md") {
        parent_rel = stripped.to_string();
    } else if parent_rel.to_lowercase().ends_with(".md") {
        parent_rel = parent_rel.trim_end_matches(".md").trim_end_matches(".MD").to_string();
    }
    if !parent_rel.is_empty() {
        fs::create_dir_all(root.join(&parent_rel))
            .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось создать папку: {e}"), None))?;
    }
    let base = writer::sanitize_file_name(title);
    let mut rel = if parent_rel.is_empty() { format!("{base}.md") } else { format!("{parent_rel}/{base}.md") };
    let mut n = 2u32;
    while root.join(&rel).exists() {
        rel = if parent_rel.is_empty() {
            format!("{base} {n}.md")
        } else {
            format!("{parent_rel}/{base} {n}.md")
        };
        n += 1;
    }
    let now = writer::now_iso_utc();
    let id = ulid::Ulid::new().to_string();
    let type_str = r#type.map(|t| enum_str(&t, "note")).unwrap_or_else(|| "note".to_string());
    let status_str = status.map(|s| enum_str(&s, "inbox")).unwrap_or_else(|| "inbox".to_string());
    let mut fm = String::from("---\n");
    fm.push_str(&format!("id: {id}\n"));
    fm.push_str(&format!("type: {type_str}\n"));
    fm.push_str(&format!("title: {}\n", yaml_quote(title)));
    if let Some(tags) = tags {
        if !tags.is_empty() {
            fm.push_str(&format!(
                "tags: [{}]\n",
                tags.iter().map(|t| yaml_quote(t)).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    fm.push_str(&format!("status: {status_str}\n"));
    fm.push_str(&format!("created: {now}\n"));
    fm.push_str(&format!("updated: {now}\n"));
    fm.push_str("---\n\n");
    let body = content.unwrap_or_default();
    let text = format!("{fm}{body}");
    let rev = writer::create_atomic(&root, &rel, &text).map_err(core_err)?;
    Ok(NoteCreateResponse {
        r#ref: NoteRef(format!("path:{rel}")),
        path: rel,
        rev: Rev(rev.0),
    })
}

#[tauri::command]
#[specta::specta]
pub fn vault_info() -> Result<VaultInfoResponse, GraphiteError> {
    vault_info_impl()
}

#[tauri::command]
#[specta::specta]
pub fn vault_tree(params: VaultTreeParams) -> Result<VaultTreeResponse, GraphiteError> {
    let root = current_root()?;
    let start_rel = match params.root {
        Some(r) => {
            let rel = ref_to_rel(&r.0)?;
            rel.strip_suffix("/_index.md").map(|s| s.to_string()).unwrap_or(rel)
        }
        None => String::new(),
    };
    let mut nodes = Vec::new();
    build_tree(&root, &start_rel, &mut nodes);
    let total = nodes.len() as u32;
    let limit = params.limit.unwrap_or(500).min(500) as usize;
    nodes.truncate(limit);
    Ok(VaultTreeResponse { nodes, total })
}

#[tauri::command]
#[specta::specta]
pub fn note_read(params: NoteReadParams) -> Result<NoteReadResponse, GraphiteError> {
    let root = current_root()?;
    let rel = ref_to_rel(&params.r#ref.0)?;
    let abs = root.join(&rel);
    if !abs.is_file() {
        return Err(gerr(GraphiteErrorCode::NotFound, format!("заметка не найдена: {rel}"), None));
    }
    let raw = fs::read_to_string(&abs)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("не удалось прочитать файл: {e}"), None))?;
    let fm = parser::parse_frontmatter(&raw)
        .map(|(fm, _)| frontmatter_to_dto(&fm))
        .unwrap_or_else(|_| frontmatter_to_dto(&vault_core::Frontmatter::default()));
    let rev = writer::compute_rev(raw.as_bytes());
    Ok(NoteReadResponse {
        frontmatter: fm,
        content: raw,
        rev: Rev(rev.0),
        truncated: None,
        links: None,
        backlinks: None,
        children: None,
        tasks: None,
    })
}

#[tauri::command]
#[specta::specta]
pub fn search(params: SearchParams) -> Result<SearchResponse, GraphiteError> {
    unavailable(params, "search")
}

#[tauri::command]
#[specta::specta]
pub fn links_get(params: LinksGetParams) -> Result<LinksGetResponse, GraphiteError> {
    unavailable(params, "links_get")
}

#[tauri::command]
#[specta::specta]
pub fn activity_get(params: ActivityGetParams) -> Result<ActivityGetResponse, GraphiteError> {
    unavailable(params, "activity_get")
}

#[tauri::command]
#[specta::specta]
pub fn context_briefing() -> Result<ContextBriefingResponse, GraphiteError> {
    unavailable((), "context_briefing")
}

#[tauri::command]
#[specta::specta]
pub fn note_create(params: NoteCreateParams) -> Result<NoteCreateResponse, GraphiteError> {
    note_create_impl(
        params.parent.map(|r| r.0),
        &params.title,
        params.r#type,
        params.status,
        params.tags,
        params.content,
    )
}

#[tauri::command]
#[specta::specta]
pub fn note_edit(params: NoteEditParams) -> Result<NoteEditResponse, GraphiteError> {
    unavailable(params, "note_edit")
}

#[tauri::command]
#[specta::specta]
pub fn note_move(params: NoteMoveParams) -> Result<NoteMoveResponse, GraphiteError> {
    unavailable(params, "note_move")
}

#[tauri::command]
#[specta::specta]
pub fn note_rename(params: NoteRenameParams) -> Result<NoteRenameResponse, GraphiteError> {
    unavailable(params, "note_rename")
}

#[tauri::command]
#[specta::specta]
pub fn note_delete(params: NoteDeleteParams) -> Result<NoteDeleteResponse, GraphiteError> {
    unavailable(params, "note_delete")
}

#[tauri::command]
#[specta::specta]
pub fn note_restore(params: NoteRestoreParams) -> Result<NoteRestoreResponse, GraphiteError> {
    unavailable(params, "note_restore")
}

#[tauri::command]
#[specta::specta]
pub fn set_status(params: SetStatusParams) -> Result<SetStatusResponse, GraphiteError> {
    unavailable(params, "set_status")
}

#[tauri::command]
#[specta::specta]
pub fn link_add(params: LinkAddParams) -> Result<LinkAddResponse, GraphiteError> {
    unavailable(params, "link_add")
}

#[tauri::command]
#[specta::specta]
pub fn link_remove(params: LinkRemoveParams) -> Result<LinkRemoveResponse, GraphiteError> {
    unavailable(params, "link_remove")
}

#[tauri::command]
#[specta::specta]
pub fn tasks_query(params: TasksQueryParams) -> Result<TasksQueryResponse, GraphiteError> {
    unavailable(params, "tasks_query")
}

#[tauri::command]
#[specta::specta]
pub fn task_check(params: TaskCheckParams) -> Result<TaskCheckResponse, GraphiteError> {
    unavailable(params, "task_check")
}

#[tauri::command]
#[specta::specta]
pub fn plan_create(params: PlanCreateParams) -> Result<PlanCreateResponse, GraphiteError> {
    unavailable(params, "plan_create")
}

#[tauri::command]
#[specta::specta]
pub fn plan_update(params: PlanUpdateParams) -> Result<PlanUpdateResponse, GraphiteError> {
    unavailable(params, "plan_update")
}

#[tauri::command]
#[specta::specta]
pub fn plan_progress(params: PlanProgressParams) -> Result<PlanProgressResponse, GraphiteError> {
    unavailable(params, "plan_progress")
}

#[tauri::command]
#[specta::specta]
pub fn distill_context(
    params: DistillContextParams,
) -> Result<DistillContextResponse, GraphiteError> {
    unavailable(params, "distill_context")
}

#[tauri::command]
#[specta::specta]
pub fn distill_save(params: DistillSaveParams) -> Result<DistillSaveResponse, GraphiteError> {
    unavailable(params, "distill_save")
}

#[tauri::command]
#[specta::specta]
pub fn buffer_save(params: BufferSaveParams) -> Result<NoteEditResponse, GraphiteError> {
    let root = current_root()?;
    let rel = ref_to_rel(&params.r#ref.0)?;
    let abs = root.join(&rel);
    let old = fs::read_to_string(&abs).unwrap_or_default();
    let cur_rev = writer::compute_rev(old.as_bytes());
    if !old.is_empty() && cur_rev.0 != params.base_rev.0 {
        let mut err = gerr(
            GraphiteErrorCode::Conflict,
            "файл изменился вне редактора",
            Some("перечитай note_read и сохрани заново"),
        );
        err.data = Some(serde_json::json!({ "rev": cur_rev.0 }));
        return Err(err);
    }
    let rev_new = writer::write_atomic(&root, &rel, params.content.as_bytes()).map_err(core_err)?;
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = params.content.lines().collect();
    let common = old_lines.iter().zip(new_lines.iter()).filter(|(a, b)| a == b).count();
    Ok(NoteEditResponse {
        rev_new: Rev(rev_new.0),
        diff_stat: DiffStat {
            plus: (new_lines.len() - common) as u32,
            minus: (old_lines.len() - common) as u32,
        },
    })
}

#[tauri::command]
#[specta::specta]
pub fn index_status() -> Result<IndexStatus, GraphiteError> {
    unavailable((), "index_status")
}

#[tauri::command]
#[specta::specta]
pub fn reindex(full: bool) -> Result<(), GraphiteError> {
    unavailable(full, "reindex")
}

#[tauri::command]
#[specta::specta]
pub fn undo_op(op_id: String) -> Result<UndoResult, GraphiteError> {
    unavailable(op_id, "undo_op")
}

#[tauri::command]
#[specta::specta]
pub fn undo_session(session: String) -> Result<UndoResult, GraphiteError> {
    unavailable(session, "undo_session")
}

#[tauri::command]
#[specta::specta]
pub fn journal_list(params: ActivityGetParams) -> Result<Vec<JournalOp>, GraphiteError> {
    unavailable(params, "journal_list")
}

#[tauri::command]
#[specta::specta]
pub fn vault_open(path: String) -> Result<VaultInfoResponse, GraphiteError> {
    mount_vault(&path, false)
}

#[tauri::command]
#[specta::specta]
pub fn vault_create(path: String) -> Result<VaultInfoResponse, GraphiteError> {
    mount_vault(&path, true)
}

#[tauri::command]
#[specta::specta]
pub fn detect_claude_cli() -> Result<ClaudeCliInfo, GraphiteError> {
    unavailable((), "detect_claude_cli")
}

#[tauri::command]
#[specta::specta]
pub fn quick_capture(text: String) -> Result<NoteCreateResponse, GraphiteError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(gerr(GraphiteErrorCode::Validation, "пустая заметка", None));
    }
    let first = trimmed
        .lines()
        .next()
        .unwrap_or("Быстрая заметка")
        .trim_start_matches(['#', '-', '*', ' '])
        .trim();
    let title: String = if first.is_empty() {
        "Быстрая заметка".to_string()
    } else {
        first.chars().take(60).collect()
    };
    note_create_impl(None, &title, None, None, None, Some(trimmed.to_string()))
}

fn unavailable<P, T>(params: P, tool: &str) -> Result<T, GraphiteError> {
    let _ = params;
    Err(GraphiteError {
        code: GraphiteErrorCode::Unavailable,
        message: format!("{tool}: будет в следующей версии ядра"),
        hint: Some("core_not_mounted".into()),
        data: None,
    })
}
