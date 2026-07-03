use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::state::{CoreState, core_cell};
use crate::dto::*;
use vault_core::indexer::Index;
use vault_core::txn::TxnOpts;
use vault_core::vault::{ai, crud, history, planning, query};
use vault_core::{parser, writer};

fn gerr(code: GraphiteErrorCode, message: impl Into<String>, hint: Option<&str>) -> GraphiteError {
    GraphiteError {
        code,
        message: message.into(),
        hint: hint.map(|s| s.to_string()),
        data: None,
    }
}

fn core_err(e: vault_core::VaultError) -> GraphiteError {
    let rpc_err: vault_core::GraphiteError = e.into();
    convert(&rpc_err).unwrap_or_else(|_| gerr(GraphiteErrorCode::Unavailable, "ошибка ядра", None))
}

/// Перегоняет один сериализуемый тип в другой с идентичной формой serde
/// (dto ↔ канонические типы ядра). Оба набора используют camelCase на границе.
fn convert<A: Serialize, B: DeserializeOwned>(value: &A) -> Result<B, GraphiteError> {
    let json = serde_json::to_value(value)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("сериализация: {e}"), None))?;
    serde_json::from_value(json)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("десериализация: {e}"), None))
}

fn not_mounted() -> GraphiteError {
    gerr(
        GraphiteErrorCode::Unavailable,
        "хранилище не открыто",
        Some("сначала вызови vault_open"),
    )
}

/// Эксклюзивный доступ к смонтированному ядру (один писатель).
fn with_core<T>(f: impl FnOnce(&mut CoreState) -> Result<T, GraphiteError>) -> Result<T, GraphiteError> {
    let mut guard = core_cell().lock().unwrap();
    let state = guard.as_mut().ok_or_else(not_mounted)?;
    f(state)
}

fn current_root() -> Result<PathBuf, GraphiteError> {
    core_cell()
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(not_mounted)
}

fn txn_opts() -> TxnOpts {
    TxnOpts {
        actor: vault_core::Actor::User,
        tool: None,
        session: None,
    }
}

/// Пост-обработка мутации: запись в журнал и переиндексация затронутых файлов.
fn after_mutation(state: &mut CoreState, op: &vault_core::JournalOp) {
    let _ = history::record(&state.root, op);
    let paths: Vec<String> = op.files.iter().map(|c| c.path.clone()).collect();
    let _ = state.index.reindex_paths(&state.root, &paths);
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
    let db = root.join(".graphite").join("index.db");
    let mut index = Index::open(&db).map_err(core_err)?;
    index.rebuild(&root).map_err(core_err)?;
    crate::runtime::save_last_vault(&root);
    *core_cell().lock().unwrap() = Some(CoreState { root, index });
    vault_info_impl()
}

/// Монтирует последний открытый vault на старте приложения. Тихо пропускает
/// отсутствие сохранённого пути или недоступную папку, чтобы старт без vault
/// не падал — ядро просто ждёт выбора.
pub fn mount_saved_vault() {
    if core_cell().lock().unwrap().is_some() {
        return;
    }
    if let Some(path) = crate::runtime::load_last_vault() {
        if path.is_dir() {
            let _ = mount_vault(&path.to_string_lossy(), false);
        }
    }
}

fn de<T: DeserializeOwned>(params: serde_json::Value) -> Result<T, GraphiteError> {
    let params = if params.is_null() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        params
    };
    serde_json::from_value(params).map_err(|e| {
        gerr(
            GraphiteErrorCode::Validation,
            format!("некорректные параметры: {e}"),
            Some("проверь форму аргументов метода"),
        )
    })
}

fn ser<T: Serialize>(value: T) -> Result<serde_json::Value, GraphiteError> {
    serde_json::to_value(value)
        .map_err(|e| gerr(GraphiteErrorCode::Unavailable, format!("сериализация ответа: {e}"), None))
}

