import { invoke } from './invoke';
import type {
  ActivityGetParams,
  ActivityGetResponse,
  BufferSaveParams,
  BundleComposeParams,
  BundleComposeResponse,
  BundleCreateParams,
  BundleCreateResponse,
  ClaudeCliInfo,
  ContextBriefingResponse,
  DistillContextParams,
  DistillContextResponse,
  DistillSaveParams,
  DistillSaveResponse,
  IdeaToTasksParams,
  IdeaToTasksResponse,
  IndexStatus,
  JournalOp,
  LinkAddParams,
  LinkAddResponse,
  LinkRemoveParams,
  LinkRemoveResponse,
  LinksGetParams,
  LinksGetResponse,
  NoteCreateParams,
  NoteCreateResponse,
  NoteDeleteParams,
  NoteDeleteResponse,
  NoteEditParams,
  NoteEditResponse,
  NoteMoveParams,
  NoteMoveResponse,
  NoteReadParams,
  NoteReadResponse,
  NoteRenameParams,
  NoteRenameResponse,
  NotePinParams,
  NotePinResponse,
  NoteRestoreParams,
  NoteRestoreResponse,
  PlanCreateParams,
  PlanCreateResponse,
  PlanProgressParams,
  PlanProgressResponse,
  PlanUpdateParams,
  PlanUpdateResponse,
  SearchParams,
  SearchResponse,
  SetIconParams,
  SetIconResponse,
  SetStatusParams,
  SetStatusResponse,
  TaskCheckParams,
  TaskCheckResponse,
  TasksQueryParams,
  TasksQueryResponse,
  UndoResult,
  VaultInfoResponse,
  VaultTreeParams,
  VaultTreeResponse,
} from './types';

export const commands = {
  vaultInfo(): Promise<VaultInfoResponse> {
    return invoke('vault_info');
  },
  vaultTree(params: VaultTreeParams): Promise<VaultTreeResponse> {
    return invoke('vault_tree', { params });
  },
  noteRead(params: NoteReadParams): Promise<NoteReadResponse> {
    return invoke('note_read', { params });
  },
  search(params: SearchParams): Promise<SearchResponse> {
    return invoke('search', { params });
  },
  linksGet(params: LinksGetParams): Promise<LinksGetResponse> {
    return invoke('links_get', { params });
  },
  activityGet(params: ActivityGetParams): Promise<ActivityGetResponse> {
    return invoke('activity_get', { params });
  },
  contextBriefing(): Promise<ContextBriefingResponse> {
    return invoke('context_briefing');
  },
  noteCreate(params: NoteCreateParams): Promise<NoteCreateResponse> {
    return invoke('note_create', { params });
  },
  noteEdit(params: NoteEditParams): Promise<NoteEditResponse> {
    return invoke('note_edit', { params });
  },
  noteMove(params: NoteMoveParams): Promise<NoteMoveResponse> {
    return invoke('note_move', { params });
  },
  noteRename(params: NoteRenameParams): Promise<NoteRenameResponse> {
    return invoke('note_rename', { params });
  },
  noteDelete(params: NoteDeleteParams): Promise<NoteDeleteResponse> {
    return invoke('note_delete', { params });
  },
  noteRestore(params: NoteRestoreParams): Promise<NoteRestoreResponse> {
    return invoke('note_restore', { params });
  },
  setStatus(params: SetStatusParams): Promise<SetStatusResponse> {
    return invoke('set_status', { params });
  },
  linkAdd(params: LinkAddParams): Promise<LinkAddResponse> {
    return invoke('link_add', { params });
  },
  linkRemove(params: LinkRemoveParams): Promise<LinkRemoveResponse> {
    return invoke('link_remove', { params });
  },
  tasksQuery(params: TasksQueryParams): Promise<TasksQueryResponse> {
    return invoke('tasks_query', { params });
  },
  taskCheck(params: TaskCheckParams): Promise<TaskCheckResponse> {
    return invoke('task_check', { params });
  },
  planCreate(params: PlanCreateParams): Promise<PlanCreateResponse> {
    return invoke('plan_create', { params });
  },
  planUpdate(params: PlanUpdateParams): Promise<PlanUpdateResponse> {
    return invoke('plan_update', { params });
  },
  planProgress(params: PlanProgressParams): Promise<PlanProgressResponse> {
    return invoke('plan_progress', { params });
  },
  distillContext(params: DistillContextParams): Promise<DistillContextResponse> {
    return invoke('distill_context', { params });
  },
  distillSave(params: DistillSaveParams): Promise<DistillSaveResponse> {
    return invoke('distill_save', { params });
  },
  bufferSave(params: BufferSaveParams): Promise<NoteEditResponse> {
    return invoke('buffer_save', { params });
  },
  indexStatus(): Promise<IndexStatus> {
    return invoke('index_status');
  },
  reindex(full: boolean): Promise<void> {
    return invoke('reindex', { full });
  },
  undoOp(opId: string): Promise<UndoResult> {
    return invoke('undo_op', { opId });
  },
  undoSession(session: string): Promise<UndoResult> {
    return invoke('undo_session', { session });
  },
  journalList(params: ActivityGetParams): Promise<JournalOp[]> {
    return invoke('journal_list', { params });
  },
  vaultOpen(path: string): Promise<VaultInfoResponse> {
    return invoke('vault_open', { path });
  },
  vaultCreate(path: string): Promise<VaultInfoResponse> {
    return invoke('vault_create', { path });
  },
  detectClaudeCli(): Promise<ClaudeCliInfo> {
    return invoke('detect_claude_cli');
  },
  quickCapture(text: string): Promise<NoteCreateResponse> {
    return invoke('quick_capture', { text });
  },
  setIcon(params: SetIconParams): Promise<SetIconResponse> {
    return invoke('set_icon', { params });
  },
  notePin(params: NotePinParams): Promise<NotePinResponse> {
    return invoke('note_pin', { params });
  },
  bundleCompose(params: BundleComposeParams): Promise<BundleComposeResponse> {
    return invoke('bundle_compose', { params });
  },
  bundleCreate(params: BundleCreateParams): Promise<BundleCreateResponse> {
    return invoke('bundle_create', { params });
  },
  ideaToTasks(params: IdeaToTasksParams): Promise<IdeaToTasksResponse> {
    return invoke('idea_to_tasks', { params });
  },
  openNoteWindow(noteRef: string): Promise<void> {
    return invoke('open_note_window', { noteRef });
  },
} as const;
