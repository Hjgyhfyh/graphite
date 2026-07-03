//! Конверт ответов и коды ошибок Graphite (CONTRACT §1.2).

use serde::{Deserialize, Serialize};

use crate::types::{NoteMeta, Rev};

/// Версия конверта `Envelope.v`.
pub const ENVELOPE_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GraphiteErrorCode {
    NotFound,
    Conflict,
    Validation,
    Ambiguous,
    Limit,
    Forbidden,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphiteError {
    pub code: GraphiteErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl GraphiteError {
    pub fn new(code: GraphiteErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
            data: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Конверт результата: `{v:"1.0", ok:true, data:{…}}` либо
/// `{v:"1.0", ok:false, error:{code,message,hint}}`.
/// Инвариант: `ok == data.is_some()`, `!ok == error.is_some()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub v: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<GraphiteError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
}

impl<T> Envelope<T> {
    pub fn ok(data: T) -> Self {
        Self {
            v: ENVELOPE_VERSION.to_string(),
            ok: true,
            data: Some(data),
            error: None,
            schema_version: None,
        }
    }

    pub fn err(error: GraphiteError) -> Self {
        Self {
            v: ENVELOPE_VERSION.to_string(),
            ok: false,
            data: None,
            error: Some(error),
            schema_version: None,
        }
    }

    pub fn with_schema_version(mut self, schema_version: impl Into<String>) -> Self {
        self.schema_version = Some(schema_version.into());
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("rev conflict on {path}")]
    Conflict {
        path: String,
        current_rev: Rev,
        diff: Option<String>,
    },
    #[error("validation: {0}")]
    Validation(String),
    #[error("ambiguous ref {ref_}")]
    Ambiguous {
        ref_: String,
        candidates: Vec<NoteMeta>,
    },
    #[error("limit: {0}")]
    Limit(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("index: {0}")]
    Index(String),
}

impl VaultError {
    /// Маппинг в код конверта: 1:1 по первым семи вариантам, `Io`/`Index` → `Unavailable`.
    pub fn code(&self) -> GraphiteErrorCode {
        match self {
            VaultError::NotFound(_) => GraphiteErrorCode::NotFound,
            VaultError::Conflict { .. } => GraphiteErrorCode::Conflict,
            VaultError::Validation(_) => GraphiteErrorCode::Validation,
            VaultError::Ambiguous { .. } => GraphiteErrorCode::Ambiguous,
            VaultError::Limit(_) => GraphiteErrorCode::Limit,
            VaultError::Forbidden(_) => GraphiteErrorCode::Forbidden,
            VaultError::Unavailable(_) => GraphiteErrorCode::Unavailable,
            VaultError::Io(_) | VaultError::Index(_) => GraphiteErrorCode::Unavailable,
        }
    }
}

impl From<VaultError> for GraphiteError {
    fn from(err: VaultError) -> Self {
        let code = err.code();
        match err {
            VaultError::Conflict {
                path,
                current_rev,
                diff,
            } => GraphiteError::new(code, format!("rev conflict on {path}"))
                .with_hint("перечитай note_read и повтори с новым rev")
                .with_data(serde_json::json!({ "currentRev": current_rev, "diff": diff })),
            VaultError::Ambiguous { ref_, candidates } => {
                GraphiteError::new(code, format!("ambiguous ref {ref_}"))
                    .with_data(serde_json::json!({ "candidates": candidates }))
            }
            VaultError::Io(_) => GraphiteError::new(code, "ошибка ввода-вывода"),
            VaultError::Index(_) => GraphiteError::new(code, "ошибка индекса"),
            other => GraphiteError::new(code, other.to_string()),
        }
    }
}
