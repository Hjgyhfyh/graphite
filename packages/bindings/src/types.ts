export type NoteId = string;
export type Rev = string;
export type NoteRef = string;
export type Anchor = string;

export type Status = 'inbox' | 'shaping' | 'planned' | 'active' | 'done' | 'iced';
export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped';
export type NoteType = 'note' | 'plan' | 'project' | 'task' | 'journal';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type RelType =
  | 'related'
  | 'part_of'
  | 'depends_on'
  | 'blocks'
  | 'contradicts'
  | 'distilled_from'
  | 'collected_in'
  | (string & {});
export type Actor = 'user' | 'assistant' | 'external';
export type GraphiteErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'AMBIGUOUS'
  | 'LIMIT'
  | 'FORBIDDEN'
  | 'UNAVAILABLE';

export interface GraphiteError {
  code: GraphiteErrorCode;
  message: string;
  hint?: string;
  data?: unknown;
}

export interface Frontmatter {
  id?: NoteId;
  type?: NoteType;
  title?: string;
  aliases?: string[];
  tags?: string[];
  status?: Status;
  priority?: Priority;
  due?: string;
  scheduled?: string;
  goal?: string;
  targetDate?: string;
  rel?: Record<string, string[]>;
  sort?: number;
  icon?: string;
  iconColor?: string;
  created?: string;
  updated?: string;
  [x: string]: unknown;
}

export interface NoteMeta {
  id: NoteId;
  path: string;
  title: string;
  type: NoteType;
  status?: Status;
  tags: string[];
  updated: string;
  rev: Rev;
  childrenCount: number;
}

export interface TaskItem {
  id: string;
  noteId: NoteId;
  anchor: Anchor;
  text: string;
  done: boolean;
  status: TaskStatus;
  due?: string;
  priority?: Priority;
  every?: string;
  line: number;
  plan?: NoteRef;
  stage?: string;
}

export interface LinkEdge {
  srcId: NoteId;
  dstId?: NoteId;
  dstRaw: string;
  relType: RelType;
  block?: Anchor;
  context?: string;
}

export interface DiffStat {
  plus: number;
  minus: number;
}

export interface FileChange {
  path: string;
  before?: string;
  after?: string;
}

export interface JournalOp {
  opId: string;
  ts: string;
  actor: Actor;
  session?: string;
  tool?: string;
  summary: string;
  files: FileChange[];
  undone: boolean;
}

export interface SearchHit {
  ref: NoteRef;
  title: string;
  score: number;
  snippets: string[];
  updated: string;
}

export interface TreeNode {
  ref: NoteRef;
  path: string;
  title: string;
  type: NoteType;
  status?: Status;
  childrenCount: number;
  updated: string;
  icon?: string;
  iconColor?: string;
  pinned?: boolean;
}

export interface StageProgress {
  title: string;
  done: number;
  total: number;
}

export interface PlanProgress {
  ref: NoteRef;
  title: string;
  percent: number;
  done: number;
  total: number;
  byStage: StageProgress[];
  overdue: TaskItem[];
  stalled: TaskItem[];
  nextTasks: TaskItem[];
}

export interface VaultCounts {
  notes: number;
  plans: number;
  tasksOpen: number;
  inbox: number;
}

export interface VaultLimits {
  maxResponseBytes: number;
  treeLimitMax: number;
  searchLimitMax: number;
  mutationsRps: number;
}

export interface VaultInfoResponse {
  schemaVersion: string;
  vaultFormat: string;
  root: string;
  counts: VaultCounts;
  capabilities: string[];
  limits: VaultLimits;
  conventionsDigest: string;
}

export interface VaultTreeParams {
  root?: NoteRef;
  depth?: number;
  types?: NoteType[];
  limit?: number;
  offset?: number;
}

export interface VaultTreeResponse {
  nodes: TreeNode[];
  total: number;
}

export type NoteReadInclude = 'links' | 'backlinks' | 'children' | 'tasks';

export interface NoteReadParams {
  ref: NoteRef;
  include?: NoteReadInclude[];
  section?: string;
  offset?: number;
  maxChars?: number;
}

