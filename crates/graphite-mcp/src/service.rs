//! MCP-сервис Graphite: 30 инструментов реестра CONTRACT §3, каждый — тонкий
//! прокси в ядро через `rpc::RpcClient` (named pipe). Ответ инструмента —
//! конверт `{v, ok, data|error}` в JSON-тексте. Плюс ресурсы
//! (`vault://conventions|inbox|recent`) и промпт `distill` (SPEC §7.4/§7.5).

use std::path::PathBuf;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    GetPromptRequestParams, GetPromptResult, Implementation, ListPromptsResult,
    ListResourcesResult, PaginatedRequestParams, Prompt, PromptArgument, PromptMessage,
    ReadResourceRequestParams, ReadResourceResult, Resource, ResourceContents, Role,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use rpc::{ClientError, RpcClient};
use serde_json::Value;

use crate::args::*;

#[derive(Clone)]
pub struct GraphiteService {
    vault: PathBuf,
}

impl GraphiteService {
    pub fn new(vault: PathBuf) -> Self {
        Self { vault }
    }

    fn to_params<T: serde::Serialize>(args: &T) -> Result<Value, ErrorData> {
        serde_json::to_value(args)
            .map_err(|err| ErrorData::invalid_params(format!("некорректные аргументы: {err}"), None))
    }

    fn empty_params() -> Value {
        Value::Object(serde_json::Map::new())
    }

    async fn proxy(&self, method: &str, params: Value) -> Result<String, ErrorData> {
        let mut client = match RpcClient::connect().await {
            Ok(client) => client,
            Err(ClientError::Connect { .. }) => {
                return Err(ErrorData::internal_error(
                    format!(
                        "Graphite не запущен: канал {} недоступен — запустите Graphite и повторите вызов",
                        rpc::protocol::PIPE_PATH
                    ),
                    None,
                ));
            }
            Err(err) => {
                return Err(ErrorData::internal_error(
                    format!("не удалось подключиться к ядру Graphite: {err}"),
                    None,
                ));
            }
        };
        let envelope = client.call(method, params).await.map_err(|err| {
            ErrorData::internal_error(format!("сбой вызова «{method}» в ядре Graphite: {err}"), None)
        })?;
        serde_json::to_string_pretty(&envelope)
            .map_err(|err| ErrorData::internal_error(format!("сериализация ответа: {err}"), None))
    }
}

