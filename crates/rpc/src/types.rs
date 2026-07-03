//! Канонические типы ядра и реестра инструментов (CONTRACT §2–§3).
//! Объявлены один раз здесь; `vault-core` и остальные крейты реэкспортируют.

use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rev(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteRef(pub String);

/// Якорь блока/задачи, хранится без ведущего `^`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Anchor(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Inbox,
    Shaping,
    Planned,
    Active,
    Done,
    Iced,
}

impl Status {
    pub const ALL: [Status; 6] = [
        Status::Inbox,
        Status::Shaping,
        Status::Planned,
        Status::Active,
        Status::Done,
        Status::Iced,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Inbox => "inbox",
            Status::Shaping => "shaping",
            Status::Planned => "planned",
            Status::Active => "active",
            Status::Done => "done",
            Status::Iced => "iced",
        }
    }
}

impl FromStr for Status {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown status: {s}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Todo,
    Doing,
    Done,
    Dropped,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 4] = [
        TaskStatus::Todo,
        TaskStatus::Doing,
        TaskStatus::Done,
        TaskStatus::Dropped,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::Doing => "doing",
            TaskStatus::Done => "done",
            TaskStatus::Dropped => "dropped",
        }
    }
}

impl FromStr for TaskStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown task status: {s}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteType {
    Note,
    Plan,
    Project,
    Task,
    Journal,
}

impl NoteType {
    pub const ALL: [NoteType; 5] = [
        NoteType::Note,
        NoteType::Plan,
        NoteType::Project,
        NoteType::Task,
        NoteType::Journal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            NoteType::Note => "note",
            NoteType::Plan => "plan",
            NoteType::Project => "project",
            NoteType::Task => "task",
            NoteType::Journal => "journal",
        }
    }
}

impl FromStr for NoteType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown note type: {s}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
    Urgent,
}

impl Priority {
    pub const ALL: [Priority; 4] = [
        Priority::Low,
        Priority::Normal,
        Priority::High,
        Priority::Urgent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Normal => "normal",
            Priority::High => "high",
            Priority::Urgent => "urgent",
        }
    }
}

impl FromStr for Priority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown priority: {s}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelType {
    Related,
    PartOf,
    DependsOn,
    Blocks,
    Contradicts,
    DistilledFrom,
    CollectedIn,
    /// Кастомный тип связи, валиден только с префиксом `x-`.
    #[serde(untagged)]
    Custom(String),
}

impl RelType {
    pub const KNOWN: [RelType; 7] = [
        RelType::Related,
        RelType::PartOf,
        RelType::DependsOn,
        RelType::Blocks,
        RelType::Contradicts,
        RelType::DistilledFrom,
        RelType::CollectedIn,
    ];

    pub const CUSTOM_PREFIX: &'static str = "x-";

    pub fn as_str(&self) -> &str {
        match self {
            RelType::Related => "related",
            RelType::PartOf => "part_of",
            RelType::DependsOn => "depends_on",
            RelType::Blocks => "blocks",
            RelType::Contradicts => "contradicts",
            RelType::DistilledFrom => "distilled_from",
            RelType::CollectedIn => "collected_in",
            RelType::Custom(s) => s,
        }
    }
}

impl FromStr for RelType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Some(known) = Self::KNOWN.iter().find(|v| v.as_str() == s) {
            return Ok(known.clone());
        }
        if s.starts_with(Self::CUSTOM_PREFIX) {
            return Ok(RelType::Custom(s.to_string()));
        }
        Err(format!("unknown rel type: {s}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Actor {
    User,
    Assistant,
    External,
}

impl Actor {
    pub const ALL: [Actor; 3] = [Actor::User, Actor::Assistant, Actor::External];

    pub fn as_str(self) -> &'static str {
        match self {
            Actor::User => "user",
            Actor::Assistant => "assistant",
            Actor::External => "external",
        }
    }
}