export interface NoteReadResponse {
  frontmatter: Frontmatter;
  content: string;
  rev: Rev;
  truncated?: boolean;
  links?: LinkEdge[];
  backlinks?: LinkEdge[];
  children?: TreeNode[];
  tasks?: TaskItem[];
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchFilters {
  type?: NoteType;
  status?: Status;
  tags?: string[];
  path?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  dueBefore?: string;
}

export interface SearchParams {
  query: string;
  mode?: SearchMode;
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  total?: number;
}

export type LinkDirection = 'out' | 'in' | 'both';

export interface LinksGetParams {
  ref: NoteRef;
  direction?: LinkDirection;
  types?: RelType[];
}

export interface LinkOut {
  to: NoteRef;
  type: RelType;
  context?: string;
}

export interface LinkIn {
  from: NoteRef;
  type: RelType;
}

export interface LinksGetResponse {
  out: LinkOut[];
  in: LinkIn[];
}

export type ActorFilter = 'user' | 'assistant' | 'external' | 'all';

export interface ActivityGetParams {
  since: string;
  scope?: NoteRef;
  actor?: ActorFilter;
  limit?: number;
}

export interface ActivityEvent {
  ts: string;
  actor: Actor;
  tool?: string;
  summary: string;
  refs: NoteRef[];
}

export interface ActivityGetResponse {
  events: ActivityEvent[];
}

export interface NextStep {
  plan: NoteRef;
  task: TaskItem;
}

export interface StalledNote {
  ref: NoteRef;
  days: number;
}

export interface ContextBriefingResponse {
  inboxCount: number;
  nextSteps: NextStep[];
  stalled: StalledNote[];
  overdue: TaskItem[];
  recent: NoteMeta[];
  suggestDistill: NoteRef[];
}

export interface NoteCreateParams {
  parent?: NoteRef;
  title: string;
  type?: NoteType;
  status?: Status;
  tags?: string[];
  content?: string;
  template?: string;
}

export interface NoteCreateResponse {
  ref: NoteRef;
  path: string;
  rev: Rev;
}

export type NoteEditOp =
  | { op: 'replace'; oldString: string; newString: string }
  | { op: 'append_section'; heading: string; content: string }
  | { op: 'replace_section'; heading: string; content: string }
  | { op: 'prepend'; content: string }
  | { op: 'set_frontmatter'; key: string; value: unknown };

export interface NoteEditParams {
  ref: NoteRef;
  rev: Rev;
  ops: NoteEditOp[];
}

export interface NoteEditResponse {
  revNew: Rev;
  diffStat: DiffStat;
}

export interface NoteMoveParams {
  ref: NoteRef;
  newParent: NoteRef;
  position?: number;
}

export interface NoteMoveResponse {
  pathNew: string;
  linksRewritten: number;
}

export interface NoteRenameParams {
  ref: NoteRef;
  newTitle: string;
}

export interface NoteRenameResponse {
  pathNew: string;
  linksUpdated: number;
  aliasAdded: boolean;
}

export interface NoteDeleteParams {
  ref: NoteRef;
}

export interface NoteDeleteResponse {
  restoreToken: string;
  backlinksBroken: number;
}

export interface NoteRestoreParams {
  restoreToken?: string;
  ref?: NoteRef;
}

export interface NoteRestoreResponse {
  ref: NoteRef;
  path: string;
}

export interface SetStatusParams {
  ref: NoteRef;
  status: Status;
  reason?: string;
}

export interface SetStatusResponse {
  old?: Status;
  new: Status;
}

export interface LinkAddParams {
  from: NoteRef;
  to: NoteRef;
  type?: RelType;
  context?: string;
}

export interface LinkAddResponse {
  created: boolean;
}

export interface LinkRemoveParams {
  from: NoteRef;
  to: NoteRef;
  type?: RelType;
}

export interface LinkRemoveResponse {
  removed: boolean;
}

export type TaskStatusFilter = 'open' | 'done' | 'all';

export interface TasksQueryParams {
  scope?: NoteRef;
  status?: TaskStatusFilter;
  dueBefore?: string;
  overdue?: boolean;
  plan?: NoteRef;
  limit?: number;
}

export interface TaskSource {
  ref: NoteRef;
  anchor: Anchor;
}

export interface TaskHit {
  id: string;
  text: string;
  done: boolean;
  due?: string;
  priority?: Priority;
  source: TaskSource;
  plan?: NoteRef;
  stage?: string;
}

export interface TasksQueryResponse {
  tasks: TaskHit[];
}

export interface TaskCheckItem {
  id: string;
  done: boolean;
  note?: string;
}

export interface TaskCheckParams {
  tasks: TaskCheckItem[];
}

export interface PlanProgressBrief {
  ref: NoteRef;
  done: number;
  total: number;
}

export interface TaskCheckResponse {
  updated: number;
  progressByPlan: PlanProgressBrief[];
}

export interface PlanTaskDraft {
  text: string;
  due?: string;
}

export interface PlanStageDraft {
  title: string;
  tasks: PlanTaskDraft[];
}

export interface PlanCreateParams {
  title: string;
  goal: string;
  targetDate?: string;
  parent?: NoteRef;
  stages: PlanStageDraft[];
  sources?: NoteRef[];
}

export interface PlanCreateProgress {
  done: number;
  total: number;
}

export interface PlanCreateResponse {
  ref: NoteRef;
  taskIds: string[][];
  progress: PlanCreateProgress;
}

export type PlanUpdateOp =
  | { op: 'add_stage'; title: string; after?: string }
  | { op: 'add_task'; stage: string; text: string; due?: string }
  | { op: 'edit_task'; taskId: string; text?: string; due?: string }
  | { op: 'remove_task'; taskId: string }
  | { op: 'reorder'; order: string[] };

export interface PlanUpdateParams {
  ref: NoteRef;
  rev: Rev;
  ops: PlanUpdateOp[];
}

export interface PlanUpdateResponse {
  revNew: Rev;
  progress: PlanCreateProgress;
}

export interface PlanProgressParams {
  ref?: NoteRef;
  allActive?: boolean;
  stalledDays?: number;
}

export interface PlanProgressResponse {
  plans: PlanProgress[];
}

export interface DistillContextParams {
  ref: NoteRef;
  budgetChars?: number;
}

export type BundleRole = 'source' | 'linked' | 'similar' | 'plan' | 'neighbor';

export interface BundleItem {
  ref: NoteRef;
  role: BundleRole;
  excerpt: string;
}

export interface DistillContextResponse {
  bundle: BundleItem[];
  gaps: string[];
  coverage: number;
}

export interface DistillSections {
  цель: string;
  зачем: string;
  критерии_готовности: string;
  план?: string;
  риски?: string;
  допущения?: string;
  не_думал?: string;
}

export type DistillTargetStatus = 'shaping' | 'planned';

export interface DistillSaveParams {
  ref: NoteRef;
  rev: Rev;
  sections: DistillSections;
  setStatus?: DistillTargetStatus;
  createPlan?: boolean;
}

export interface DistillSaveResponse {
  revNew: Rev;
  planRef?: NoteRef;
}

export interface BufferSaveParams {
  ref: NoteRef;
  baseRev: Rev;
  content: string;
}

export interface IndexStatus {
  state: 'idle' | 'scanning' | 'indexing';
  done: number;
  total: number;
}

export interface UndoResult {
  restoredFiles: number;
  conflicts: string[];
}

export interface ClaudeCliInfo {
  found: boolean;
  path?: string;
  mcpAddCommand: string;
}

export interface SetIconParams {
  ref: NoteRef;
  icon?: string;
  color?: string;
}

export interface SetIconResponse {
  icon?: string;
  color?: string;
}

export interface NotePinParams {
  ref: NoteRef;
  pinned: boolean;
}

export interface NotePinResponse {
  pinned: boolean;
}

export interface BundleComposeParams {
  ref: NoteRef;
  includeLinked?: boolean;
  maxChars?: number;
}

export interface BundleComposeMember {
  ref: NoteRef;
  title: string;
  path: string;
  role: BundleRole;
  chars: number;
}

export interface BundleComposeResponse {
  text: string;
  members: BundleComposeMember[];
  chars: number;
  truncated?: boolean;
}

export interface BundleCreateParams {
  title: string;
  parent?: NoteRef;
  members?: NoteRef[];
  instruction?: string;
}

export interface BundleCreateResponse {
  ref: NoteRef;
  path: string;
  rev: Rev;
  added: number;
}

export interface IdeaToTaskDraft {
  text: string;
  due?: string;
  priority?: Priority;
}

export interface IdeaToTasksParams {
  ref?: NoteRef;
  text?: string;
  createPlan?: boolean;
}

export interface IdeaToTasksResponse {
  tasks: IdeaToTaskDraft[];
  planRef?: NoteRef;
}

export interface AddPathNoteParams {
  paths: string[];
  parent?: NoteRef;
}

export interface AddPathNoteResponse {
  notes: NoteCreateResponse[];
}

export interface SaveAttachmentParams {
  dataBase64: string;
  ext: string;
}

export interface SaveAttachmentFromPathParams {
  srcPath: string;
}

export interface SaveAttachmentResponse {
  relPath: string;
  bytes: number;
  reused: boolean;
}

export type NoteChangeKind = 'created' | 'modified' | 'removed' | 'moved';

export interface NoteChangedEvent {
  ref: NoteRef;
  rev: Rev;
  actor: Actor;
  kind?: NoteChangeKind;
  from?: NoteRef;
}

export interface IndexProgressEvent {
  done: number;
  total: number;
}

export interface JournalOpEvent {
  op: JournalOp;
}

export interface McpSessionEvent {
  active: boolean;
  session?: string;
}
