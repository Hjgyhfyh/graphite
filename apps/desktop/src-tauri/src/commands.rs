use crate::dto::*;

fn unavailable<P, T>(params: P, tool: &str) -> Result<T, GraphiteError> {
    let _ = params;
    Err(GraphiteError {
        code: GraphiteErrorCode::Unavailable,
        message: format!("{tool}: ядро ещё не подключено к оболочке"),
        hint: Some("core_not_mounted".into()),
        data: None,
    })
}

#[tauri::command]
#[specta::specta]
pub fn vault_info() -> Result<VaultInfoResponse, GraphiteError> {
    unavailable((), "vault_info")
}

#[tauri::command]
#[specta::specta]
pub fn vault_tree(params: VaultTreeParams) -> Result<VaultTreeResponse, GraphiteError> {
    unavailable(params, "vault_tree")
}

#[tauri::command]
#[specta::specta]
pub fn note_read(params: NoteReadParams) -> Result<NoteReadResponse, GraphiteError> {
    unavailable(params, "note_read")
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
    unavailable(params, "note_create")
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
    unavailable(params, "buffer_save")
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
    unavailable(path, "vault_open")
}

#[tauri::command]
#[specta::specta]
pub fn vault_create(path: String) -> Result<VaultInfoResponse, GraphiteError> {
    unavailable(path, "vault_create")
}

#[tauri::command]
#[specta::specta]
pub fn detect_claude_cli() -> Result<ClaudeCliInfo, GraphiteError> {
    unavailable((), "detect_claude_cli")
}

#[tauri::command]
#[specta::specta]
pub fn quick_capture(text: String) -> Result<NoteCreateResponse, GraphiteError> {
    unavailable(text, "quick_capture")
}
