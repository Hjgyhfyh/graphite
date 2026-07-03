//! MCP-сервис Graphite: 25 инструментов реестра CONTRACT §3, каждый — тонкий
//! прокси в ядро через `rpc::RpcClient` (named pipe). Ответ инструмента —
//! конверт `{v, ok, data|error}` в JSON-тексте.

use std::path::PathBuf;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
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
             через note_read и повтори мутацию с новым rev. Начинай сессию с vault_info.",
            self.vault.display()
        );
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(instructions)
            .with_server_info(Implementation::new("graphite-mcp", env!("CARGO_PKG_VERSION")))
    }
}