#[tool_router]
impl GraphiteService {
    #[tool(
        name = "vault_info",
        description = "Сводка хранилища: версия схемы, корень, счётчики заметок/планов/задач, лимиты, capabilities. Рекомендуемый первый вызов сессии.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn vault_info(&self) -> Result<String, ErrorData> {
        self.proxy("vault_info", Self::empty_params()).await
    }

    #[tool(
        name = "vault_tree",
        description = "Дерево заметок от корня или указанного узла: ref, path, title, type, status, счётчик детей.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn vault_tree(
        &self,
        Parameters(args): Parameters<VaultTreeArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("vault_tree", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_read",
        description = "Читает заметку: frontmatter, content, rev; опционально links/backlinks/children/tasks, секция или срез по offset/maxChars.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_read(
        &self,
        Parameters(args): Parameters<NoteReadArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_read", Self::to_params(&args)?).await
    }

    #[tool(
        name = "search",
        description = "Поиск по vault: операторы \"фраза\", -минус, tag:, type:, status:; фильтры и пагинация. Возвращает hits со сниппетами.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn search(&self, Parameters(args): Parameters<SearchArgs>) -> Result<String, ErrorData> {
        self.proxy("search", Self::to_params(&args)?).await
    }

    #[tool(
        name = "links_get",
        description = "Связи заметки: исходящие (to, type, context) и входящие (from, type).",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn links_get(
        &self,
        Parameters(args): Parameters<LinksGetArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("links_get", Self::to_params(&args)?).await
    }

    #[tool(
        name = "activity_get",
        description = "События журнала за период: кто (user/assistant/external), чем, что менял.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn activity_get(
        &self,
        Parameters(args): Parameters<ActivityGetArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("activity_get", Self::to_params(&args)?).await
    }

    #[tool(
        name = "context_briefing",
        description = "Heads-Up одной командой: размер инбокса, следующие шаги по планам, застой, просрочка, свежие заметки, кандидаты на выжимку.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn context_briefing(&self) -> Result<String, ErrorData> {
        self.proxy("context_briefing", Self::empty_params()).await
    }

    #[tool(
        name = "note_create",
        description = "Создаёт заметку (уважает folder-note и шаблон типа). Возвращает ref, path, rev.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn note_create(
        &self,
        Parameters(args): Parameters<NoteCreateArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_create", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_edit",
        description = "Правит заметку операциями replace/append_section/replace_section/prepend/set_frontmatter под защитой rev; при расхождении вернёт CONFLICT с актуальным rev.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn note_edit(
        &self,
        Parameters(args): Parameters<NoteEditArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_edit", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_move",
        description = "Переносит заметку под нового родителя линк-безопасной транзакцией; дети — каскадом, id неизменны.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_move(
        &self,
        Parameters(args): Parameters<NoteMoveArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_move", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_rename",
        description = "Переименовывает заметку: обновляет ссылки, добавляет алиас со старым именем.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_rename(
        &self,
        Parameters(args): Parameters<NoteRenameArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_rename", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_delete",
        description = "Мягкое удаление в .trash/ на 30 дней. Возвращает restoreToken и число сломанных обратных ссылок.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_delete(
        &self,
        Parameters(args): Parameters<NoteDeleteArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_delete", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_restore",
        description = "Восстанавливает заметку из .trash/ по restoreToken или ref (ровно одно из двух).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_restore(
        &self,
        Parameters(args): Parameters<NoteRestoreArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_restore", Self::to_params(&args)?).await
    }

    #[tool(
        name = "set_status",
        description = "Меняет статус заметки (inbox/shaping/planned/active/done/iced) с валидацией перехода.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_status(
        &self,
        Parameters(args): Parameters<SetStatusArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("set_status", Self::to_params(&args)?).await
    }

    #[tool(
        name = "link_add",
        description = "Добавляет типизированную связь между заметками; дубль → created:false (set-семантика).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn link_add(
        &self,
        Parameters(args): Parameters<LinkAddArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("link_add", Self::to_params(&args)?).await
    }

    #[tool(
        name = "link_remove",
        description = "Убирает связь между заметками.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn link_remove(
        &self,
        Parameters(args): Parameters<LinkRemoveArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("link_remove", Self::to_params(&args)?).await
    }

    #[tool(
        name = "tasks_query",
        description = "Задачи по всему vault, включая инлайновые: фильтры по scope, статусу, сроку, просрочке, плану.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn tasks_query(
        &self,
        Parameters(args): Parameters<TasksQueryArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("tasks_query", Self::to_params(&args)?).await
    }

    #[tool(
        name = "task_check",
        description = "Отмечает задачи выполненными/невыполненными (set-семантика — безопасный ретрай). Возвращает прогресс затронутых планов.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn task_check(
        &self,
        Parameters(args): Parameters<TaskCheckArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("task_check", Self::to_params(&args)?).await
    }

    #[tool(
        name = "plan_create",
        description = "Создаёт план со стадиями и задачами; sources линкуются distilled_from — план помнит, из чего вырос.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn plan_create(
        &self,
        Parameters(args): Parameters<PlanCreateArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("plan_create", Self::to_params(&args)?).await
    }

    #[tool(
        name = "plan_update",
        description = "Правит план операциями add_stage/add_task/edit_task/remove_task/reorder под защитой rev.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn plan_update(
        &self,
        Parameters(args): Parameters<PlanUpdateArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("plan_update", Self::to_params(&args)?).await
    }

    #[tool(
        name = "plan_progress",
        description = "Прогресс планов: проценты, по стадиям, просроченные и застоявшиеся задачи, следующие шаги.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn plan_progress(
        &self,
        Parameters(args): Parameters<PlanProgressArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("plan_progress", Self::to_params(&args)?).await
    }

    #[tool(
        name = "distill_context",
        description = "Собирает контекст для выжимки заметки: bundle из источника и связей под бюджет символов, карта пробелов (gaps), coverage.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn distill_context(
        &self,
        Parameters(args): Parameters<DistillContextArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("distill_context", Self::to_params(&args)?).await
    }

    #[tool(
        name = "distill_save",
        description = "Сохраняет секции выжимки (цель, зачем, критерии_готовности — обязательные) в заметку под защитой rev; опционально ставит статус и разворачивает план.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn distill_save(
        &self,
        Parameters(args): Parameters<DistillSaveArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("distill_save", Self::to_params(&args)?).await
    }

    #[tool(
        name = "set_icon",
        description = "Ставит заметке иконку lucide и/или цвет во frontmatter (icon/iconColor) — для дерева, вкладок и свитчера. Пустое поле снимает значение.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_icon(
        &self,
        Parameters(args): Parameters<SetIconArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("set_icon", Self::to_params(&args)?).await
    }

    #[tool(
        name = "note_pin",
        description = "Закрепляет или открепляет заметку (frontmatter pinned) — закреплённые всплывают в дереве и вкладках. Set-семантика.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_pin(
        &self,
        Parameters(args): Parameters<NotePinArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("note_pin", Self::to_params(&args)?).await
    }

    #[tool(
        name = "bundle_compose",
        description = "Собирает основной файл и второстепенные (по связям part_of/collected_in) в один markdown для ИИ — движок кнопки «Copy Page»: секции с путём и заголовком каждого файла.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn bundle_compose(
        &self,
        Parameters(args): Parameters<BundleComposeArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("bundle_compose", Self::to_params(&args)?).await
    }

    #[tool(
        name = "bundle_create",
        description = "Создаёт бандл: новый главный файл-инструкцию и прикрепляет второстепенные заметки связью collected_in. Возвращает ref, path, rev.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn bundle_create(
        &self,
        Parameters(args): Parameters<BundleCreateArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("bundle_create", Self::to_params(&args)?).await
    }

    #[tool(
        name = "idea_to_tasks",
        description = "Разбирает сырую идею (ref или text) в черновики задач: строки «1 - …», «- …», «* …», «1. …» → {text, due?, priority?}. С createPlan=true разворачивает план. Эвристика без ИИ — формулировки улучшай сам.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn idea_to_tasks(
        &self,
        Parameters(args): Parameters<IdeaToTasksArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("idea_to_tasks", Self::to_params(&args)?).await
    }

    #[tool(
        name = "journal_list",
        description = "Подробный журнал операций за период (before/after blake3 каждого файла) — детальнее activity_get. Даёт opId и session для undo.",
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn journal_list(
        &self,
        Parameters(args): Parameters<ActivityGetArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("journal_list", Self::to_params(&args)?).await
    }

    #[tool(
        name = "undo_op",
        description = "Откатывает одну операцию по opId (восстанавливает before-снапшоты её файлов). opId — из journal_list.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn undo_op(&self, Parameters(args): Parameters<UndoOpArgs>) -> Result<String, ErrorData> {
        self.proxy("undo_op", Self::to_params(&args)?).await
    }

    #[tool(
        name = "undo_session",
        description = "Откатывает все операции сессии в обратном порядке одним действием. session — из journal_list.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn undo_session(
        &self,
        Parameters(args): Parameters<UndoSessionArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("undo_session", Self::to_params(&args)?).await
    }

    #[tool(
        name = "ui_open_note",
        description = "Открывает заметку в окне Graphite. GUI скрыт/закрыт → UNAVAILABLE (не ошибка сценария).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn ui_open_note(
        &self,
        Parameters(args): Parameters<UiNoteArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("ui_open_note", Self::to_params(&args)?).await
    }

    #[tool(
        name = "ui_flash_note",
        description = "Подсвечивает заметку в дереве Graphite. GUI скрыт/закрыт → UNAVAILABLE (не ошибка сценария).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn ui_flash_note(
        &self,
        Parameters(args): Parameters<UiNoteArgs>,
    ) -> Result<String, ErrorData> {
        self.proxy("ui_flash_note", Self::to_params(&args)?).await
    }
}

