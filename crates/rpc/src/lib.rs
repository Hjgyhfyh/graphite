//! Протокольный крейт Graphite: конверт ответов и коды ошибок (CONTRACT §1),
//! канонические типы ядра и реестра инструментов (CONTRACT §2–§3),
//! JSON-RPC 2.0 поверх named pipe `\\.\pipe\graphite-core` (CONTRACT §4).

pub mod client;
pub mod error;
pub mod protocol;
pub mod registry;
pub mod server;
pub mod types;

pub use client::{ClientError, RpcClient};
pub use error::{ENVELOPE_VERSION, Envelope, GraphiteError, GraphiteErrorCode, VaultError};
pub use server::{Handler, MethodFuture, RpcServer, ServerHandle, StubHandler};
pub use types::*;
