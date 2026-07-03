//! Конверт и ошибки объявлены в крейте `rpc` (CONTRACT §1.2) и реэкспортируются
//! отсюда без дублей (CONTRACT §9, правило 3).

pub use rpc::protocol::{SCHEMA_VERSION, VAULT_FORMAT};
pub use rpc::{Envelope, GraphiteError, GraphiteErrorCode, VaultError};

pub const ENVELOPE_V: &str = rpc::ENVELOPE_VERSION;
