//! Реестр методов IPC (CONTRACT §3 + §4.3): 30 инструментов и служебные методы.
//! Флаги RO/D/I — из таблицы §3; таймауты клиента — из §4.4.

use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodSpec {
    pub name: &'static str,
    /// Служебный метод протокола (`hello`, `index_status`, `reindex`), не инструмент.
    pub service: bool,
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

const fn tool(name: &'static str, read_only: bool, destructive: bool, idempotent: bool) -> MethodSpec {
    MethodSpec {
        name,
        service: false,
        read_only,
        destructive,
        idempotent,
    }
}

const fn service(name: &'static str, read_only: bool, idempotent: bool) -> MethodSpec {
    MethodSpec {
        name,
        service: true,
        read_only,
        destructive: false,
        idempotent,
    }
}

pub const METHODS: [MethodSpec; 36] = [
    service("hello", false, true),
    service("index_status", true, true),
    service("reindex", false, false),
    tool("vault_info", true, false, true),
    tool("vault_tree", true, false, true),
    tool("note_read", true, false, true),
    tool("search", true, false, true),
    tool("links_get", true, false, true),
    tool("activity_get", true, false, true),
    tool("context_briefing", true, false, true),
    tool("note_create", false, false, false),
    tool("note_edit", false, false, false),
    tool("note_move", false, false, true),
    tool("note_rename", false, false, true),
    tool("note_delete", false, true, true),
    tool("note_restore", false, false, true),
    tool("set_status", false, false, true),
    tool("link_add", false, false, true),
    tool("link_remove", false, false, true),
    tool("tasks_query", true, false, true),
    tool("task_check", false, false, true),
    tool("plan_create", false, false, false),
    tool("plan_update", false, false, false),
    tool("plan_progress", true, false, true),
    tool("distill_context", true, false, true),
    tool("distill_save", false, false, false),
    tool("set_icon", false, false, true),
    tool("note_pin", false, false, true),
    tool("bundle_compose", true, false, true),
    tool("bundle_create", false, false, false),
    tool("idea_to_tasks", false, false, false),
    tool("journal_list", true, false, true),
    tool("undo_op", false, true, true),
    tool("undo_session", false, true, true),
    tool("ui_open_note", false, false, true),
    tool("ui_flash_note", false, false, true),
];

pub fn find(method: &str) -> Option<&'static MethodSpec> {
    METHODS.iter().find(|spec| spec.name == method)
}

pub fn is_known(method: &str) -> bool {
    find(method).is_some()
}

/// Только 30 инструментов реестра, без служебных методов.
pub fn tool_methods() -> impl Iterator<Item = &'static MethodSpec> {
    METHODS.iter().filter(|spec| !spec.service)
}

pub const HELLO_TIMEOUT: Duration = Duration::from_secs(2);
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const MUTATION_TIMEOUT: Duration = Duration::from_secs(30);

/// Клиентский таймаут по классу метода: `hello` — 2 с, чтение — 10 с,
/// мутации и `reindex` — 30 с.
pub fn default_timeout(method: &str) -> Duration {
    if method == "hello" {
        return HELLO_TIMEOUT;
    }
    match find(method) {
        Some(spec) if spec.read_only => READ_TIMEOUT,
        _ => MUTATION_TIMEOUT,
    }
}
