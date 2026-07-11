# CONTRACT.md — замороженный канон Graphite

Статус: **FROZEN**. Правки — только сборочный агент. Все агенты флота реализуют строго то, что здесь; при расхождении со своим представлением — побеждает этот файл. Источник: docs/SPEC.md (Р1–Р27, §6–§8).

---

## 1. Политики

### 1.1 serde
- **На IPC-границах** (named pipe JSON-RPC, tauri-команды/события, MCP): каждый тип помечен `#[serde(rename_all = "camelCase")]`. Все `Option<T>`-поля — `#[serde(skip_serializing_if = "Option::is_none")]` и `#[serde(default)]` при десериализации: отсутствие поля == None, `null` не эмитим.
- **Внутри Rust-кода** — родные snake_case имена; camelCase существует только в сериализованном виде.
- Enum-значения статусов/типов сериализуются **lowercase** строкой (`#[serde(rename_all = "lowercase")]` на enum), составные — `snake_case` (`RelType::DistilledFrom` → `"distilled_from"`).
- Даты/время: ISO 8601 строки (`created`, `updated`, `ts`); даты без времени — `YYYY-MM-DD`.

### 1.2 Ошибки и конверт
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GraphiteErrorCode {
    NotFound,    // NOT_FOUND
    Conflict,    // CONFLICT (rev-расхождение; в error.data — актуальный rev + дифф)
    Validation,  // VALIDATION
    Ambiguous,   // AMBIGUOUS (в error.data — кандидаты)
    Limit,       // LIMIT
    Forbidden,   // FORBIDDEN (режим read-only)
    Unavailable, // UNAVAILABLE (GUI скрыт, capability отсутствует)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphiteError {
    pub code: GraphiteErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>, // машиночитаемое «что сделать»
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>, // rev/кандидаты/дифф
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub v: String, // всегда "1.0"
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<GraphiteError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
}
```
Конверт: `{v:"1.0", ok:true, data:{…}}` | `{v:"1.0", ok:false, error:{code,message,hint}}`. Инвариант: `ok == data.is_some()`, `!ok == error.is_some()`.

### 1.3 rev
`rev` = **blake3 полного байтового содержимого файла, первые 16 hex-символов** (lowercase). Возвращается каждым чтением; мутации с параметром `rev` при расхождении → `CONFLICT` + актуальный rev + дифф чужих правок в `error.data`. Протокол клиента: перечитать → пере-применить. Тот же blake3 (полный, 64 hex) — в журнале (`blake3:<64hex>`), эхо-подавлении, снапшотах, дедупе вложений (Р11).

### 1.4 id
`id` = **ULID** (26 симв., Crockford base32, uppercase), выдаётся при создании/индексации, неизменяем. Имя файла — представление; id — идентичность. Адресация везде через `ref`: строка `id:01J8…` (рекомендована) или `path:Проекты/Блог.md` (путь от корня vault, `/`-разделители).

### 1.5 Лимиты (канон)
- Ответ ≤ 50 КБ → `truncated:true` + hint «section/offset».
- Списки: `limit/offset`; `vault_tree` limit ≤ 500 (default 200), `search` ≤ 50 (default 20), `tasks_query` default 50, `activity_get` default 100.
- Мутации ≤ 5 rps (превышение → `LIMIT`). Идемпотентность MVP — set-семантика (`task_check`, `link_add`, `set_status`, move/rename: повтор = no-op); `idempotency_key` — v1.
- `schema_version` — SemVer, minor = только добавления. `capabilities[]` — фиче-флаги (`semantic_search` — v1).

---

## 2. Rust-типы ядра (crates/vault-core, реэкспорт из crates/rpc)

Дефолтный derive-набор ниже обозначен `CORE` = `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]` + `#[serde(rename_all = "camelCase")]`. Newtype-ID дополнительно `Eq, Hash, PartialOrd, Ord`.

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteId(pub String); // ULID, 26 симв.

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rev(pub String); // blake3-16hex

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteRef(pub String); // "id:…" | "path:…"

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status { Inbox, Shaping, Planned, Active, Done, Iced }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Todo, Doing, Done, Dropped }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteType { Note, Plan, Project, Task, Journal }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority { Low, Normal, High, Urgent }

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelType {
    Related, PartOf, DependsOn, Blocks, Contradicts, DistilledFrom, CollectedIn,
    #[serde(untagged)]
    Custom(String), // валиден только с префиксом "x-"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Actor { User, Assistant, External }
```

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<NoteId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<NoteType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,        // YYYY-MM-DD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,  // YYYY-MM-DD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,       // plan
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>, // plan, YYYY-MM-DD
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rel: BTreeMap<String, Vec<String>>, // ключ = RelType-строка, значения = "[[…]]"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,    // ISO 8601
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,    // ISO 8601
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_yml::Value>, // произвольные x-поля, round-trip без потерь
}
```

```rust
// CORE-derive у всех структур ниже.

pub struct NoteMeta {
    pub id: NoteId,
    pub path: String,               // от корня vault, "/"-разделители
    pub title: String,              // frontmatter.title | имя файла без .md
    pub r#type: NoteType,
    pub status: Option<Status>,
    pub tags: Vec<String>,          // frontmatter + инлайновые, объединено индексом
    pub updated: String,            // ISO 8601
    pub rev: Rev,
    pub children_count: u32,
}

pub struct Anchor(pub String);      // "^b3k9q" | "^t-8f2k" — хранится без "^"
// serde(transparent), derive как у NoteId

pub struct Block {
    pub note_id: NoteId,
    pub anchor: Option<Anchor>,
    pub heading_path: Vec<String>,  // ["Идея", "Риски"]
    pub text: String,
    pub pos: u32,                   // байтовое смещение начала блока
}

pub struct TaskItem {
    pub id: String,                 // якорь "t-8f2k" (без "^")
    pub note_id: NoteId,
    pub anchor: Anchor,
    pub text: String,
    pub done: bool,
    pub status: TaskStatus,
    pub due: Option<String>,        // из @due(…)
    pub priority: Option<Priority>, // из @p(…)
    pub every: Option<String>,      // из @every(…), зарезервировано, только парсинг
    pub line: u32,                  // 1-based строка в файле-источнике
    pub plan: Option<NoteRef>,
    pub stage: Option<String>,
}

pub struct LinkEdge {
    pub src_id: NoteId,
    pub dst_id: Option<NoteId>,     // None = битая ссылка
    pub dst_raw: String,            // исходный текст "[[…]]" или rel-значение
    pub rel_type: RelType,
    pub block: Option<Anchor>,      // якорь блока-источника
    pub context: Option<String>,
}

pub struct DiffStat { pub plus: u32, pub minus: u32 }

pub struct FileChange {
    pub path: String,
    pub before: Option<String>,     // "blake3:<64hex>"; None = файл создан
    pub after: Option<String>,      // None = файл удалён
}

pub struct JournalOp {
    pub op_id: String,              // ULID
    pub ts: String,                 // ISO 8601
    pub actor: Actor,
    pub session: Option<String>,    // "mcp-01J…"
    pub tool: Option<String>,       // имя инструмента; None у external
    pub summary: String,
    pub files: Vec<FileChange>,
    pub undone: bool,
}

pub struct SearchHit {
    pub r#ref: NoteRef,
    pub title: String,
    pub score: f32,
    pub snippets: Vec<String>,      // ≤3 × ≤300 симв.
    pub updated: String,
}

pub struct TreeNode {
    pub r#ref: NoteRef,
    pub path: String,
    pub title: String,
    pub r#type: NoteType,
    pub status: Option<Status>,
    pub children_count: u32,
    pub updated: String,
}

pub struct StageProgress { pub title: String, pub done: u32, pub total: u32 }

pub struct PlanProgress {
    pub r#ref: NoteRef,
    pub title: String,
    pub percent: f32,
    pub done: u32,
    pub total: u32,
    pub by_stage: Vec<StageProgress>,
    pub overdue: Vec<TaskItem>,
    pub stalled: Vec<TaskItem>,
    pub next_tasks: Vec<TaskItem>,  // ≤3
}
```

```rust
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not found: {0}")]           NotFound(String),
    #[error("rev conflict on {path}")]   Conflict { path: String, current_rev: Rev, diff: Option<String> },
    #[error("validation: {0}")]          Validation(String),
    #[error("ambiguous ref {ref_}")]     Ambiguous { ref_: String, candidates: Vec<NoteMeta> },
    #[error("limit: {0}")]               Limit(String),
    #[error("forbidden: {0}")]           Forbidden(String),
    #[error("unavailable: {0}")]         Unavailable(String),
    #[error("io: {0}")]                  Io(#[from] std::io::Error),
    #[error("index: {0}")]               Index(String),
}
// Маппинг VaultError → GraphiteErrorCode: 1:1 по первым семи вариантам;
// Io/Index → Unavailable (message без внутренних путей, детали — в лог).
```

---

## 3. Реестр 25 инструментов (§7.3, Р25)

Аннотации: RO = readOnlyHint, D = destructiveHint, I = idempotentHint. Исполнитель — функция vault-core (все клиенты — MCP, tauri, RPC — зовут одну и ту же).

| # | Инструмент | RO | D | I | vault-core функция |
|---|---|---|---|---|---|
| 1 | `vault_info` | ✓ | — | ✓ | `vault::info()` |
| 2 | `vault_tree` | ✓ | — | ✓ | `vault::tree(params)` |
| 3 | `note_read` | ✓ | — | ✓ | `notes::read(params)` |
| 4 | `search` | ✓ | — | ✓ | `index::search(params)` |
| 5 | `links_get` | ✓ | — | ✓ | `links::get(params)` |
| 6 | `activity_get` | ✓ | — | ✓ | `history::activity(params)` |
| 7 | `context_briefing` | ✓ | — | ✓ | `vault::briefing()` |
| 8 | `note_create` | — | — | — | `notes::create(params)` |
| 9 | `note_edit` | — | — | — | `notes::edit(params)` |
| 10 | `note_move` | — | — | ✓ | `notes::mv(params)` |
| 11 | `note_rename` | — | — | ✓ | `notes::rename(params)` |
| 12 | `note_delete` | — | ✓ | ✓ | `notes::delete(params)` |
| 13 | `note_restore` | — | — | ✓ | `notes::restore(params)` |
| 14 | `set_status` | — | — | ✓ | `notes::set_status(params)` |
| 15 | `link_add` | — | — | ✓ | `links::add(params)` |
| 16 | `link_remove` | — | — | ✓ | `links::remove(params)` |
| 17 | `tasks_query` | ✓ | — | ✓ | `tasks::query(params)` |
| 18 | `task_check` | — | — | ✓ | `tasks::check(params)` |
| 19 | `plan_create` | — | — | — | `plans::create(params)` |
| 20 | `plan_update` | — | — | — | `plans::update(params)` |
| 21 | `plan_progress` | ✓ | — | ✓ | `plans::progress(params)` |
| 22 | `distill_context` | ✓ | — | ✓ | `distill::context(params)` |
| 23 | `distill_save` | — | — | — | `distill::save(params)` |
| 24 | `ui_open_note` | — | — | ✓ | `ui_bridge::open_note(ref)` |
| 25 | `ui_flash_note` | — | — | ✓ | `ui_bridge::flash_note(ref)` |

Мутации (8–16, 18–20, 23) проходят рейт-лимит 5 rps и журналируются; в режиме vault `read-only` возвращают `FORBIDDEN`. TS-зеркала всех структур — §6 (механическое правило М1), имена совпадают.

### 3.1 Навигация и чтение

```rust
// CORE-derive у всех Params/Response.

pub struct VaultInfoResponse {
    pub schema_version: String,
    pub vault_format: String,
    pub root: String,                     // абсолютный путь корня vault
    pub counts: VaultCounts,
    pub capabilities: Vec<String>,        // MVP: []; v1: ["semantic_search", …]
    pub limits: VaultLimits,
    pub conventions_digest: String,
}
pub struct VaultCounts { pub notes: u32, pub plans: u32, pub tasks_open: u32, pub inbox: u32 }
pub struct VaultLimits {
    pub max_response_bytes: u32,          // 51200
    pub tree_limit_max: u32,              // 500
    pub search_limit_max: u32,            // 50
    pub mutations_rps: u32,               // 5
}

pub struct VaultTreeParams {
    pub root: Option<NoteRef>,
    pub depth: Option<u32>,               // default 2
    pub types: Option<Vec<NoteType>>,
    pub limit: Option<u32>,               // default 200, max 500
    pub offset: Option<u32>,
}
pub struct VaultTreeResponse { pub nodes: Vec<TreeNode>, pub total: u32 }

#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum NoteReadInclude { Links, Backlinks, Children, Tasks }

pub struct NoteReadParams {
    pub r#ref: NoteRef,
    pub include: Option<Vec<NoteReadInclude>>,
    pub section: Option<String>,          // заголовок секции
    pub offset: Option<u32>,              // символьное смещение в content
    pub max_chars: Option<u32>,           // default 20000
}
pub struct NoteReadResponse {
    pub frontmatter: Frontmatter,
    pub content: String,
    pub rev: Rev,
    pub truncated: Option<bool>,
    pub links: Option<Vec<LinkEdge>>,
    pub backlinks: Option<Vec<LinkEdge>>,
    pub children: Option<Vec<TreeNode>>,
    pub tasks: Option<Vec<TaskItem>>,
}

#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode { Keyword, Semantic, Hybrid } // default Keyword; semantic|hybrid без capability → UNAVAILABLE

pub struct SearchFilters {
    pub r#type: Option<NoteType>,
    pub status: Option<Status>,
    pub tags: Option<Vec<String>>,
    pub path: Option<String>,
    pub updated_after: Option<String>,
    pub updated_before: Option<String>,
    pub due_before: Option<String>,
}
pub struct SearchParams {
    pub query: String,                    // операторы: "фраза", -минус, tag:, type:, status:
    pub mode: Option<SearchMode>,
    pub filters: Option<SearchFilters>,
    pub limit: Option<u32>,               // default 20, max 50
    pub offset: Option<u32>,
}
pub struct SearchResponse { pub hits: Vec<SearchHit>, pub total: Option<u32> }

#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum LinkDirection { Out, In, Both } // default Both

pub struct LinksGetParams { pub r#ref: NoteRef, pub direction: Option<LinkDirection>, pub types: Option<Vec<RelType>> }
pub struct LinkOut { pub to: NoteRef, pub r#type: RelType, pub context: Option<String> }
pub struct LinkIn { pub from: NoteRef, pub r#type: RelType }
pub struct LinksGetResponse { pub out: Vec<LinkOut>, pub r#in: Vec<LinkIn> }

#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum ActorFilter { User, Assistant, External, All } // default All

pub struct ActivityGetParams {
    pub since: String,                    // "-7d" | ISO 8601
    pub scope: Option<NoteRef>,
    pub actor: Option<ActorFilter>,
    pub limit: Option<u32>,               // default 100
}
pub struct ActivityEvent { pub ts: String, pub actor: Actor, pub tool: Option<String>, pub summary: String, pub refs: Vec<NoteRef> }
pub struct ActivityGetResponse { pub events: Vec<ActivityEvent> }

pub struct NextStep { pub plan: NoteRef, pub task: TaskItem }
pub struct StalledNote { pub r#ref: NoteRef, pub days: u32 }
pub struct ContextBriefingResponse {
    pub inbox_count: u32,
    pub next_steps: Vec<NextStep>,
    pub stalled: Vec<StalledNote>,
    pub overdue: Vec<TaskItem>,
    pub recent: Vec<NoteMeta>,
    pub suggest_distill: Vec<NoteRef>,    // ≤3
}
```

### 3.2 Создание и правка (rev-защита)

```rust
pub struct NoteCreateParams {
    pub parent: Option<NoteRef>,
    pub title: String,
    pub r#type: Option<NoteType>,         // default Note
    pub status: Option<Status>,           // default Inbox
    pub tags: Option<Vec<String>>,
    pub content: Option<String>,          // markdown-тело
    pub template: Option<String>,
}
pub struct NoteCreateResponse { pub r#ref: NoteRef, pub path: String, pub rev: Rev }

#[serde(tag = "op", rename_all = "snake_case")]
pub enum NoteEditOp {
    Replace { old_string: String, new_string: String }, // old_string обязан встречаться ровно один раз
    AppendSection { heading: String, content: String },
    ReplaceSection { heading: String, content: String }, // исчезнувший заголовок → NOT_FOUND + hint
    Prepend { content: String },
    SetFrontmatter { key: String, value: serde_json::Value },
}
pub struct NoteEditParams { pub r#ref: NoteRef, pub rev: Rev, pub ops: Vec<NoteEditOp> }
pub struct NoteEditResponse { pub rev_new: Rev, pub diff_stat: DiffStat }

pub struct NoteMoveParams { pub r#ref: NoteRef, pub new_parent: NoteRef, pub position: Option<f64> }
pub struct NoteMoveResponse { pub path_new: String, pub links_rewritten: u32 }

pub struct NoteRenameParams { pub r#ref: NoteRef, pub new_title: String }
pub struct NoteRenameResponse { pub path_new: String, pub links_updated: u32, pub alias_added: bool }

pub struct NoteDeleteParams { pub r#ref: NoteRef }
pub struct NoteDeleteResponse { pub restore_token: String, pub backlinks_broken: u32 }

pub struct NoteRestoreParams { pub restore_token: Option<String>, pub r#ref: Option<NoteRef> } // ровно одно из двух, иначе VALIDATION
pub struct NoteRestoreResponse { pub r#ref: NoteRef, pub path: String }

pub struct SetStatusParams { pub r#ref: NoteRef, pub status: Status, pub reason: Option<String> }
pub struct SetStatusResponse { pub old: Option<Status>, pub new: Status }
```

### 3.3 Связи

```rust
pub struct LinkAddParams { pub from: NoteRef, pub to: NoteRef, pub r#type: Option<RelType>, pub context: Option<String> } // type default Related
pub struct LinkAddResponse { pub created: bool }    // дубль → false (set-семантика)

pub struct LinkRemoveParams { pub from: NoteRef, pub to: NoteRef, pub r#type: Option<RelType> }
pub struct LinkRemoveResponse { pub removed: bool }
```

### 3.4 Задачи и планы

```rust
#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusFilter { Open, Done, All } // default Open

pub struct TasksQueryParams {
    pub scope: Option<NoteRef>,
    pub status: Option<TaskStatusFilter>,
    pub due_before: Option<String>,
    pub overdue: Option<bool>,
    pub plan: Option<NoteRef>,
    pub limit: Option<u32>,               // default 50
}
pub struct TaskSource { pub r#ref: NoteRef, pub anchor: Anchor }
pub struct TaskHit {
    pub id: String, pub text: String, pub done: bool,
    pub due: Option<String>, pub priority: Option<Priority>,
    pub source: TaskSource, pub plan: Option<NoteRef>, pub stage: Option<String>,
}
pub struct TasksQueryResponse { pub tasks: Vec<TaskHit> }

pub struct TaskCheckItem { pub id: String, pub done: bool, pub note: Option<String> }
pub struct TaskCheckParams { pub tasks: Vec<TaskCheckItem> } // set-семантика, не toggle
pub struct PlanProgressBrief { pub r#ref: NoteRef, pub done: u32, pub total: u32 }
pub struct TaskCheckResponse { pub updated: u32, pub progress_by_plan: Vec<PlanProgressBrief> }

pub struct PlanTaskDraft { pub text: String, pub due: Option<String> }
pub struct PlanStageDraft { pub title: String, pub tasks: Vec<PlanTaskDraft> }
pub struct PlanCreateParams {
    pub title: String,
    pub goal: String,
    pub target_date: Option<String>,
    pub parent: Option<NoteRef>,
    pub stages: Vec<PlanStageDraft>,
    pub sources: Option<Vec<NoteRef>>,    // линкуются distilled_from
}
pub struct PlanCreateProgress { pub done: u32, pub total: u32 }
pub struct PlanCreateResponse { pub r#ref: NoteRef, pub task_ids: Vec<Vec<String>>, pub progress: PlanCreateProgress }

#[serde(tag = "op", rename_all = "snake_case")]
pub enum PlanUpdateOp {
    AddStage { title: String, after: Option<String> },
    AddTask { stage: String, text: String, due: Option<String> },
    EditTask { task_id: String, text: Option<String>, due: Option<String> },
    RemoveTask { task_id: String },
    Reorder { order: Vec<String> },
}
pub struct PlanUpdateParams { pub r#ref: NoteRef, pub rev: Rev, pub ops: Vec<PlanUpdateOp> }
pub struct PlanUpdateResponse { pub rev_new: Rev, pub progress: PlanCreateProgress }

pub struct PlanProgressParams {
    pub r#ref: Option<NoteRef>,
    pub all_active: Option<bool>,         // default true
    pub stalled_days: Option<u32>,        // default 7
}
pub struct PlanProgressResponse { pub plans: Vec<PlanProgress> }
```

### 3.5 Выжимка

```rust
pub struct DistillContextParams { pub r#ref: NoteRef, pub budget_chars: Option<u32> } // default 30000

#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum BundleRole { Source, Linked, Similar, Plan, Neighbor } // Similar — с v1

pub struct BundleItem { pub r#ref: NoteRef, pub role: BundleRole, pub excerpt: String }
pub struct DistillContextResponse {
    pub bundle: Vec<BundleItem>,
    pub gaps: Vec<String>,                // "goal" | "why" | "done_criteria" | "first_step" | …
    pub coverage: f32,                    // 0..1 — сколько влезло в бюджет
}

pub struct DistillSections {
    #[serde(rename = "цель")]                pub goal: String,
    #[serde(rename = "зачем")]               pub why: String,
    #[serde(rename = "критерии_готовности")] pub done_criteria: String,
    #[serde(rename = "план", default, skip_serializing_if = "Option::is_none")]      pub plan: Option<String>,
    #[serde(rename = "риски", default, skip_serializing_if = "Option::is_none")]     pub risks: Option<String>,
    #[serde(rename = "допущения", default, skip_serializing_if = "Option::is_none")] pub assumptions: Option<String>,
    #[serde(rename = "не_думал", default, skip_serializing_if = "Option::is_none")]  pub blind_spots: Option<String>,
}
#[derive(..., Copy)]
#[serde(rename_all = "lowercase")]
pub enum DistillTargetStatus { Shaping, Planned }

pub struct DistillSaveParams {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub sections: DistillSections,        // обязательные: цель, зачем, критерии; иначе VALIDATION
    pub set_status: Option<DistillTargetStatus>,
    pub create_plan: Option<bool>,        // default false
}
pub struct DistillSaveResponse { pub rev_new: Rev, pub plan_ref: Option<NoteRef> }
```

### 3.6 UI-мост

```rust
pub struct UiNoteParams { pub r#ref: NoteRef }    // общий для ui_open_note / ui_flash_note
pub struct UiNoteResponse { pub ok: bool }         // GUI скрыт/закрыт → UNAVAILABLE + hint (не ошибка сценария)
```

Пометка `#[derive(..., Copy)]` в блоках выше = CORE-derive + `Copy, Eq, Hash`. Все enum-теги (`op`) — snake_case литералы: `"replace"`, `"append_section"`, `"replace_section"`, `"prepend"`, `"set_frontmatter"`, `"add_stage"`, `"add_task"`, `"edit_task"`, `"remove_task"`, `"reorder"`.

---

## 4. IPC-протокол между процессами (crates/rpc)

### 4.1 Транспорт
- **JSON-RPC 2.0** поверх named pipe **`\\.\pipe\graphite-core`** (crate `interprocess 2`). Сервер — ядро внутри `graphite.exe`; клиенты — `graphite-mcp.exe` и потенциально другие локальные процессы.
- **Кадр = ровно одна строка JSON**, терминатор `\n` (NDJSON). Внутри кадра `\n` не встречается (JSON-escape). Максимальный кадр — 1 МиБ; больше → соединение закрывается с ошибкой.
- Аутентификация: первым полем `token` в `hello` — локальный токен из `.graphite/runtime.json` (генерится ядром при старте). Неверный токен → `FORBIDDEN` и разрыв.

### 4.2 Рукопожатие
```json
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"token":"…","client":"graphite-mcp/0.1.0","schemaVersion":"1.0"}}
← {"jsonrpc":"2.0","id":1,"result":{"v":"1.0","ok":true,"data":{"schemaVersion":"1.0","vaultFormat":"1","capabilities":[]}}}
```
Мажор `schemaVersion` не совпал → ошибка `VALIDATION` с hint «обнови graphite-mcp» и разрыв. До успешного `hello` любой другой метод → `FORBIDDEN`.

### 4.3 Методы
- **Все 25 инструментов §3** — имя метода = имя инструмента (`note_edit`, `plan_progress`, …), `params` = Params-структура, `result` = конверт §1.2 с Response-структурой.
- **`ui_open_note` / `ui_flash_note`** — форвардятся ядром в окно (tauri emit); окна нет → `UNAVAILABLE`.
- **Служебные:**

| Метод | params | result.data |
|---|---|---|
| `hello` | `{token, client, schemaVersion}` | `{schemaVersion, vaultFormat, capabilities[]}` |
| `index_status` | `{}` | `{state:"idle"\|"scanning"\|"indexing", done:u32, total:u32}` |
| `reindex` | `{full?:bool}` | `{started:bool}` |

### 4.4 Ошибки и таймауты
- Доменные ошибки — **внутри `result`** конвертом `{ok:false, error:{code,message,hint}}` (коды §1.1). JSON-RPC `error` — только транспорт/протокол: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32000` internal.
- Таймауты клиента: `hello` — 2 с; read-методы — 10 с; мутации и `reindex` — 30 с. Таймаут → закрыть соединение, переподключиться, ретраить **только** идемпотентные (§3 колонка I).
- Автозапуск (Р20): `graphite-mcp` не нашёл pipe → spawn `graphite.exe --hidden` → поллинг pipe до **10 с** (шаг 250 мс) → не поднялся → ошибка с hint «запустите Graphite вручную».
- Уведомлений (server→client push) в MVP нет; MCP-клиент опрашивает.

---

## 5. Tauri-команды и события (apps/desktop/src-tauri)

Каждая команда — тонкая обёртка над той же функцией vault-core, что и в §3; регистрируются через **tauri-specta**, TS-биндинги генерятся в `packages/bindings` (ноль ручных DTO). Возврат — `Result<T, GraphiteError>` (specta сериализует Err в тот же error-объект §1.2; конверт `{v,ok}` на tauri-границе не используется — его роль играет Result).

```rust
#[tauri::command] #[specta::specta] fn vault_info() -> Result<VaultInfoResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn vault_tree(params: VaultTreeParams) -> Result<VaultTreeResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_read(params: NoteReadParams) -> Result<NoteReadResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn search(params: SearchParams) -> Result<SearchResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn links_get(params: LinksGetParams) -> Result<LinksGetResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn activity_get(params: ActivityGetParams) -> Result<ActivityGetResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn context_briefing() -> Result<ContextBriefingResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_create(params: NoteCreateParams) -> Result<NoteCreateResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_edit(params: NoteEditParams) -> Result<NoteEditResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_move(params: NoteMoveParams) -> Result<NoteMoveResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_rename(params: NoteRenameParams) -> Result<NoteRenameResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_delete(params: NoteDeleteParams) -> Result<NoteDeleteResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn note_restore(params: NoteRestoreParams) -> Result<NoteRestoreResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn set_status(params: SetStatusParams) -> Result<SetStatusResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn link_add(params: LinkAddParams) -> Result<LinkAddResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn link_remove(params: LinkRemoveParams) -> Result<LinkRemoveResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn tasks_query(params: TasksQueryParams) -> Result<TasksQueryResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn task_check(params: TaskCheckParams) -> Result<TaskCheckResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn plan_create(params: PlanCreateParams) -> Result<PlanCreateResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn plan_update(params: PlanUpdateParams) -> Result<PlanUpdateResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn plan_progress(params: PlanProgressParams) -> Result<PlanProgressResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn distill_context(params: DistillContextParams) -> Result<DistillContextResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn distill_save(params: DistillSaveParams) -> Result<DistillSaveResponse, GraphiteError>;
```

UI-специфичные команды (нет в MCP-реестре):

```rust
#[tauri::command] #[specta::specta] fn buffer_save(params: BufferSaveParams) -> Result<NoteEditResponse, GraphiteError>;
// BufferSaveParams { ref, base_rev, content } — полный текст буфера; 3-way при расхождении base_rev (Р10)
#[tauri::command] #[specta::specta] fn index_status() -> Result<IndexStatus, GraphiteError>;   // IndexStatus { state, done, total }
#[tauri::command] #[specta::specta] fn reindex(full: bool) -> Result<(), GraphiteError>;
#[tauri::command] #[specta::specta] fn undo_op(op_id: String) -> Result<UndoResult, GraphiteError>;      // UndoResult { restored_files: u32, conflicts: Vec<String> }
#[tauri::command] #[specta::specta] fn undo_session(session: String) -> Result<UndoResult, GraphiteError>;
#[tauri::command] #[specta::specta] fn journal_list(params: ActivityGetParams) -> Result<Vec<JournalOp>, GraphiteError>;
#[tauri::command] #[specta::specta] fn vault_open(path: String) -> Result<VaultInfoResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn vault_create(path: String) -> Result<VaultInfoResponse, GraphiteError>;
#[tauri::command] #[specta::specta] fn detect_claude_cli() -> Result<ClaudeCliInfo, GraphiteError>;      // ClaudeCliInfo { found: bool, path: Option<String>, mcp_add_command: String }
#[tauri::command] #[specta::specta] fn quick_capture(text: String) -> Result<NoteCreateResponse, GraphiteError>; // всегда в Входящие, status inbox (Р18)
```

### 5.1 События (tauri emit, camelCase payload)

| Событие | Payload | Когда |
|---|---|---|
| `note_changed` | `{ref: NoteRef, rev: Rev, actor: Actor, kind?: created\|modified\|removed\|moved\|bufferbody, from?: NoteRef}` | файл изменился на диске (свой write, MCP, external) — UI решает reload/merge; `bufferbody` = автосейв тела из редактора (структура vault не менялась, дерево/счётчики обновляются лениво) |
| `index_progress` | `{done: u32, total: u32}` | ход индексации; `done == total` → idle |
| `journal_op` | `{op: JournalOp}` | новая запись журнала → AI-лента |
| `mcp_session` | `{active: bool, session: Option<String>}` | MCP-сессия открылась/закрылась → пульс ◈ в статусбаре |
| `ui_open_note` | `{ref: NoteRef}` | запрос агента открыть заметку |
| `ui_flash_note` | `{ref: NoteRef}` | запрос агента подсветить в дереве |

---

## 6. TS-типы-зеркала (packages/bindings)

Канонический генератор — tauri-specta; файл `packages/bindings/src/types.ts` в репо коммитится (флот UI работает по нему до появления генерации). **Правило М1 (механическое зеркало):** Rust-имя типа = TS-имя; snake_case поле → camelCase; `Option<T>` → `field?: T` (поле отсутствует, не `null`); `Vec<T>` → `T[]`; `u32/f32/f64` → `number`; newtype(`NoteId`,`Rev`,`NoteRef`,`Anchor`) → branded string; `BTreeMap<String,V>` → `Record<string, V>`; lowercase-enum → строковый union; tagged-enum (`op`) → discriminated union. Params/Response всех 25 инструментов зеркалятся по М1 без исключений.

```ts
export type NoteId = string;   // ULID
export type Rev = string;      // blake3-16hex
export type NoteRef = string;  // "id:…" | "path:…"
export type Anchor = string;   // без "^"

export type Status = "inbox" | "shaping" | "planned" | "active" | "done" | "iced";
export type TaskStatus = "todo" | "doing" | "done" | "dropped";
export type NoteType = "note" | "plan" | "project" | "task" | "journal";
export type Priority = "low" | "normal" | "high" | "urgent";
export type RelType =
  | "related" | "part_of" | "depends_on" | "blocks"
  | "contradicts" | "distilled_from" | "collected_in"
  | (string & {}); // кастомные "x-…"
export type Actor = "user" | "assistant" | "external";
export type GraphiteErrorCode =
  | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "AMBIGUOUS"
  | "LIMIT" | "FORBIDDEN" | "UNAVAILABLE";

export interface GraphiteError {
  code: GraphiteErrorCode;
  message: string;
  hint?: string;
  data?: unknown;
}

export interface Frontmatter {
  id?: NoteId; type?: NoteType; title?: string;
  aliases?: string[]; tags?: string[];
  status?: Status; priority?: Priority;
  due?: string; scheduled?: string;
  goal?: string; targetDate?: string;
  rel?: Record<string, string[]>;
  sort?: number; created?: string; updated?: string;
  [x: string]: unknown; // произвольные x-поля
}

export interface NoteMeta {
  id: NoteId; path: string; title: string; type: NoteType;
  status?: Status; tags: string[]; updated: string; rev: Rev;
  childrenCount: number;
}

export interface TaskItem {
  id: string; noteId: NoteId; anchor: Anchor; text: string;
  done: boolean; status: TaskStatus;
  due?: string; priority?: Priority; every?: string;
  line: number; plan?: NoteRef; stage?: string;
}

export interface LinkEdge {
  srcId: NoteId; dstId?: NoteId; dstRaw: string;
  relType: RelType; block?: Anchor; context?: string;
}

export interface DiffStat { plus: number; minus: number }
export interface FileChange { path: string; before?: string; after?: string }

export interface JournalOp {
  opId: string; ts: string; actor: Actor;
  session?: string; tool?: string; summary: string;
  files: FileChange[]; undone: boolean;
}

export interface SearchHit {
  ref: NoteRef; title: string; score: number;
  snippets: string[]; updated: string;
}

export interface TreeNode {
  ref: NoteRef; path: string; title: string; type: NoteType;
  status?: Status; childrenCount: number; updated: string;
}

export interface StageProgress { title: string; done: number; total: number }
export interface PlanProgress {
  ref: NoteRef; title: string; percent: number; done: number; total: number;
  byStage: StageProgress[]; overdue: TaskItem[]; stalled: TaskItem[]; nextTasks: TaskItem[];
}

export type NoteEditOp =
  | { op: "replace"; oldString: string; newString: string }
  | { op: "append_section"; heading: string; content: string }
  | { op: "replace_section"; heading: string; content: string }
  | { op: "prepend"; content: string }
  | { op: "set_frontmatter"; key: string; value: unknown };

export type PlanUpdateOp =
  | { op: "add_stage"; title: string; after?: string }
  | { op: "add_task"; stage: string; text: string; due?: string }
  | { op: "edit_task"; taskId: string; text?: string; due?: string }
  | { op: "remove_task"; taskId: string }
  | { op: "reorder"; order: string[] };

export interface IndexStatus { state: "idle" | "scanning" | "indexing"; done: number; total: number }

export interface NoteChangedEvent { ref: NoteRef; rev: Rev; actor: Actor }
export interface IndexProgressEvent { done: number; total: number }
export interface JournalOpEvent { op: JournalOp }
export interface McpSessionEvent { active: boolean; session?: string }
```

---

## 7. Дерево React-компонентов (apps/desktop/src)

Лейаут: rail **48px** / дерево **240–360px** (resize) / центр (flex) / правая панель **300px** (toggle) / статусбар **28px**. Акценты: ирис `#8B93FF` (человек), бирюза `#4FD6BE` (ИИ) — токены в `packages/ui`.

```
AppShell                                   src/app/AppShell.tsx
├─ Rail                                    src/components/rail/Rail.tsx
├─ TreePanel                               src/components/tree/TreePanel.tsx
├─ main
│  ├─ TabBar                               src/components/tabs/TabBar.tsx
│  └─ EditorPane | PlanView | SettingsView
│     EditorPane                           src/components/editor/EditorPane.tsx
│     PlanView                             src/components/plan/PlanView.tsx
│     SettingsView                         src/components/settings/SettingsView.tsx
├─ RightPanel                              src/components/right/RightPanel.tsx
│  ├─ PropertiesTab                        src/components/right/PropertiesTab.tsx
│  ├─ AiFeedTab                            src/components/right/AiFeedTab.tsx
│  └─ LinksTab                             src/components/right/LinksTab.tsx
├─ StatusBar                               src/components/statusbar/StatusBar.tsx
├─ CommandPalette                          src/components/palette/CommandPalette.tsx
└─ FirstRunFlow                            src/components/firstrun/FirstRunFlow.tsx
QuickCaptureWindow (отдельное tauri-окно)  src/windows/quick-capture/QuickCaptureWindow.tsx
```

Пропсы (всё остальное компоненты берут из сторов §8 сами):

| Компонент | Пропсы |
|---|---|
| `AppShell` | `{}` — корень, вешает tauri-listeners → сторы |
| `Rail` | `{}` — иконки видов (дерево/поиск/план/настройки), активный вид из uiStore |
| `TreePanel` | `{width: number; onWidthChange: (w: number) => void}` — react-arborist, данные из vaultStore |
| `TabBar` | `{}` — из tabsStore; вкладки ремапятся по id при переименовании |
| `EditorPane` | `{tabId: string; noteRef: NoteRef}` — CM6 live-preview, автосейв 500 мс → `buffer_save` |
| `PlanView` | `{noteRef: NoteRef}` — рендер плана: стадии, чекбоксы (клик → `task_check`), прогресс |
| `RightPanel` | `{tab: "properties" \| "aiFeed" \| "links"}` |
| `PropertiesTab` | `{noteRef: NoteRef}` — frontmatter-форма (status/tags/priority/due/x-поля) |
| `AiFeedTab` | `{}` — карточки JournalOp из aiFeedStore, группировка по session, кнопки Отменить/Отменить сессию (`undo_op`/`undo_session`), инлайн-дифф |
| `LinksTab` | `{noteRef: NoteRef}` — out/in из `links_get` |
| `StatusBar` | `{}` — индекс-прогресс, счётчики, пульс ◈ при `mcpSession.active` |
| `CommandPalette` | `{}` — cmdk, Ctrl+K, открыт из uiStore, стриминг `search` |
| `QuickCaptureWindow` | `{}` — глобальный хоткей Ctrl+Alt+Space; один инпут → `quick_capture` → закрыть (< 150 мс, Р18) |
| `SettingsView` | `{}` — vault, MCP-доступ (`detect_claude_cli`), хоткеи, обновления |
| `FirstRunFlow` | `{onDone: () => void}` — визард §8.7: vault → импорт → ассистент → хоткей → подсказка |

---

## 8. Zustand-сторы (apps/desktop/src/stores)

Zustand 5, по одному файлу на срез. Только UI-стейт и кэш ответов ядра; истина всегда на диске.

```ts
// stores/vaultStore.ts
interface VaultStore {
  info?: VaultInfoResponse;
  tree: TreeNode[];                       // плоский кэш; иерархия по path
  expanded: Set<string>;                  // path-ы раскрытых узлов
  currentRef?: NoteRef;
  indexStatus: IndexStatus;
  loadInfo(): Promise<void>;
  loadTree(root?: NoteRef): Promise<void>;
  openNote(ref: NoteRef): void;           // делегирует tabsStore.open + currentRef
  applyNoteChanged(e: NoteChangedEvent): void; // тихий reload чистой заметки / merge-баннер грязной
  setIndexStatus(s: IndexProgressEvent): void;
  toggleExpanded(path: string): void;
}

// stores/tabsStore.ts
interface Tab { id: string; noteRef: NoteRef; title: string; dirty: boolean; kind: "editor" | "plan" | "settings" }
interface TabsStore {
  tabs: Tab[];
  activeId?: string;
  open(ref: NoteRef, kind?: Tab["kind"]): void;   // уже открыт → активировать
  close(id: string): void;                         // dirty → подтверждение через uiStore
  activate(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  remapRef(oldRef: NoteRef, next: { ref: NoteRef; title: string }): void; // rename/move по id
}

// stores/uiStore.ts
interface Toast { id: string; kind: "info" | "success" | "error"; text: string }
interface UiStore {
  railView: "tree" | "search" | "plan" | "settings";
  rightPanelOpen: boolean;
  rightPanelTab: "properties" | "aiFeed" | "links";
  treeWidth: number;                      // 240–360
  paletteOpen: boolean;
  toasts: Toast[];
  firstRun: boolean;
  setRailView(v: UiStore["railView"]): void;
  toggleRightPanel(tab?: UiStore["rightPanelTab"]): void; // Ctrl+Shift+A → aiFeed
  setTreeWidth(w: number): void;
  setPaletteOpen(open: boolean): void;    // Ctrl+K
  pushToast(t: Omit<Toast, "id">): void;
  dismissToast(id: string): void;
  finishFirstRun(): void;
}

// stores/aiFeedStore.ts
interface AiFeedStore {
  ops: JournalOp[];                       // новые сверху
  sessionActive: boolean;
  currentSession?: string;
  unseenRefs: Set<NoteRef>;               // точка --ai в дереве
  filter: { actor?: Actor; scope?: NoteRef };
  append(op: JournalOp): void;            // из события journal_op
  setSession(e: McpSessionEvent): void;
  markSeen(ref: NoteRef): void;
  undoOp(opId: string): Promise<void>;    // tauri undo_op → пометить undone
  undoSession(session: string): Promise<void>;
  setFilter(f: AiFeedStore["filter"]): void;
  loadRecent(): Promise<void>;            // journal_list при старте
}
```

Подписки на tauri-события вешает `AppShell` один раз: `note_changed → vaultStore.applyNoteChanged`, `index_progress → vaultStore.setIndexStatus`, `journal_op → aiFeedStore.append`, `mcp_session → aiFeedStore.setSession`, `ui_open_note → vaultStore.openNote`, `ui_flash_note → подсветка в TreePanel`.

---

## 9. Карта владения файлами

| Модуль (агент) | Пути (владение эксклюзивно) |
|---|---|
| **vault-core** | `crates/vault-core/**` |
| **history** | `crates/history/**` |
| **rpc** | `crates/rpc/**` (типы протокола §1–§3 живут здесь, vault-core их реэкспортирует) |
| **mcp** | `crates/graphite-mcp/**` |
| **semantics (v1)** | `crates/semantics/**` |
| **tauri-shell** | `apps/desktop/src-tauri/**` |
| **ui-shell** | `apps/desktop/src/app/**`, `apps/desktop/src/stores/**`, `apps/desktop/src/windows/**` |
| **ui-tree** | `apps/desktop/src/components/tree/**`, `rail/**`, `tabs/**`, `statusbar/**` |
| **ui-editor** | `packages/editor/**`, `apps/desktop/src/components/editor/**` |
| **ui-right** | `apps/desktop/src/components/right/**`, `palette/**` |
| **ui-views** | `apps/desktop/src/components/plan/**`, `settings/**`, `firstrun/**` |
| **design-tokens** | `packages/ui/**` |
| **bindings** | `packages/bindings/**` |
| **docs** | `docs/**` |

Правила флота:
1. **Манифесты** (`Cargo.toml` workspace и крейтов, `package.json`, `pnpm-workspace.yaml`, `tauri.conf.json`) и **CONTRACT.md** правит только сборочный агент. Нужна зависимость — заявить в отчёте, не трогать файл.
2. **В vault пишет только vault-core** (инвариант «один писатель», §8.2): любой `std::fs`-write в пользовательскую папку вне `crates/vault-core` = блокер. UI и MCP — равноправные клиенты одного API.
3. Типы из §2–§3 объявляются **один раз** в `crates/rpc`; дубли в других крейтах запрещены. TS-типы — только `packages/bindings`.
4. Чужую зону не редактировать даже «по мелочи»; интеграционные несостыковки — в отчёт сборочному агенту.
5. Всё, чего нет в этом файле (сигнатура, поле, код ошибки), — не выдумывать: реализовать минимально и заявить в отчёте.