#[tool_handler]
impl ServerHandler for GraphiteService {
    fn get_info(&self) -> ServerInfo {
        let instructions = format!(
            "Graphite — локальное хранилище заметок и планов (vault: {}). \
             Мутации выполняй только через инструменты — они дают поиск по индексу, \
             ссылочную целостность, валидацию и журнал. Адресация — ref: \"id:01J8…\" \
             (рекомендовано) или \"path:Проекты/Блог.md\". Ответ каждого инструмента — \
             конверт {{v, ok, data|error}}; при error.code=CONFLICT перечитай заметку \
             через note_read и повтори мутацию с новым rev. Начинай сессию с vault_info. \
             Кроме базовых: иконки и цвет заметок (set_icon), закрепление (note_pin), \
             бандлы по смыслу (bundle_create) и их сборка в один текст для ИИ — «Copy Page» \
             (bundle_compose), разбор сырой идеи в задачи (idea_to_tasks). \
             Ресурсы: vault://conventions (правила хранилища), vault://inbox, vault://recent. \
             Промпт: distill — флагманская «Выжимка» заметки.",
            self.vault.display()
        );
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_instructions(instructions)
        .with_server_info(Implementation::new("graphite-mcp", env!("CARGO_PKG_VERSION")))
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(resource_catalog()))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        let uri = request.uri;
        let markdown = match uri.as_str() {
            CONVENTIONS_URI => CONVENTIONS_MD.to_string(),
            INBOX_URI => {
                let params = serde_json::json!({
                    "query": "",
                    "filters": { "status": "inbox" },
                    "limit": 50,
                });
                let envelope = self.proxy("search", params).await?;
                render_envelope_resource(
                    "# Входящие",
                    "Необработанные записи `status: inbox` — вход ключевого сценария. Полная заметка — `note_read`.",
                    &envelope,
                )
            }
            RECENT_URI => {
                let params = serde_json::json!({ "since": "-30d", "limit": 30 });
                let envelope = self.proxy("activity_get", params).await?;
                render_envelope_resource(
                    "# Недавнее",
                    "Изменения хранилища за 30 дней из журнала. Полная заметка — `note_read`.",
                    &envelope,
                )
            }
            other => {
                return Err(ErrorData::invalid_params(
                    format!(
                        "неизвестный ресурс «{other}»: доступны {CONVENTIONS_URI}, {INBOX_URI}, {RECENT_URI}"
                    ),
                    None,
                ));
            }
        };
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(markdown, uri).with_mime_type("text/markdown"),
        ]))
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Ok(ListPromptsResult::with_all_items(prompt_catalog()))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResult, ErrorData> {
        match request.name.as_str() {
            DISTILL_PROMPT => {
                let note_ref = request
                    .arguments
                    .as_ref()
                    .and_then(|args| args.get("ref"))
                    .and_then(|value| value.as_str());
                Ok(distill_prompt(note_ref))
            }
            other => Err(ErrorData::invalid_params(
                format!("неизвестный промпт «{other}»: доступен {DISTILL_PROMPT}"),
                None,
            )),
        }
    }
}

