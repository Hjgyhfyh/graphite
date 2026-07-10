//! Конфигурация sync-реплик на устройстве. Живёт в `app_config_dir/sync.json`,
//! НЕ в папке реплики: код доступа хранится ЗДЕСЬ, поэтому копирование папки
//! реплики его не утащит и факт синка не раскроет.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{SyncError, SyncResult};
use crate::paths;

/// База сервера синхронизации по умолчанию (переопределяется в конфиге).
pub const DEFAULT_BASE_URL: &str = "https://telepasta.ru/graphite-sync";

/// Одна sync-реплика: идентификатор хранилища, код доступа (секрет!), корень
/// локальной папки, база сервера и последний применённый rev.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultConfig {
    pub vault_id: String,
    pub code: String,
    pub root: String,
    pub base_url: String,
    pub last_rev: i64,
}

/// Список sync-реплик, зарегистрированных на устройстве.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    #[serde(default)]
    pub vaults: Vec<SyncVaultConfig>,
}

/// Канонизирует путь-ключ для сравнения корней: нижний регистр, `\`→`/`, без
/// завершающего слэша — тот же принцип, что `vaultKey` на фронте.
pub fn root_key(path: &str) -> String {
    let s = paths::to_forward(path).to_lowercase();
    s.trim_end_matches('/').to_string()
}

impl SyncConfig {
    /// Читает конфиг из JSON. Отсутствие файла — пустой конфиг. Битый JSON тоже
    /// даёт пустой конфиг: лучше «нет реплик», чем падение старта.
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = fs::read(path) else {
            return Self::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    /// Атомарно пишет конфиг: temp-файл рядом → rename поверх.
    pub fn save_atomic(&self, path: &Path) -> SyncResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| SyncError::Protocol(format!("сериализация конфига: {e}")))?;
        let tmp = match path.parent() {
            Some(parent) => parent.join(".sync.json.tmp"),
            None => Path::new(".sync.json.tmp").to_path_buf(),
        };
        fs::write(&tmp, &json)?;
        if let Err(err) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(())
    }

    /// Находит реплику по корню (сравнение по канонизированному ключу пути).
    pub fn find_by_root(&self, root: &str) -> Option<&SyncVaultConfig> {
        let key = root_key(root);
        self.vaults.iter().find(|v| root_key(&v.root) == key)
    }

    /// Добавляет или заменяет реплику (ключ — корень). Возвращает `true`, если
    /// заменена существующая.
    pub fn upsert(&mut self, cfg: SyncVaultConfig) -> bool {
        let key = root_key(&cfg.root);
        if let Some(slot) = self.vaults.iter_mut().find(|v| root_key(&v.root) == key) {
            *slot = cfg;
            true
        } else {
            self.vaults.push(cfg);
            false
        }
    }

    /// Убирает реплику по корню. Возвращает `true`, если что-то удалено.
    pub fn remove(&mut self, root: &str) -> bool {
        let key = root_key(root);
        let before = self.vaults.len();
        self.vaults.retain(|v| root_key(&v.root) != key);
        self.vaults.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(root: &str) -> SyncVaultConfig {
        SyncVaultConfig {
            vault_id: "abc123".to_string(),
            code: "GRPH-00000-00000-00000-00000".to_string(),
            root: root.to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            last_rev: 0,
        }
    }

    #[test]
    fn root_key_is_canonical() {
        assert_eq!(root_key("C:\\Vault\\Sync\\"), "c:/vault/sync");
        assert_eq!(root_key("C:/Vault/Sync"), "c:/vault/sync");
    }

    #[test]
    fn upsert_and_find() {
        let mut c = SyncConfig::default();
        assert!(!c.upsert(cfg("C:/Vault/A")));
        // Тот же корень в другом регистре/слэшах — замена, не дубль.
        assert!(c.upsert(cfg("c:\\vault\\a")));
        assert_eq!(c.vaults.len(), 1);
        assert!(c.find_by_root("C:/VAULT/A").is_some());
        assert!(c.find_by_root("C:/Vault/B").is_none());
    }

    #[test]
    fn remove_by_root() {
        let mut c = SyncConfig::default();
        c.upsert(cfg("C:/Vault/A"));
        assert!(c.remove("c:/vault/a"));
        assert!(c.vaults.is_empty());
        assert!(!c.remove("c:/vault/a"));
    }

    #[test]
    fn roundtrip_persists_code() {
        let dir = std::env::temp_dir().join(format!("sync-core-cfg-{}", unique()));
        let path = dir.join("sync.json");
        let mut c = SyncConfig::default();
        c.upsert(cfg("C:/Vault/A"));
        c.save_atomic(&path).unwrap();
        let back = SyncConfig::load(&path);
        assert_eq!(back.vaults.len(), 1);
        assert_eq!(back.vaults[0].code, "GRPH-00000-00000-00000-00000");
        let _ = fs::remove_dir_all(&dir);
    }

    fn unique() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }
}
