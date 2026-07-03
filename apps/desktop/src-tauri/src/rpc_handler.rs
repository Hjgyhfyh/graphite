//! Реализация `rpc::Handler` поверх приложения: каждый вызов по named pipe
//! проходит через `commands::dispatch` и заворачивается в конверт `Envelope`.
//! `hello` отдаёт рукопожатие (версии/корень/индекс), `ui_open_note`/
//! `ui_flash_note` транслируются в события окна.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use rpc::protocol;
use rpc::{Envelope, GraphiteError as RpcError, GraphiteErrorCode as RpcCode, Handler, MethodFuture};

use crate::commands;
use crate::dto::{GraphiteError, GraphiteErrorCode, NoteRef};
use crate::events::{UiFlashNoteEvent, UiOpenNoteEvent};
use crate::state::core_cell;

/// Исполнитель методов реестра на стороне приложения — единственный писатель
/// vault, общий для Tauri-команд и MCP-клиентов по pipe.
pub struct AppHandler {
    app: AppHandle,
}

impl AppHandler {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn handle(&self, method: &str, params: Value) -> Envelope<Value> {
        if method == "hello" {
            return ok_env(hello_data());
        }
        if let Some(env) = self.ui_bridge(method, &params) {
            return env;
        }
        match commands::dispatch(method, params) {
            Ok(value) => ok_env(value),
            Err(err) => err_env(err),
        }
    }

    /// `ui_open_note`/`ui_flash_note` требуют окна — их обслуживает приложение,
    /// а не ядро. Окно закрыто → `UNAVAILABLE` (штатный ответ, не сбой сценария).
    fn ui_bridge(&self, method: &str, params: &Value) -> Option<Envelope<Value>> {
        if method != "ui_open_note" && method != "ui_flash_note" {
            return None;
        }
        let Some(note_ref) = params.get("ref").and_then(|v| v.as_str()) else {
            return Some(err_env(dto_err(
                GraphiteErrorCode::Validation,
                "нужен ref заметки",
                Some("передай ref в форме path:… или id:…"),
            )));
        };
        if self.app.get_webview_window("main").is_none() {
            return Some(err_env(dto_err(
                GraphiteErrorCode::Unavailable,
                "окно Graphite закрыто",
                Some("открой приложение и повтори"),
            )));
        }
        let payload = NoteRef(note_ref.to_string());
        let _ = if method == "ui_open_note" {
            self.app.emit("ui_open_note", UiOpenNoteEvent { r#ref: payload })
        } else {
            self.app.emit("ui_flash_note", UiFlashNoteEvent { r#ref: payload })
        };
        Some(ok_env(serde_json::json!({ "ok": true })))
    }
}

impl Handler for AppHandler {
    fn call(&self, method: &str, params: Option<Value>) -> MethodFuture {
        let env = self.handle(method, params.unwrap_or(Value::Null));
        Box::pin(std::future::ready(env))
    }
}

fn ok_env(data: Value) -> Envelope<Value> {
    Envelope::ok(data).with_schema_version(protocol::SCHEMA_VERSION)
}

fn err_env(err: GraphiteError) -> Envelope<Value> {
    let mut rpc_err = RpcError::new(map_code(err.code), err.message);
    if let Some(hint) = err.hint {
        rpc_err = rpc_err.with_hint(hint);
    }
    if let Some(data) = err.data {
        rpc_err = rpc_err.with_data(data);
    }
    Envelope::err(rpc_err).with_schema_version(protocol::SCHEMA_VERSION)
}

fn dto_err(code: GraphiteErrorCode, message: impl Into<String>, hint: Option<&str>) -> GraphiteError {
    GraphiteError {
        code,
        message: message.into(),
        hint: hint.map(|s| s.to_string()),
        data: None,
    }
}

fn map_code(code: GraphiteErrorCode) -> RpcCode {
    match code {
        GraphiteErrorCode::NotFound => RpcCode::NotFound,
        GraphiteErrorCode::Conflict => RpcCode::Conflict,
        GraphiteErrorCode::Validation => RpcCode::Validation,
        GraphiteErrorCode::Ambiguous => RpcCode::Ambiguous,
        GraphiteErrorCode::Limit => RpcCode::Limit,
        GraphiteErrorCode::Forbidden => RpcCode::Forbidden,
        GraphiteErrorCode::Unavailable => RpcCode::Unavailable,
    }
}

/// Рукопожатие `hello`: версии схемы/формата, корень открытого vault (если есть)
/// и статус индекса. Работает и без смонтированного vault.
fn hello_data() -> Value {
    let guard = core_cell().lock().unwrap();
    let (root, index_status, mounted) = match guard.as_ref() {
        Some(state) => (
            Some(state.root.to_string_lossy().to_string()),
            state.index.status().ok().and_then(|s| serde_json::to_value(s).ok()),
            true,
        ),
        None => (None, None, false),
    };
    drop(guard);
    serde_json::json!({
        "schemaVersion": vault_core::SCHEMA_VERSION,
        "vaultFormat": vault_core::VAULT_FORMAT,
        "root": root,
        "mounted": mounted,
        "capabilities": Vec::<String>::new(),
        "indexStatus": index_status,
    })
}
