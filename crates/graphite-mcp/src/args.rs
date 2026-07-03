//! Входные структуры инструментов MCP (реестр CONTRACT §3, поверхность §7.3).
//! Схемы для ассистента; на IPC уходят сериализованными в JSON (camelCase).
//! Канонические типы ядра живут в крейте `rpc` и JsonSchema не требуют.

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum NoteTypeArg {
    Note,
    Plan,
    Project,
    Task,
    Journal,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum StatusArg {
    Inbox,
    Shaping,
    Planned,
    Active,
    Done,
    Iced,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum NoteReadIncludeArg {
    Links,
    Backlinks,
    Children,
    Tasks,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum SearchModeArg {
    Keyword,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum LinkDirectionArg {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum ActorFilterArg {
    User,
    Assistant,
    External,
    All,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum TaskStatusFilterArg {
    Open,
    Done,
    All,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum DistillTargetStatusArg {
    Shaping,
    Planned,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct VaultTreeArgs {
    /// Корень поддерева: "id:…" или "path:…"; по умолчанию — корень vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Глубина обхода, по умолчанию 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    /// Фильтр по типам заметок.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<NoteTypeArg>>,
    /// По умолчанию 200, максимум 500.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteReadArgs {
    /// Адрес заметки: "id:01J8…" (рекомендован) или "path:Проекты/Блог.md".
    pub r#ref: String,
    /// Что добавить к ответу: links, backlinks, children, tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<NoteReadIncludeArg>>,
    /// Читать только секцию с этим заголовком.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Символьное смещение в content, по умолчанию 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// По умолчанию 20000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct SearchFiltersArg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<NoteTypeArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Префикс пути от корня vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// ISO 8601.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_after: Option<String>,
    /// ISO 8601.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_before: Option<String>,
    /// YYYY-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_before: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct SearchArgs {
    /// Запрос; операторы: "фраза", -минус, tag:, type:, status:.
    pub query: String,
    /// По умолчанию keyword; semantic|hybrid требуют capability semantic_search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<SearchModeArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<SearchFiltersArg>,
    /// По умолчанию 20, максимум 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct LinksGetArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// По умолчанию both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<LinkDirectionArg>,
    /// Типы связей: related, part_of, depends_on, blocks, contradicts,
    /// distilled_from, collected_in или кастомные "x-…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct ActivityGetArgs {
    /// Относительный период "-7d" или ISO 8601.
    pub since: String,
    /// Ограничить поддеревом: "id:…" или "path:…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// По умолчанию all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorFilterArg>,
    /// По умолчанию 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteCreateArgs {
    /// Родитель: "id:…" или "path:…"; по умолчанию — корень.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub title: String,
    /// По умолчанию note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<NoteTypeArg>,
    /// По умолчанию inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Markdown-тело заметки.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub enum NoteEditOpArg {
    /// oldString обязан встречаться в заметке ровно один раз.
    Replace {
        old_string: String,
        new_string: String,
    },
    AppendSection {
        heading: String,
        content: String,
    },
    /// Исчезнувший заголовок → NOT_FOUND с подсказкой.
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteEditArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// rev из последнего чтения; при расхождении вернётся CONFLICT.
    pub rev: String,
    pub ops: Vec<NoteEditOpArg>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteMoveArgs {
    pub r#ref: String,
    /// Новый родитель: "id:…" или "path:…".
    pub new_parent: String,
    /// Позиция сортировки среди детей.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteRenameArgs {
    pub r#ref: String,
    pub new_title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteDeleteArgs {
    pub r#ref: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NoteRestoreArgs {
    /// Токен из ответа note_delete. Ровно одно из двух полей.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_token: Option<String>,
    /// Адрес удалённой заметки. Ровно одно из двух полей.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct SetStatusArgs {
    pub r#ref: String,
    pub status: StatusArg,
    /// Причина перехода — попадёт в журнал.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct LinkAddArgs {
    /// Заметка-источник: "id:…" или "path:…".
    pub from: String,
    /// Заметка-цель: "id:…" или "path:…".
    pub to: String,
    /// related (по умолчанию), part_of, depends_on, blocks, contradicts,
    /// distilled_from, collected_in или кастомный "x-…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// Пояснение связи.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct LinkRemoveArgs {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct TasksQueryArgs {
    /// Ограничить поддеревом: "id:…" или "path:…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// По умолчанию open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatusFilterArg>,
    /// YYYY-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_before: Option<String>,
    /// Только просроченные.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overdue: Option<bool>,
    /// Только задачи этого плана: "id:…" или "path:…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// По умолчанию 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct TaskCheckItemArg {
    /// Якорь задачи, например "t-8f2k".
    pub id: String,
    /// Целевое состояние (set-семантика, не toggle).
    pub done: bool,
    /// Заметка о выполнении.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct TaskCheckArgs {
    pub tasks: Vec<TaskCheckItemArg>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct PlanTaskDraftArg {
    pub text: String,
    /// YYYY-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct PlanStageDraftArg {
    pub title: String,
    pub tasks: Vec<PlanTaskDraftArg>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct PlanCreateArgs {
    pub title: String,
    /// Цель плана.
    pub goal: String,
    /// YYYY-MM-DD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    /// Родитель: "id:…" или "path:…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub stages: Vec<PlanStageDraftArg>,
    /// Заметки-источники — линкуются distilled_from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub enum PlanUpdateOpArg {
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct PlanUpdateArgs {
    /// Адрес плана: "id:…" или "path:…".
    pub r#ref: String,
    /// rev из последнего чтения плана.
    pub rev: String,
    pub ops: Vec<PlanUpdateOpArg>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct PlanProgressArgs {
    /// Конкретный план: "id:…" или "path:…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    /// Все активные планы, по умолчанию true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_active: Option<bool>,
    /// Порог «застоя» в днях, по умолчанию 7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stalled_days: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct DistillContextArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// Бюджет символов, по умолчанию 30000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_chars: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct DistillSectionsArg {
    /// Обязательная секция.
    #[serde(rename = "цель")]
    pub goal: String,
    /// Обязательная секция.
    #[serde(rename = "зачем")]
    pub why: String,
    /// Обязательная секция.
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct DistillSaveArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// rev из последнего чтения.
    pub rev: String,
    pub sections: DistillSectionsArg,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_status: Option<DistillTargetStatusArg>,
    /// Развернуть план со связью distilled_from, по умолчанию false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_plan: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct UiNoteArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct SetIconArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// Имя иконки lucide (например "rocket"); пропуск — снять иконку.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Цвет иконки — токен палитры или hex; пропуск — снять цвет.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct NotePinArgs {
    /// Адрес заметки: "id:…" или "path:…".
    pub r#ref: String,
    /// true — закрепить заметку в дереве/вкладках, false — открепить.
    pub pinned: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct BundleComposeArgs {
    /// Главный файл бандла: "id:…" или "path:…".
    pub r#ref: String,
    /// Подтянуть связанные (part_of/collected_in) как второстепенные; по умолчанию true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_linked: Option<bool>,
    /// Бюджет символов итогового текста; по умолчанию — лимит ответа.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct BundleCreateArgs {
    /// Заголовок нового главного файла-инструкции бандла.
    pub title: String,
    /// Родитель: "id:…" или "path:…"; по умолчанию — корень.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Второстепенные заметки — прикрепятся связью collected_in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<String>>,
    /// Текст-инструкция главного файла: как трактовать второстепенные.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(crate = "rmcp::schemars")]
pub struct IdeaToTasksArgs {
    /// Заметка-источник: "id:…" или "path:…". Нужно одно из ref/text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    /// Сырой текст идеи (строки "1 - …", "- …", "* …", "1. …"). Нужно одно из ref/text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Развернуть черновики в план со связью distilled_from; по умолчанию false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_plan: Option<bool>,
}
