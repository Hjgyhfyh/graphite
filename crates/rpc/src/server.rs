//! Сервер named pipe `\\.\pipe\graphite-core`: приём соединений, NDJSON-кадры,
//! диспетчеризация по реестру методов, graceful shutdown.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

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
                    Err(_) => tokio::task::yield_now().await,
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
    protocol::write_frame(io, &response).await
}
