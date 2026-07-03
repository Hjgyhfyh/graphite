#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("corrupt journal: {0}")]
    Corrupt(String),
    #[error("not found: {0}")]
    NotFound(String),
}
