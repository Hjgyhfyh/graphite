pub mod error;
pub mod journal;
pub mod model;
pub mod snapshot;
pub mod undo;

pub use error::HistoryError;
pub use journal::{append_op, read_ops};
pub use model::{Actor, FileChange, JournalOp};
pub use snapshot::snapshot_file;
pub use undo::{undo_plan, FileRestore, UndoPlan};