impl FromStr for Actor {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown actor: {s}"))
    }
}

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
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rel: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Произвольные x-поля, round-trip без потерь.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_yml::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: NoteId,
    pub path: String,
    pub title: String,
    pub r#type: NoteType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    pub tags: Vec<String>,
    pub updated: String,
    pub rev: Rev,
    pub children_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub note_id: NoteId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    pub heading_path: Vec<String>,
    pub text: String,
    pub pos: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub note_id: NoteId,
    pub anchor: Anchor,
    pub text: String,
    pub done: bool,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<String>,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEdge {
    pub src_id: NoteId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dst_id: Option<NoteId>,
    pub dst_raw: String,
    pub rel_type: RelType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<Anchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub plus: u32,
    pub minus: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOp {
    pub op_id: String,
    pub ts: String,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub summary: String,
    pub files: Vec<FileChange>,
    pub undone: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub r#ref: NoteRef,
    pub title: String,
    pub score: f32,
    pub snippets: Vec<String>,
    pub updated: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub r#ref: NoteRef,
    pub path: String,
    pub title: String,
    pub r#type: NoteType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    pub children_count: u32,
    pub updated: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageProgress {
    pub title: String,
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub r#ref: NoteRef,
    pub title: String,
    pub percent: f32,
    pub done: u32,
    pub total: u32,
    pub by_stage: Vec<StageProgress>,
    pub overdue: Vec<TaskItem>,
    pub stalled: Vec<TaskItem>,
    pub next_tasks: Vec<TaskItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfoResponse {
    pub schema_version: String,
    pub vault_format: String,
    pub root: String,
    pub counts: VaultCounts,
    pub capabilities: Vec<String>,
    pub limits: VaultLimits,
    pub conventions_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCounts {
    pub notes: u32,
    pub plans: u32,
    pub tasks_open: u32,
    pub inbox: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLimits {
    pub max_response_bytes: u32,
    pub tree_limit_max: u32,
    pub search_limit_max: u32,
    pub mutations_rps: u32,
}

impl VaultLimits {
    /// Канонические лимиты CONTRACT §1.5.
    pub const CANON: VaultLimits = VaultLimits {
        max_response_bytes: limits::MAX_RESPONSE_BYTES,
        tree_limit_max: limits::TREE_LIMIT_MAX,
        search_limit_max: limits::SEARCH_LIMIT_MAX,
        mutations_rps: limits::MUTATIONS_RPS,
    };
}

/// Канон лимитов и дефолтов CONTRACT §1.5.
pub mod limits {
    pub const MAX_RESPONSE_BYTES: u32 = 51200;
    pub const TREE_LIMIT_MAX: u32 = 500;
    pub const TREE_LIMIT_DEFAULT: u32 = 200;
    pub const SEARCH_LIMIT_MAX: u32 = 50;
    pub const SEARCH_LIMIT_DEFAULT: u32 = 20;
    pub const TASKS_LIMIT_DEFAULT: u32 = 50;
    pub const ACTIVITY_LIMIT_DEFAULT: u32 = 100;
    pub const MUTATIONS_RPS: u32 = 5;
    pub const NOTE_READ_MAX_CHARS_DEFAULT: u32 = 20000;
    pub const DISTILL_BUDGET_CHARS_DEFAULT: u32 = 30000;
    pub const TREE_DEPTH_DEFAULT: u32 = 2;
    pub const STALLED_DAYS_DEFAULT: u32 = 7;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTreeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<NoteType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTreeResponse {
    pub nodes: Vec<TreeNode>,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteReadInclude {
    Links,
    Backlinks,
    Children,
    Tasks,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReadParams {
    pub r#ref: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<NoteReadInclude>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReadResponse {
    pub frontmatter: Frontmatter,
    pub content: String,
    pub rev: Rev,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<LinkEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backlinks: Option<Vec<LinkEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<TaskItem>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Keyword,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<NoteType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_before: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<SearchMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<SearchFilters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkDirection {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksGetParams {
    pub r#ref: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<LinkDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<RelType>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOut {
    pub to: NoteRef,
    pub r#type: RelType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkIn {
    pub from: NoteRef,
    pub r#type: RelType,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksGetResponse {
    pub out: Vec<LinkOut>,
    pub r#in: Vec<LinkIn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorFilter {
    User,
    Assistant,
    External,
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGetParams {
    pub since: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub ts: String,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub summary: String,
    pub refs: Vec<NoteRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGetResponse {
    pub events: Vec<ActivityEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextStep {
    pub plan: NoteRef,
    pub task: TaskItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalledNote {
    pub r#ref: NoteRef,
    pub days: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBriefingResponse {
    pub inbox_count: u32,
    pub next_steps: Vec<NextStep>,
    pub stalled: Vec<StalledNote>,
    pub overdue: Vec<TaskItem>,
    pub recent: Vec<NoteMeta>,
    pub suggest_distill: Vec<NoteRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<NoteRef>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<NoteType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateResponse {
    pub r#ref: NoteRef,
    pub path: String,
    pub rev: Rev,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum NoteEditOp {
    /// `old_string` обязан встречаться в заметке ровно один раз.
    Replace {
        old_string: String,
        new_string: String,
    },
    AppendSection {
        heading: String,
        content: String,
    },
    /// Исчезнувший заголовок → `NOT_FOUND` + hint.
    ReplaceSection {
        heading: String,
        content: String,
    },
    Prepend {
        content: String,
    },
    SetFrontmatter {
        key: String,
        value: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEditParams {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub ops: Vec<NoteEditOp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEditResponse {
    pub rev_new: Rev,
    pub diff_stat: DiffStat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMoveParams {
    pub r#ref: NoteRef,
    pub new_parent: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMoveResponse {
    pub path_new: String,
    pub links_rewritten: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRenameParams {
    pub r#ref: NoteRef,
    pub new_title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRenameResponse {
    pub path_new: String,
    pub links_updated: u32,
    pub alias_added: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteParams {
    pub r#ref: NoteRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteResponse {
    pub restore_token: String,
    pub backlinks_broken: u32,
}

/// Ровно одно из двух полей, иначе `VALIDATION`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRestoreParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<NoteRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRestoreResponse {
    pub r#ref: NoteRef,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStatusParams {
    pub r#ref: NoteRef,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStatusResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<Status>,
    pub new: Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAddParams {
    pub from: NoteRef,
    pub to: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<RelType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// Дубль → `created: false` (set-семантика).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAddResponse {
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRemoveParams {
    pub from: NoteRef,
    pub to: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<RelType>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRemoveResponse {
    pub removed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusFilter {
    Open,
    Done,
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksQueryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatusFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overdue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSource {
    pub r#ref: NoteRef,
    pub anchor: Anchor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHit {
    pub id: String,
    pub text: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    pub source: TaskSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksQueryResponse {
    pub tasks: Vec<TaskHit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheckItem {
    pub id: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Set-семантика, не toggle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheckParams {
    pub tasks: Vec<TaskCheckItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgressBrief {
    pub r#ref: NoteRef,
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheckResponse {
    pub updated: u32,
    pub progress_by_plan: Vec<PlanProgressBrief>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTaskDraft {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStageDraft {
    pub title: String,
    pub tasks: Vec<PlanTaskDraft>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCreateParams {
    pub title: String,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<NoteRef>,
    pub stages: Vec<PlanStageDraft>,
    /// Линкуются `distilled_from`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<NoteRef>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCreateProgress {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCreateResponse {
    pub r#ref: NoteRef,
    pub task_ids: Vec<Vec<String>>,
    pub progress: PlanCreateProgress,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PlanUpdateOp {
    AddStage {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },
    AddTask {
        stage: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due: Option<String>,
    },
    EditTask {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due: Option<String>,
    },
    RemoveTask {
        task_id: String,
    },
    Reorder {
        order: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUpdateParams {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub ops: Vec<PlanUpdateOp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUpdateResponse {
    pub rev_new: Rev,
    pub progress: PlanCreateProgress,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgressParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<NoteRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stalled_days: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgressResponse {
    pub plans: Vec<PlanProgress>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillContextParams {
    pub r#ref: NoteRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_chars: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BundleRole {
    Source,
    Linked,
    Similar,
    Plan,
    Neighbor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleItem {
    pub r#ref: NoteRef,
    pub role: BundleRole,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillContextResponse {
    pub bundle: Vec<BundleItem>,
    pub gaps: Vec<String>,
    pub coverage: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillSections {
    #[serde(rename = "цель")]
    pub goal: String,
    #[serde(rename = "зачем")]
    pub why: String,
    #[serde(rename = "критерии_готовности")]
    pub done_criteria: String,
    #[serde(rename = "план", default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(rename = "риски", default, skip_serializing_if = "Option::is_none")]
    pub risks: Option<String>,
    #[serde(rename = "допущения", default, skip_serializing_if = "Option::is_none")]
    pub assumptions: Option<String>,
    #[serde(rename = "не_думал", default, skip_serializing_if = "Option::is_none")]
    pub blind_spots: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistillTargetStatus {
    Shaping,
    Planned,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillSaveParams {
    pub r#ref: NoteRef,
    pub rev: Rev,
    pub sections: DistillSections,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_status: Option<DistillTargetStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_plan: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillSaveResponse {
    pub rev_new: Rev,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_ref: Option<NoteRef>,
}

/// Общие параметры `ui_open_note` / `ui_flash_note`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiNoteParams {
    pub r#ref: NoteRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiNoteResponse {
    pub ok: bool,
}
