//! Клиент named pipe: connect, `call(method, params)` с таймаутом по классу
//! метода (CONTRACT §4.4), доменный результат — конвертом `Envelope`.

use std::time::Duration;

use interprocess::local_socket::{
    GenericNamespaced, ToNsName,
    tokio::{Stream, prelude::*},
};
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};

use crate::error::Envelope;
use crate::protocol::{self, HelloParams, RpcRequest, RpcResponse};
use crate::registry;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("канал «{pipe}» недоступен: {source}")]
    Connect {
        pipe: String,
        #[source]
        source: std::io::Error,
    },
    #[error("ввод-вывод: {0}")]
    Io(#[from] std::io::Error),
    #[error("таймаут {timeout:?} на вызове «{method}»")]
    Timeout { method: String, timeout: Duration },
    #[error("нарушение протокола: {0}")]
    Protocol(String),
    #[error("JSON-RPC ошибка {code}: {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("соединение испорчено предыдущей ошибкой, переподключитесь")]
    Poisoned,
}

pub struct RpcClient {
    io: BufReader<Stream>,
    next_id: u64,
    poisoned: bool,
}

impl RpcClient {
    /// Подключение к каноническому каналу `\\.\pipe\graphite-core`.
    pub async fn connect() -> Result<Self, ClientError> {
        Self::connect_to(protocol::PIPE_NAME).await
    }

    pub async fn connect_to(pipe_name: &str) -> Result<Self, ClientError> {
        let name = pipe_name
            .to_ns_name::<GenericNamespaced>()
            .map_err(|source| ClientError::Connect {
                pipe: pipe_name.to_string(),
                source,
            })?;
        let stream = Stream::connect(name)
            .await
            .map_err(|source| ClientError::Connect {
                pipe: pipe_name.to_string(),
                source,
            })?;
        Ok(Self {
            io: BufReader::new(stream),
            next_id: 0,
            poisoned: false,
        })
    }

    /// Вызов с таймаутом по классу метода (`hello` 2 с, чтение 10 с, мутации 30 с).
    /// Доменные ошибки приходят конвертом `ok:false`; `Err` — транспорт/протокол.
    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Envelope<Value>, ClientError> {
        self.call_with_timeout(method, params, registry::default_timeout(method))
            .await
    }

    pub async fn call_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Envelope<Value>, ClientError> {
        if self.poisoned {
            return Err(ClientError::Poisoned);
        }
        self.next_id += 1;
        let id = self.next_id;
        let request = RpcRequest::new(id, method, params);
        let io = &mut self.io;
        let exchange = async move {
            protocol::write_frame(io, &request).await?;
            let Some(bytes) = protocol::read_frame(io).await? else {
                return Err(ClientError::Protocol(
                    "сервер закрыл соединение".to_string(),
                ));
            };
            let response: RpcResponse = serde_json::from_slice(&bytes)
                .map_err(|err| ClientError::Protocol(format!("некорректный кадр ответа: {err}")))?;
            Ok(response)
        };
        let response = match tokio::time::timeout(timeout, exchange).await {
            Err(_) => {
                self.poisoned = true;
                return Err(ClientError::Timeout {
                    method: method.to_string(),
                    timeout,
                });
            }
            Ok(Err(err)) => {
                self.poisoned = true;
                return Err(err);
            }
            Ok(Ok(response)) => response,
        };
        if response.id != Value::from(id) {
            self.poisoned = true;
            return Err(ClientError::Protocol(format!(
                "id ответа {} не совпадает с id запроса {id}",
                response.id
            )));
        }
        if let Some(error) = response.error {
            return Err(ClientError::Rpc {
                code: error.code,
                message: error.message,
                data: error.data,
            });
        }
        let result = response.result.ok_or_else(|| {
            ClientError::Protocol("в ответе нет ни result, ни error".to_string())
        })?;
        serde_json::from_value(result)
            .map_err(|err| ClientError::Protocol(format!("некорректный конверт: {err}")))
    }

    /// Рукопожатие CONTRACT §4.2.
    pub async fn hello(
        &mut self,
        token: &str,
        client: &str,
    ) -> Result<Envelope<Value>, ClientError> {
        let params = serde_json::to_value(HelloParams {
            token: token.to_string(),
            client: client.to_string(),
            schema_version: protocol::SCHEMA_VERSION.to_string(),
        })
        .map_err(|err| ClientError::Protocol(err.to_string()))?;
        self.call("hello", params).await
    }

    /// Graceful закрытие соединения со стороны клиента.
    pub async fn shutdown(mut self) -> Result<(), ClientError> {
        self.io.shutdown().await?;
        Ok(())
    }
}
