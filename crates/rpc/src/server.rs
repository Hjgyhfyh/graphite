//! Сервер named pipe `\\.\pipe\graphite-core`: приём соединений, NDJSON-кадры,
//! диспетчеризация по реестру методов, graceful shutdown.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use interprocess::local_socket::{
    GenericNamespaced, ListenerOptions, ToNsName,
    tokio::{Listener, Stream, prelude::*},
};
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use crate::error::{Envelope, GraphiteError, GraphiteErrorCode};
use crate::protocol::{self, RpcError, RpcRequest, RpcResponse};
use crate::registry;

pub type MethodFuture = Pin<Box<dyn Future<Output = Envelope<Value>> + Send>>;

/// Исполнитель методов реестра. Ядро подключается сюда своей реализацией;
/// диспетчер зовёт его только для известных методов (CONTRACT §4.3).
pub trait Handler: Send + Sync + 'static {
    fn call(&self, method: &str, params: Option<Value>) -> MethodFuture;
}

/// Заглушка ядра: каждый метод отвечает конвертом `UNAVAILABLE`.
pub struct StubHandler;

impl Handler for StubHandler {
    fn call(&self, method: &str, _params: Option<Value>) -> MethodFuture {
        let envelope = Envelope::err(
            GraphiteError::new(
                GraphiteErrorCode::Unavailable,
                format!("метод «{method}» ещё не реализован"),
            )
            .with_hint("ядро в разработке"),
        )
        .with_schema_version(protocol::SCHEMA_VERSION);
        Box::pin(std::future::ready(envelope))
    }
}

pub struct RpcServer {
    handler: Arc<dyn Handler>,
}

impl RpcServer {
    pub fn new(handler: Arc<dyn Handler>) -> Self {
        Self { handler }
    }

    /// Сервер с заглушкой вместо ядра.
    pub fn stub() -> Self {
        Self::new(Arc::new(StubHandler))
    }

    /// Запускает сервер на каноническом канале `\\.\pipe\graphite-core`.
    pub async fn start(self) -> anyhow::Result<ServerHandle> {
        self.start_on(protocol::PIPE_NAME).await
    }

    pub async fn start_on(self, pipe_name: &str) -> anyhow::Result<ServerHandle> {
        let name = pipe_name
            .to_ns_name::<GenericNamespaced>()
            .with_context(|| format!("некорректное имя канала «{pipe_name}»"))?;
        let listener = ListenerOptions::new()
            .name(name)
            .create_tokio()
            .with_context(|| format!("не удалось открыть канал «{pipe_name}»"))?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let join = tokio::spawn(accept_loop(listener, self.handler, shutdown_rx));
        Ok(ServerHandle { shutdown_tx, join })
    }
}

pub struct ServerHandle {
    shutdown_tx: watch::Sender<bool>,
    join: JoinHandle<()>,
}

impl ServerHandle {
    /// Graceful shutdown: перестать принимать соединения, дождаться активных.
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.join.await;
    }

    /// Ждать завершения сервера, не инициируя остановку.
    pub async fn wait(self) {
        let _ = self.join.await;
    }
}

/// Пауза перед повтором после ошибки `accept()`, чтобы устойчивый сбой
/// слушателя не превращался в busy-spin с полной загрузкой ядра.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

async fn accept_loop(
    listener: Listener,
    handler: Arc<dyn Handler>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok(stream) => {
                        connections.spawn(handle_connection(
                            stream,
                            handler.clone(),
                            shutdown.clone(),
                        ));
                    }
                    Err(_) => {
                        tokio::select! {
                            _ = shutdown.changed() => break,
                            _ = tokio::time::sleep(ACCEPT_ERROR_BACKOFF) => {}
                        }
                    }
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    while connections.join_next().await.is_some() {}
}

async fn handle_connection(
    stream: Stream,
    handler: Arc<dyn Handler>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut io = BufReader::new(stream);
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            frame = protocol::read_frame(&mut io) => {
                match frame {
                    Ok(Some(bytes)) => {
                        if handle_frame(&bytes, handler.as_ref(), &mut io).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        if err.kind() == std::io::ErrorKind::InvalidData {
                            let response = RpcResponse::error(
                                Value::Null,
                                RpcError::new(protocol::INVALID_REQUEST, err.to_string()),
                            );
                            let _ = protocol::write_frame(&mut io, &response).await;
                        }
                        break;
                    }
                }
            }
        }
    }
    let _ = io.shutdown().await;
}

async fn handle_frame<W>(bytes: &[u8], handler: &dyn Handler, io: &mut W) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let request: RpcRequest = match serde_json::from_slice(bytes) {
        Ok(request) => request,
        Err(err) => {
            let response = RpcResponse::error(
                Value::Null,
                RpcError::new(protocol::PARSE_ERROR, format!("некорректный JSON: {err}")),
            );
            return protocol::write_frame(io, &response).await;
        }
    };
    if request.jsonrpc != protocol::JSONRPC_VERSION {
        let response = RpcResponse::error(
            request.id.unwrap_or(Value::Null),
            RpcError::new(
                protocol::INVALID_REQUEST,
                "поддерживается только JSON-RPC 2.0",
            ),
        );
        return protocol::write_frame(io, &response).await;
    }
    let Some(id) = request.id else {
        return Ok(());
    };
    let response = if registry::is_known(&request.method) {
        let envelope = handler.call(&request.method, request.params).await;
        match serde_json::to_value(envelope) {
            Ok(result) => RpcResponse::result(id, result),
            Err(err) => RpcResponse::error(
                id,
                RpcError::new(
                    protocol::INTERNAL_ERROR,
                    format!("сериализация ответа: {err}"),
                ),
            ),
        }
    } else {
        RpcResponse::error(
            id,
            RpcError::new(
                protocol::METHOD_NOT_FOUND,
                format!("неизвестный метод «{}»", request.method),
            ),
        )
    };
    write_response(io, response).await
}

/// Пишет ответ кадром. Если сериализованный ответ не влезает в кадр
/// (`MAX_FRAME_BYTES`), вместо тихого обрыва соединения отправляет доменный
/// конверт `LIMIT` с тем же id — клиент получает понятную ошибку, а не EOF
/// (CONTRACT §4.1).
async fn write_response<W>(io: &mut W, response: RpcResponse) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(&response)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    if bytes.len() <= protocol::MAX_FRAME_BYTES {
        bytes.push(b'\n');
        io.write_all(&bytes).await?;
        return io.flush().await;
    }
    let envelope = Envelope::<Value>::err(
        GraphiteError::new(
            GraphiteErrorCode::Limit,
            "ответ превышает лимит кадра IPC (1 МиБ)",
        )
        .with_hint("запросите срез: section или offset/maxChars, либо меньший limit"),
    )
    .with_schema_version(protocol::SCHEMA_VERSION);
    let result = serde_json::to_value(envelope)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    protocol::write_frame(io, &RpcResponse::result(response.id, result)).await
}