const CONVENTIONS_URI: &str = "vault://conventions";
const INBOX_URI: &str = "vault://inbox";
const RECENT_URI: &str = "vault://recent";
const DISTILL_PROMPT: &str = "distill";

/// Правила хранилища для ассистента (SPEC §6, §7.4). Статичный текст —
/// не зависит от ядра, отдаётся даже без смонтированного vault.
const CONVENTIONS_MD: &str = r#"# Соглашения хранилища Graphite

Истина — markdown-файлы (CommonMark + GFM) с YAML-frontmatter, UTF-8/LF. Индекс всегда пересобирается из файлов.

## Мутации — только через инструменты
Правь заметки инструментами (`note_edit`, `note_create`, `set_status`, `link_add`, …), а не прямой записью в файл: так работают поиск по индексу, ссылочная целостность, валидация и журнал. Прямые правки файлов тоже допустимы, но журналируются как внешние.

## Адресация и конверт
- `ref`: `id:01J8…` (рекомендовано, стабильно) или `path:Проекты/Блог.md`.
- Ответ: `{v, ok, data}` или `{v, ok:false, error:{code, message, hint}}`. Коды: `NOT_FOUND | CONFLICT | VALIDATION | AMBIGUOUS | LIMIT | FORBIDDEN | UNAVAILABLE`.
- `rev` — снимок содержимого из последнего чтения; при `CONFLICT` перечитай `note_read` и повтори мутацию с новым `rev`.

## Frontmatter (зарезервированное ядро)
`id, type, title, aliases, tags, status, priority, due, scheduled, goal, target_date, rel, sort, created, updated`. Плюс презентация: `icon` (иконка lucide), `icon_color`, `pinned`. Произвольные поля — с префиксом `x-`.
- `type`: `note | plan | project | task | journal`.
- `priority`: `low | normal | high | urgent`.

## Статусы (единый словарь)
`inbox → shaping → planned → active → done`; `iced` — из любого, разморозка → `shaping`. Понижение статуса — только по явной команде человека; ассистент повышение предлагает, не навязывает.

