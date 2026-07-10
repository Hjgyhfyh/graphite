//! Локальный индекс прошлого состояния синка — база для 3-way сравнения.
//!
//! Хранит для каждого относительного пути хеш/размер/mtime на момент последней
//! успешной синхронизации плюс `last_rev` сервера. Это перестраиваемый кэш
//! (лежит в `.graphite/sync/index.json` реплики, НЕ секрет), поэтому его потеря
//! приводит лишь к более осторожному полному сравнению, а не к утечке.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::SyncResult;
use crate::paths;

/// Состояние одного файла на момент прошлого синка.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq, Eq)]
pub struct FileState {
    pub hash: String,
    pub size: u64,
    pub mtime_utc: String,
}

/// Индекс синхронизации: rev сервера + снимок состояния файлов.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncIndex {
    pub last_rev: i64,
    /// rel-путь → состояние на момент прошлого синка.
    pub files: BTreeMap<String, FileState>,
}

/// `sha256(bytes)` в hex-строке нижнего регистра — хеш протокола v1. Отдельная
/// функция: НЕ переиспользовать blake3-хеши vault-core, иначе вечные ложные
/// конфликты (сервер сравнивает именно sha256).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

impl SyncIndex {
    /// Читает индекс из JSON-файла. Отсутствие файла — пустой индекс (первый
    /// синк), а не ошибка. Битый JSON тоже даёт пустой индекс: кэш перестроится
    /// сравнением, синк не должен падать из-за повреждённого кэша.
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = fs::read(path) else {
            return Self::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    /// Атомарно пишет индекс: temp-файл рядом → rename поверх. Родительский
    /// каталог создаётся при необходимости.
    pub fn save_atomic(&self, path: &Path) -> SyncResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| crate::error::SyncError::Protocol(format!("сериализация индекса: {e}")))?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "index.json".to_string());
        let tmp = match path.parent() {
            Some(parent) => parent.join(format!(".{file_name}.tmp")),
            None => Path::new(&format!(".{file_name}.tmp")).to_path_buf(),
        };
        fs::write(&tmp, &json)?;
        if let Err(err) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(())
    }
}

/// mtime файла в ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`). При недоступном
/// времени модификации — пустая строка (mtime информативен, но не решающий:
/// сравнение опирается на хеши).
fn mtime_iso_utc(meta: &fs::Metadata) -> String {
    use std::time::UNIX_EPOCH;
    let Ok(mtime) = meta.modified() else {
        return String::new();
    };
    let Ok(dur) = mtime.duration_since(UNIX_EPOCH) else {
        return String::new();
    };
    format_epoch_ms(dur.as_millis() as u64)
}

fn format_epoch_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Обходит реплику и собирает состояние синхронизируемых файлов. Тянет ВСЕ
/// файлы (не только `.md` — вложения тоже), пропуская служебные пути
/// ([`paths::is_syncable`]). Симлинки/недоступные записи молча пропускаются.
pub fn scan_local(root: &Path) -> SyncResult<BTreeMap<String, FileState>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                // Не спускаемся в служебные каталоги (их содержимое несинкаемо).
                if paths::is_syncable(&format!("{rel}/")) {
                    stack.push((entry.path(), rel));
                }
            } else if file_type.is_file() {
                if !paths::is_syncable(&rel) {
                    continue;
                }
                let abs = entry.path();
                let Ok(bytes) = fs::read(&abs) else {
                    continue;
                };
                let meta = fs::metadata(&abs).ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(bytes.len() as u64);
                let mtime_utc = meta.as_ref().map(mtime_iso_utc).unwrap_or_default();
                out.insert(
                    rel,
                    FileState {
                        hash: sha256_hex(&bytes),
                        size,
                        mtime_utc,
                    },
                );
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_reference() {
        // Известный вектор: sha256("abc").
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Пустой ввод.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn index_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sync-core-idx-{}", unique()));
        let path = dir.join(".graphite/sync/index.json");
        let mut idx = SyncIndex::default();
        idx.last_rev = 42;
        idx.files.insert(
            "Проекты/Идея.md".to_string(),
            FileState {
                hash: sha256_hex(b"hello"),
                size: 5,
                mtime_utc: "2026-01-01T00:00:00.000Z".to_string(),
            },
        );
        idx.save_atomic(&path).unwrap();
        let back = SyncIndex::load(&path);
        assert_eq!(back.last_rev, 42);
        assert_eq!(back.files.len(), 1);
        assert_eq!(back.files["Проекты/Идея.md"].size, 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_is_empty() {
        let path = std::env::temp_dir().join(format!("sync-core-missing-{}.json", unique()));
        let idx = SyncIndex::load(&path);
        assert_eq!(idx.last_rev, 0);
        assert!(idx.files.is_empty());
    }

    #[test]
    fn scan_ignores_service_and_reads_content() {
        let root = std::env::temp_dir().join(format!("sync-core-scan-{}", unique()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Проекты")).unwrap();
        fs::create_dir_all(root.join(".graphite/sync")).unwrap();
        fs::create_dir_all(root.join(".trash/tok")).unwrap();
        fs::write(root.join("note.md"), b"content").unwrap();
        fs::write(root.join("Проекты/Идея.md"), b"idea").unwrap();
        fs::write(root.join("draft.tmp"), b"tmp").unwrap();
        fs::write(root.join("Thumbs.db"), b"db").unwrap();
        fs::write(root.join(".graphite/sync/index.json"), b"{}").unwrap();
        fs::write(root.join(".trash/tok/gone.md"), b"gone").unwrap();

        let scan = scan_local(&root).unwrap();
        assert!(scan.contains_key("note.md"));
        assert!(scan.contains_key("Проекты/Идея.md"));
        assert!(!scan.contains_key("draft.tmp"));
        assert!(!scan.contains_key("Thumbs.db"));
        assert!(!scan.keys().any(|k| k.starts_with(".graphite")));
        assert!(!scan.keys().any(|k| k.starts_with(".trash")));
        assert_eq!(scan["note.md"].hash, sha256_hex(b"content"));
        assert_eq!(scan["note.md"].size, 7);
        let _ = fs::remove_dir_all(&root);
    }

    fn unique() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
