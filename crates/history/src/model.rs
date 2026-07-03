//! Типы журнала объявлены в крейте `rpc` (CONTRACT §2) и реэкспортируются
//! отсюда без дублей (CONTRACT §9, правило 3).

pub use rpc::types::{Actor, FileChange, JournalOp};
