//! Клиентское ядро синхронизации хранилищ (протокол v1).
//!
//! Крейт автономен: не зависит от `vault-core`/`tauri`, поэтому вся логика —
//! генерация кода доступа, санитизация путей, локальный индекс состояния, дифф
//! (локаль/удалённое/база), план шагов и разрешение конфликтов — проверяется
//! юнит-тестами без сети и без линковки graphite-app. HTTP-клиент вынесен за
//! трейт-подобный слой (`client`) с чистыми парсерами статусов/тел, доступ к
//! диску абстрагирован трейтом [`engine::FileStore`], который реализует
//! приложение поверх своего писателя.

pub mod client;
pub mod code;
pub mod config;
pub mod diff;
pub mod engine;
pub mod error;
pub mod index;
pub mod paths;

pub use client::{RemoteManifest, SyncClient};
pub use config::{SyncConfig, SyncVaultConfig, DEFAULT_BASE_URL};
pub use diff::{conflict_name, Plan, PlanStep, RemoteEntry};
pub use engine::{FileStore, SyncOutcome};
pub use error::{SyncError, SyncResult};
pub use index::{sha256_hex, FileState, SyncIndex};
