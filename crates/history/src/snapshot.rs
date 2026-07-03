//! Content-addressed хранилище снапшотов (SPEC §6.8):
//! `.graphite/history/objects/<2 hex>/<blake3 64 hex>`, содержимое сжато zstd.
//! Адрес объекта — blake3 несжатого содержимого; дедуп бесплатно.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::HistoryError;

/// Префикс хэшей в журнале и `FileChange` (CONTRACT §1.3): `blake3:<64hex>`.
pub const HASH_LABEL: &str = "blake3:";

const ZSTD_LEVEL: i32 = 3;

/// Полный blake3 содержимого, 64 hex-символа lowercase.
pub fn hash_hex(content: &[u8]) -> String {
    blake3::hash(content).to_hex().to_string()
}

/// Хэш в формате журнала: `blake3:<64hex>`.
pub fn labeled_hash(content: &[u8]) -> String {
    format!("{HASH_LABEL}{}", hash_hex(content))
}

/// Кладёт содержимое в хранилище, возвращает его blake3 (64 hex).
/// Объект уже существует → запись не выполняется (дедуп).
pub fn put(objects_dir: &Path, content: &[u8]) -> Result<String, HistoryError> {
    let hash = hash_hex(content);
    let path = object_path(objects_dir, &hash);
    if path.is_file() {
        return Ok(hash);
    }
    let bucket = path.parent().expect("object path has bucket dir");
    std::fs::create_dir_all(bucket)?;
    let compressed = zstd::encode_all(content, ZSTD_LEVEL)?;
    let tmp = bucket.join(format!(".tmp-{}", ulid::Ulid::new()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&compressed)?;
        f.sync_data()?;
        drop(f);
        std::fs::rename(&tmp, &path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        if !path.is_file() {
            return Err(e.into());
        }
    }
    Ok(hash)
}

/// Достаёт содержимое по хэшу (принимает `<64hex>` и `blake3:<64hex>`).
/// Целостность проверяется: blake3 распакованного содержимого обязан совпасть.
pub fn get(objects_dir: &Path, hash: &str) -> Result<Vec<u8>, HistoryError> {
    let hash = normalize_hash(hash)?;
    let path = object_path(objects_dir, &hash);
    let compressed = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(HistoryError::NotFound(format!("snapshot {hash}")));
        }
        Err(e) => return Err(e.into()),
    };
    let content = zstd::decode_all(&compressed[..])
        .map_err(|e| HistoryError::Corrupt(format!("snapshot {hash}: {e}")))?;
    if hash_hex(&content) != hash {
        return Err(HistoryError::Corrupt(format!("snapshot {hash}: hash mismatch")));
    }
    Ok(content)
}

/// Есть ли объект в хранилище.
pub fn exists(objects_dir: &Path, hash: &str) -> Result<bool, HistoryError> {
    Ok(object_path(objects_dir, &normalize_hash(hash)?).is_file())
}

fn object_path(objects_dir: &Path, hash: &str) -> PathBuf {
    objects_dir.join(&hash[0..2]).join(hash)
}

fn normalize_hash(hash: &str) -> Result<String, HistoryError> {
    let h = hash.strip_prefix(HASH_LABEL).unwrap_or(hash);
    if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(h.to_ascii_lowercase())
    } else {
        Err(HistoryError::Invalid(format!("bad blake3 hash: {hash}")))
    }
}
