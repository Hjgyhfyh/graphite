//! IPC-протокол между процессами (CONTRACT §4): JSON-RPC 2.0 поверх named pipe,
//! кадр = ровно одна строка JSON с терминатором `\n` (NDJSON), максимум 1 МиБ.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const JSONRPC_VERSION: &str = "2.0";
/// Версия схемы протокола (`schemaVersion` в `hello`).
pub const SCHEMA_VERSION: &str = "1.0";
/// Версия формата vault (`vaultFormat` в `hello` и `vault_info`).
pub const VAULT_FORMAT: &str = "1";
/// Имя канала в пространстве имён ОС; на Windows разворачивается в `\\.\pipe\graphite-core`.
pub const PIPE_NAME: &str = "graphite-core";
/// Полный путь канала на Windows — для сообщений об ошибках.
pub const PIPE_PATH: &str = r"\\.\pipe\graphite-core";
/// Максимальный размер кадра; больше — соединение закрывается с ошибкой.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Транспортные коды JSON-RPC; доменные ошибки идут конвертом внутри `result`.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl RpcRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id: Some(Value::from(id)),
            method: method.into(),
            params: Some(params),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn result(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// Параметры рукопожатия `hello` (CONTRACT §4.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub token: String,
    pub client: String,
    pub schema_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloData {
    pub schema_version: String,
    pub vault_format: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    Idle,
    Scanning,
    Indexing,
}

/// `result.data` метода `index_status` (CONTRACT §4.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexData {
    pub started: bool,
}

/// Читает один NDJSON-кадр. `Ok(None)` — соединение закрыто между кадрами;
/// `InvalidData` — кадр больше лимита; `UnexpectedEof` — обрыв посреди кадра.
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut buf = Vec::new();
    let limit = (MAX_FRAME_BYTES + 2) as u64;
    let mut limited = reader.take(limit);
    let read = limited.read_until(b'\n', &mut buf).await?;
    if read == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') {
        if buf.len() as u64 >= limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("кадр превышает {MAX_FRAME_BYTES} байт"),
            ));
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "соединение оборвано посреди кадра",
        ));
    }
    buf.pop();
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    if buf.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("кадр превышает {MAX_FRAME_BYTES} байт"),
        ));
    }
    Ok(Some(buf))
}

/// Пишет значение одним NDJSON-кадром и сбрасывает буфер.
pub async fn write_frame<W, T>(writer: &mut W, frame: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize + ?Sized,
{
    let mut bytes = serde_json::to_vec(frame)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("кадр превышает {MAX_FRAME_BYTES} байт"),
        ));
    }
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}
