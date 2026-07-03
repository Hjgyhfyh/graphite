//! Указатель на последний открытый vault. Хранится вне хранилища (в конфиг-папке
//! приложения), чтобы ядро могло автоматически смонтировать vault на старте —
//! до того, как известен его путь, и без открытого окна (для pipe/MCP).

use std::path::{Path, PathBuf};

const APP_IDENTIFIER: &str = "com.graphite.app";
const LAST_VAULT_FILE: &str = "last-vault.json";

/// Каталог конфигурации приложения (`%APPDATA%\com.graphite.app`).
pub fn config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))?;
    Some(base.join(APP_IDENTIFIER))
}

/// Запоминает путь текущего vault. Сбои записи не критичны — просто не будет
/// автомонтирования в следующий раз.
pub fn save_last_vault(root: &Path) {
    let Some(dir) = config_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let payload = serde_json::json!({ "vault": root.to_string_lossy() });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(dir.join(LAST_VAULT_FILE), text);
    }
}

/// Возвращает сохранённый путь vault, если он записан и непустой.
pub fn load_last_vault() -> Option<PathBuf> {
    let dir = config_dir()?;
    let text = std::fs::read_to_string(dir.join(LAST_VAULT_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = value.get("vault")?.as_str()?;
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}