/// Единый диспетчер методов ядра: имя метода → типизированная команда. Общий
/// путь для Tauri-обёрток (через свои сигнатуры) и pipe-Handler (по имени).
/// `hello`, `ui_open_note`, `ui_flash_note` обслуживает приложение, не ядро.
pub fn dispatch(method: &str, params: serde_json::Value) -> Result<serde_json::Value, GraphiteError> {
    match method {
        "vault_info" => ser(vault_info()?),
        "vault_tree" => ser(vault_tree(de(params)?)?),
        "note_read" => ser(note_read(de(params)?)?),
        "search" => ser(search(de(params)?)?),
        "links_get" => ser(links_get(de(params)?)?),
        "activity_get" => ser(activity_get(de(params)?)?),
        "context_briefing" => ser(context_briefing()?),
        "note_create" => ser(note_create(de(params)?)?),
        "note_edit" => ser(note_edit(de(params)?)?),
        "note_move" => ser(note_move(de(params)?)?),
        "note_rename" => ser(note_rename(de(params)?)?),
        "note_delete" => ser(note_delete(de(params)?)?),
        "note_restore" => ser(note_restore(de(params)?)?),
        "set_status" => ser(set_status(de(params)?)?),
        "link_add" => ser(link_add(de(params)?)?),
        "link_remove" => ser(link_remove(de(params)?)?),
        "tasks_query" => ser(tasks_query(de(params)?)?),
        "task_check" => ser(task_check(de(params)?)?),
        "plan_create" => ser(plan_create(de(params)?)?),
        "plan_update" => ser(plan_update(de(params)?)?),
        "plan_progress" => ser(plan_progress(de(params)?)?),
        "distill_context" => ser(distill_context(de(params)?)?),
        "distill_save" => ser(distill_save(de(params)?)?),
        "index_status" => ser(index_status()?),
        "reindex" => {
            let full = params.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
            reindex(full)?;
            ser(serde_json::json!({ "started": true }))
        }
        "set_icon" => ser(set_icon(de(params)?)?),
        "note_pin" => ser(note_pin(de(params)?)?),
        "bundle_compose" => ser(bundle_compose(de(params)?)?),
        "bundle_create" => ser(bundle_create(de(params)?)?),
        "idea_to_tasks" => ser(idea_to_tasks(de(params)?)?),
        "hello" | "ui_open_note" | "ui_flash_note" => Err(gerr(
            GraphiteErrorCode::Unavailable,
            format!("метод «{method}» обслуживается приложением, не ядром"),
            None,
        )),
        _ => Err(gerr(
            GraphiteErrorCode::NotFound,
            format!("неизвестный метод «{method}»"),
            None,
        )),
    }
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

fn read_fm(abs: &Path) -> vault_core::Frontmatter {
    fs::read_to_string(abs)
        .ok()
        .and_then(|raw| parser::parse_frontmatter(&raw).ok())
        .map(|(fm, _)| fm)
        .unwrap_or_default()
}

fn yml_str(fm: &vault_core::Frontmatter, key: &str) -> Option<String> {
    fm.extra.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn note_type_dto(t: Option<vault_core::NoteType>) -> NoteType {
    t.and_then(|t| convert::<_, NoteType>(&t).ok()).unwrap_or(NoteType::Note)
}

fn status_dto(s: Option<vault_core::Status>) -> Option<Status> {
    s.and_then(|s| convert::<_, Status>(&s).ok())
}

fn node_for(rel: &str, fallback_title: &str, abs: &Path, children_count: u32) -> TreeNode {
    let updated = fs::metadata(abs)
        .and_then(|m| m.modified())
        .map(iso_from_systime)
        .unwrap_or_else(|_| writer::now_iso_utc());
    let fm = read_fm(abs);
    let title = fm
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    TreeNode {
        r#ref: NoteRef(format!("path:{rel}")),
        path: rel.to_string(),
        title,
        r#type: note_type_dto(fm.r#type),
        status: status_dto(fm.status),
        children_count,
        updated,
        icon: yml_str(&fm, "icon"),
        icon_color: yml_str(&fm, "icon_color").or_else(|| yml_str(&fm, "iconColor")),
        pinned: fm.extra.get("pinned").and_then(|v| v.as_bool()),
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
        let index_abs = root.join(&index_rel);
        if index_abs.is_file() {
            out.push(node_for(&index_rel, &name, &index_abs, count_md_children(&abs_dir)));
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
    let mut dto: Frontmatter = serde_json::to_value(fm)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if dto.icon.is_none() {
        dto.icon = yml_str(fm, "icon");
    }
    if dto.icon_color.is_none() {
        dto.icon_color = yml_str(fm, "icon_color").or_else(|| yml_str(fm, "iconColor"));
    }
    dto.extra.remove("icon");
    dto.extra.remove("icon_color");
    dto.extra.remove("iconColor");
    dto
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
    with_core(|s| {
        let p: vault_core::SearchParams = convert(&params)?;
        let resp = query::search(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn links_get(params: LinksGetParams) -> Result<LinksGetResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinksGetParams = convert(&params)?;
        let resp = query::links_get(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn activity_get(params: ActivityGetParams) -> Result<ActivityGetResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::ActivityGetParams = convert(&params)?;
        let resp = query::activity_get(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn context_briefing() -> Result<ContextBriefingResponse, GraphiteError> {
    with_core(|s| {
        let resp = ai::context_briefing(&s.root, &s.index).map_err(core_err)?;
        convert(&resp)
    })
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
    with_core(|s| {
        let p: vault_core::NoteEditParams = convert(&params)?;
        let (resp, op) = crud::note_edit(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn note_move(params: NoteMoveParams) -> Result<NoteMoveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteMoveParams = convert(&params)?;
        let (resp, op) = crud::note_move(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn note_rename(params: NoteRenameParams) -> Result<NoteRenameResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteRenameParams = convert(&params)?;
        let (resp, op) = crud::note_rename(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn note_delete(params: NoteDeleteParams) -> Result<NoteDeleteResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteDeleteParams = convert(&params)?;
        let (resp, op) = crud::note_delete(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn note_restore(params: NoteRestoreParams) -> Result<NoteRestoreResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::NoteRestoreParams = convert(&params)?;
        let (resp, op) = crud::note_restore(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_status(params: SetStatusParams) -> Result<SetStatusResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::SetStatusParams = convert(&params)?;
        let (resp, op) = crud::set_status(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn link_add(params: LinkAddParams) -> Result<LinkAddResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinkAddParams = convert(&params)?;
        let (resp, op) = crud::link_add(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn link_remove(params: LinkRemoveParams) -> Result<LinkRemoveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::LinkRemoveParams = convert(&params)?;
        let (resp, op) = crud::link_remove(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn tasks_query(params: TasksQueryParams) -> Result<TasksQueryResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::TasksQueryParams = convert(&params)?;
        let resp = query::tasks_query(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn task_check(params: TaskCheckParams) -> Result<TaskCheckResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::TaskCheckParams = convert(&params)?;
        let (resp, op) = query::task_check(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn plan_create(params: PlanCreateParams) -> Result<PlanCreateResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanCreateParams = convert(&params)?;
        let (resp, op) = planning::plan_create(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn plan_update(params: PlanUpdateParams) -> Result<PlanUpdateResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanUpdateParams = convert(&params)?;
        let (resp, op) = planning::plan_update(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn plan_progress(params: PlanProgressParams) -> Result<PlanProgressResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::PlanProgressParams = convert(&params)?;
        let resp = planning::plan_progress(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn distill_context(
    params: DistillContextParams,
) -> Result<DistillContextResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::DistillContextParams = convert(&params)?;
        let resp = ai::distill_context(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn distill_save(params: DistillSaveParams) -> Result<DistillSaveResponse, GraphiteError> {
    with_core(|s| {
        let p: vault_core::DistillSaveParams = convert(&params)?;
        let (resp, op) = ai::distill_save(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
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
    with_core(|s| {
        let st = s.index.status().map_err(core_err)?;
        convert(&st)
    })
}

#[tauri::command]
#[specta::specta]
pub fn reindex(full: bool) -> Result<(), GraphiteError> {
    let _ = full;
    with_core(|s| s.index.rebuild(&s.root).map_err(core_err))
}

#[tauri::command]
#[specta::specta]
pub fn undo_op(op_id: String) -> Result<UndoResult, GraphiteError> {
    with_core(|s| {
        let res = history::undo_op(&s.root, &mut s.index, &op_id).map_err(core_err)?;
        convert(&res)
    })
}

#[tauri::command]
#[specta::specta]
pub fn undo_session(session: String) -> Result<UndoResult, GraphiteError> {
    with_core(|s| {
        let res = history::undo_session(&s.root, &mut s.index, &session).map_err(core_err)?;
        convert(&res)
    })
}

#[tauri::command]
#[specta::specta]
pub fn journal_list(params: ActivityGetParams) -> Result<Vec<JournalOp>, GraphiteError> {
    with_core(|s| {
        let p: vault_core::ActivityGetParams = convert(&params)?;
        let ops = history::journal_list(&s.root, &p).map_err(core_err)?;
        convert(&ops)
    })
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
    Ok(ClaudeCliInfo {
        found: false,
        path: None,
        mcp_add_command: "claude mcp add graphite --transport stdio -- graphite-mcp".to_string(),
    })
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

#[tauri::command]
#[specta::specta]
pub fn set_icon(params: SetIconParams) -> Result<SetIconResponse, GraphiteError> {
    with_core(|s| {
        let p: crud::SetIconParams = convert(&params)?;
        let (resp, op) = crud::set_icon(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn note_pin(params: NotePinParams) -> Result<NotePinResponse, GraphiteError> {
    with_core(|s| {
        let p: crud::NotePinParams = convert(&params)?;
        let (resp, op) = crud::note_pin(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn bundle_compose(params: BundleComposeParams) -> Result<BundleComposeResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::BundleComposeParams = convert(&params)?;
        let resp = ai::bundle_compose(&s.root, &s.index, &p).map_err(core_err)?;
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn bundle_create(params: BundleCreateParams) -> Result<BundleCreateResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::BundleCreateParams = convert(&params)?;
        let (resp, op) = ai::bundle_create(&s.root, &s.index, &p, &txn_opts()).map_err(core_err)?;
        after_mutation(s, &op);
        convert(&resp)
    })
}

#[tauri::command]
#[specta::specta]
pub fn idea_to_tasks(params: IdeaToTasksParams) -> Result<IdeaToTasksResponse, GraphiteError> {
    with_core(|s| {
        let p: ai::IdeaToTasksParams = convert(&params)?;
        let resp = ai::idea_to_tasks(&s.root, &s.index, &p).map_err(core_err)?;
        if p.create_plan == Some(true) {
            let _ = s.index.rebuild(&s.root);
        }
        convert(&resp)
    })
}

/// Кодирует значение для query-строки URL (unreserved-символы RFC 3986 —
/// как есть, остальные байты — в `%XX`). Ссылки содержат `:` `/` кириллицу.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Стабильная ASCII-метка окна из ссылки: ярлыки Tauri допускают только
/// `[a-zA-Z0-9-/:_]`, а ссылка может содержать кириллицу и пробелы.
fn note_window_label(note_ref: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    note_ref.hash(&mut hasher);
    format!("note-{:016x}", hasher.finish())
}

fn note_window_title(note_ref: &str) -> String {
    let rel = note_ref.strip_prefix("path:").unwrap_or(note_ref);
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    let stem = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .unwrap_or(name);
    if stem.is_empty() {
        "Graphite".to_string()
    } else {
        format!("{stem} — Graphite")
    }
}

/// Выносит заметку в отдельное webview-окно (фича #16). Повторный вызов для той
/// же ссылки фокусирует уже открытое окно, а не плодит дубликаты.
#[tauri::command]
#[specta::specta]
pub fn open_note_window(app: tauri::AppHandle, note_ref: String) -> Result<(), GraphiteError> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let label = note_window_label(&note_ref);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html?window=note&ref={}", percent_encode(&note_ref));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(note_window_title(&note_ref))
        .inner_size(760.0, 720.0)
        .min_inner_size(420.0, 320.0)
        .center()
        .build()
        .map_err(|e| {
            gerr(
                GraphiteErrorCode::Unavailable,
                format!("не удалось открыть окно заметки: {e}"),
                Some("проверь, что приложение запущено"),
            )
        })?;
    Ok(())
}