## Задачи
Инлайн в любой заметке: `- [ ] Текст @due(2026-07-15) @p(high) ^t-8f2k`. Якорь `^t-<4–6 base32>` — стабильный ID. Меняй галочки через `task_check` (set-семантика, не toggle).

## Связи (`rel:` во frontmatter)
Реестр типов: `related` (дефолт), `part_of`, `depends_on`, `blocks`, `contradicts`, `distilled_from`, `collected_in`; кастомные — только `x-…`. Синтаксис ссылок: `[[Заголовок]]`, `[[Заголовок#Секция]]`, `[[id:01J…|текст]]`. Бэклинки не хранятся в файлах — их даёт индекс (`links_get`).

## Бандлы и «Copy Page»
Бандл — главный файл-инструкция плюс второстепенные, связанные `collected_in`/`part_of`. `bundle_compose` собирает их в один markdown для передачи ИИ (кнопка «Copy Page»).
"#;

/// Каталог ресурсов сервера (SPEC §7.4). URI фиксированы, содержимое
/// отдаёт `read_resource`.
fn resource_catalog() -> Vec<Resource> {
    vec![
        Resource::new(CONVENTIONS_URI, "conventions")
            .with_title("Соглашения хранилища")
            .with_description(
                "Поля frontmatter, словарь статусов, синтаксис задач и связей, правило «мутации — через инструменты».",
            )
            .with_mime_type("text/markdown"),
        Resource::new(INBOX_URI, "inbox")
            .with_title("Входящие")
            .with_description("Необработанные записи status: inbox — вход ключевого сценария.")
            .with_mime_type("text/markdown"),
        Resource::new(RECENT_URI, "recent")
            .with_title("Недавнее")
            .with_description("Свежие изменения хранилища из журнала за 30 дней.")
            .with_mime_type("text/markdown"),
    ]
}

/// Каталог промптов сервера (SPEC §7.5).
fn prompt_catalog() -> Vec<Prompt> {
    vec![
        Prompt::new(
            DISTILL_PROMPT,
            Some(
                "Выжимка заметки: интервью ≤7 вопросов по одному, затем сохранение секций цель/зачем/критерии и опциональный план.",
            ),
            Some(vec![
                PromptArgument::new("ref")
                    .with_title("Заметка")
                    .with_description(
                        "Адрес заметки для выжимки: \"id:…\" или \"path:…\". Без него ассистент берёт кандидата из инбокса.",
                    )
                    .with_required(false),
            ]),
        )
        .with_title("Выжимка"),
    ]
}

/// Сценарий флагманской «Выжимки» (SPEC §7.5): один пользовательский месседж
/// с протоколом; `ref` подставляется, если задан.
fn distill_prompt(note_ref: Option<&str>) -> GetPromptResult {
    let target = match note_ref {
        Some(r) => format!("Заметка для выжимки: {r}."),
        None => {
            "Заметка не задана — предложи кандидата из vault://inbox или спроси ref.".to_string()
        }
    };
    let body = format!(
        "Проведи «Выжимку» заметки в Graphite.\n\n\
         {target}\n\n\
         Протокол:\n\
         1. Вызови distill_context(ref) — получи бандл источника и связей плюс карту пробелов (gaps).\n\
         2. Интервью: не больше 7 вопросов, по одному за раз. Каждый — с твоей гипотезой и 2–3 вариантами; всегда оставляй ход «реши сам».\n\
         3. После каждого ответа фиксируй его note_edit(append_section) в исходную заметку — пользователь видит, как она дописывается.\n\
         4. Заверши distill_save: обязательные секции цель, зачем, критерии_готовности; опционально set_status и create_plan (план со связью distilled_from).\n\
         Пиши по-русски, кратко и по делу. Мутации — только через инструменты."
    );
    GetPromptResult::new(vec![PromptMessage::new_text(Role::User, body)]).with_description(
        "Флагманская механика «Выжимка» — довести сырую идею до цель/зачем/критерии и, по желанию, плана.",
    )
}

/// Оборачивает конверт ответа ядра в markdown-ресурс: заголовок, короткое
/// пояснение и сам конверт в JSON-блоке для машинного разбора ассистентом.
fn render_envelope_resource(heading: &str, intro: &str, envelope: &str) -> String {
    format!("{heading}\n\n{intro}\n\n```json\n{}\n```\n", envelope.trim())
}
