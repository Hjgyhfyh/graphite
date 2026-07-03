//! Единственный писатель vault (SPEC §6.10, §6.12; формат §2, §12).
//!
//! Запись всегда атомарна: temp-файл в том же каталоге → fsync → rename.
//! Длинные пути проходят через `\\?\` (корень канонизируется, сегменты
//! добавляются по одному). Свои записи регистрируются в эхо-наборе
//! `(rel_path, blake3-64hex)` с TTL — его сверяет watcher и подавляет
//! реиндекс-цикл на собственные изменения.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::VaultError;
use crate::model::Rev;

/// Лимит длины имени файла вместе с расширением, в символах (формат §12).
pub const FILE_NAME_MAX_CHARS: usize = 120;
/// TTL записи эхо-набора: дебаунс 300 мс + stability-check с запасом.
pub const ECHO_TTL_MS: u64 = 10_000;
/// Папка мягкого удаления (формат §3.1).
pub const TRASH_DIR: &str = ".trash";

pub(crate) const TRASH_ORIGIN: &str = ".origin.json";

const MD_EXT: &str = ".md";
const ELLIPSIS: char = '…';
const FALLBACK_NAME: &str = "Без названия";
const RESERVED_STEM: &str = "_index";
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_MS: u64 = 40;

/// Эхо-набор писателя (SPEC §6.10): пары `(rel_path, blake3-64hex)` c TTL.
/// `register` кладёт запись перед своей записью на диск, watcher после
/// стабилизации вызывает `take` — попадание изымается и подавляет событие.
#[derive(Debug, Default)]
pub struct EchoSet {
    entries: Mutex<HashMap<(String, String), Instant>>,
}

impl EchoSet {
    pub fn register(&self, rel_path: &str, full_hash: &str) {
        self.register_for(rel_path, full_hash, Duration::from_millis(ECHO_TTL_MS));
    }

    pub fn register_for(&self, rel_path: &str, full_hash: &str, ttl: Duration) {
        let mut entries = self.lock_entries();
        let now = Instant::now();
        entries.retain(|_, deadline| *deadline > now);
        entries.insert((rel_path.to_string(), full_hash.to_string()), now + ttl);
    }

    pub fn take(&self, rel_path: &str, full_hash: &str) -> bool {
        let mut entries = self.lock_entries();
        let now = Instant::now();
        entries.retain(|_, deadline| *deadline > now);
        entries
            .remove(&(rel_path.to_string(), full_hash.to_string()))
            .is_some()
    }

    fn lock_entries(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Instant>> {
        match self.entries.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Общий эхо-набор процесса: сюда пишут все функции записи этого модуля,
/// его же передают в `watcher::start`.
pub fn shared_echo() -> Arc<EchoSet> {
    static ECHO: OnceLock<Arc<EchoSet>> = OnceLock::new();
    ECHO.get_or_init(|| Arc::new(EchoSet::default())).clone()
}

/// `rev` = первые 16 hex-символов blake3 полного содержимого (CONTRACT §1.3).
pub fn compute_rev(bytes: &[u8]) -> Rev {
    Rev(compute_full_hash(bytes)[..16].to_string())
}

/// Полный blake3 содержимого, 64 hex-символа в нижнем регистре.
pub fn compute_full_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Нормализация переводов строк для файлов, создаваемых приложением
/// (формат §2): `\r\n` и одиночные `\r` → `\n`. К чужим файлам не применяется.
pub fn normalize_lf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// Санитизация имени файла под Windows (формат §12): запрещённые
/// `\ / : * ? " < > |` и управляющие символы → `—`, краевые пробелы и точки
/// срезаются, длина ограничивается так, чтобы имя вместе с `.md` не превышало
/// [`FILE_NAME_MAX_CHARS`] символов (обрезка завершается `…`). Возвращает
/// стем без расширения; оригинал заголовка хранится во frontmatter `title`.
pub fn sanitize_file_name(title: &str) -> String {
    let mut mapped = String::with_capacity(title.len());
    for c in title.chars() {
        let safe = match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '—',
            c if (c as u32) < 0x20 => '—',
            c => c,
        };
        mapped.push(safe);
    }
    let trimmed = mapped.trim_matches([' ', '.']);
    let budget = FILE_NAME_MAX_CHARS - MD_EXT.chars().count();
    let mut stem: String = if trimmed.chars().count() > budget {
        let cut: String = trimmed.chars().take(budget - 1).collect();
        let mut cut = cut.trim_end_matches([' ', '.']).to_string();
        cut.push(ELLIPSIS);
        cut
    } else {
        trimmed.to_string()
    };
    if stem.is_empty() {
        stem = FALLBACK_NAME.to_string();
    }
    if stem == RESERVED_STEM {
        stem.push('—');
    }
    stem
}

/// Абсолютный путь внутри vault: корень канонизируется (на Windows это даёт
/// `\\?\`-форму, спасающую от MAX_PATH), сегменты `rel_path` добавляются по
/// одному, `..` запрещён.
pub fn vault_abs_path(vault_root: &Path, rel_path: &str) -> Result<PathBuf, VaultError> {
    let mut abs = fs::canonicalize(vault_root)?;
    for segment in rel_path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(VaultError::Validation(format!(
                "путь выходит за пределы vault: {rel_path}"
            )));
        }
        abs.push(segment);
    }
    Ok(abs)
}

/// Межпроцессный лок vault: `.graphite/vault.lock`. Возвращает нелокнутый
/// `RwLock`; захват (`try_write`) — на стороне вызывающего.
pub fn acquire_vault_lock(vault_root: &Path) -> Result<fd_lock::RwLock<File>, VaultError> {
    let dir = vault_abs_path(vault_root, ".graphite")?;
    fs::create_dir_all(&dir)?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(dir.join("vault.lock"))?;
    Ok(fd_lock::RwLock::new(file))
}

/// Атомарная запись: temp-файл рядом с целью → fsync → rename поверх.
/// Содержимое пишется байт-в-байт (стиль концов строк чужих файлов не
/// трогается); перед rename пара `(rel_path, blake3)` регистрируется в
/// общем эхо-наборе.
pub fn write_atomic(vault_root: &Path, rel_path: &str, content: &[u8]) -> Result<Rev, VaultError> {
    let abs = vault_abs_path(vault_root, rel_path)?;
    let parent = abs
        .parent()
        .ok_or_else(|| VaultError::Validation(format!("нет родительского каталога: {rel_path}")))?
        .to_path_buf();
    fs::create_dir_all(&parent)?;
    let file_name = abs
        .file_name()
        .ok_or_else(|| VaultError::Validation(format!("пустое имя файла: {rel_path}")))?
        .to_string_lossy()
        .into_owned();
    let tmp = parent.join(format!(".{file_name}.{}.tmp", ulid::Ulid::new()));
    let written = File::create(&tmp)
        .and_then(|mut file| {
            file.write_all(content)?;
            file.sync_all()
        })
        .map_err(VaultError::from);
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    let full_hash = compute_full_hash(content);
    shared_echo().register(rel_path, &full_hash);
    if let Err(err) = rename_with_retry(&tmp, &abs) {
        shared_echo().take(rel_path, &full_hash);
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(compute_rev(content))
}

/// Создание нового файла приложением: концы строк нормализуются в LF
/// (формат §2), существующая цель — ошибка валидации.
pub fn create_atomic(vault_root: &Path, rel_path: &str, text: &str) -> Result<Rev, VaultError> {
    let abs = vault_abs_path(vault_root, rel_path)?;
    if abs.exists() {
        return Err(VaultError::Validation(format!("файл уже существует: {rel_path}")));
    }
    write_atomic(vault_root, rel_path, normalize_lf(text).as_bytes())
}

/// Атомарный перенос файла или каталога внутри vault. Для файла целевая пара
/// `(to_rel, blake3)` регистрируется в эхо-наборе — rename-ветка watcher
/// сверяется именно с целевым путём.
pub fn rename_atomic(vault_root: &Path, from_rel: &str, to_rel: &str) -> Result<(), VaultError> {
    let from = vault_abs_path(vault_root, from_rel)?;
    let to = vault_abs_path(vault_root, to_rel)?;
    if !from.exists() {
        return Err(VaultError::NotFound(from_rel.to_string()));
    }
    if to.exists() {
        return Err(VaultError::Validation(format!("путь уже занят: {to_rel}")));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let echo_hash = if from.is_file() {
        let hash = compute_full_hash(&fs::read(&from)?);
        shared_echo().register(to_rel, &hash);
        Some(hash)
    } else {
        None
    };
    if let Err(err) = rename_with_retry(&from, &to) {
        if let Some(hash) = echo_hash {
            shared_echo().take(to_rel, &hash);
        }
        return Err(err);
    }
    Ok(())
}

/// Мягкое удаление: перенос в `.trash/<token>/<исходный rel-путь>` +
/// манифест `.origin.json`. Возвращает `restore_token` (ULID).
pub fn delete_to_trash(vault_root: &Path, rel_path: &str) -> Result<String, VaultError> {
    let token = ulid::Ulid::new().to_string();
    delete_to_trash_as(vault_root, rel_path, &token, rel_path)?;
    Ok(token)
}

pub(crate) fn delete_to_trash_as(
    vault_root: &Path,
    rel_path: &str,
    token: &str,
    primary: &str,
) -> Result<(), VaultError> {
    let from = vault_abs_path(vault_root, rel_path)?;
    if !from.exists() {
        return Err(VaultError::NotFound(rel_path.to_string()));
    }
    let dest_rel = format!("{TRASH_DIR}/{token}/{rel_path}");
    let dest = vault_abs_path(vault_root, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    rename_with_retry(&from, &dest)?;
    let origin = TrashOrigin {
        path: primary.to_string(),
        deleted_at: now_iso_utc(),
    };
    let manifest = vault_abs_path(vault_root, &format!("{TRASH_DIR}/{token}/{TRASH_ORIGIN}"))?;
    let payload = serde_json::to_vec(&origin)
        .map_err(|e| VaultError::Validation(format!("манифест корзины: {e}")))?;
    if let Err(err) = fs::write(&manifest, payload) {
        let _ = rename_with_retry(&dest, &from);
        return Err(err.into());
    }
    Ok(())
}

/// Восстановление из корзины: все файлы токена возвращаются на исходные
/// места, каталог токена удаляется. Возвращает rel-путь основной заметки.
pub fn restore_from_trash(vault_root: &Path, restore_token: &str) -> Result<String, VaultError> {
    if restore_token.is_empty() || !restore_token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(VaultError::Validation(format!(
            "некорректный restore_token: {restore_token}"
        )));
    }
    let token_rel = format!("{TRASH_DIR}/{restore_token}");
    let token_abs = vault_abs_path(vault_root, &token_rel)?;
    if !token_abs.is_dir() {
        return Err(VaultError::NotFound(format!("restore_token {restore_token}")));
    }
    let files = walk_rel_files(&token_abs)?;
    let mut targets: Vec<String> = files
        .into_iter()
        .filter(|rel| rel != TRASH_ORIGIN)
        .collect();
    targets.sort();
    if targets.is_empty() {
        return Err(VaultError::NotFound(format!("restore_token {restore_token}")));
    }
    let origin = trash_read_origin(vault_root, restore_token)?
        .unwrap_or_else(|| targets[0].clone());
    for rel in &targets {
        let dest = vault_abs_path(vault_root, rel)?;
        if dest.exists() {
            return Err(VaultError::Validation(format!("путь уже занят: {rel}")));
        }
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for rel in &targets {
        let from = token_abs.join(rel.split('/').collect::<PathBuf>());
        let dest = vault_abs_path(vault_root, rel)?;
        if let Some(parent) = dest.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                rollback_restore(&moved);
                return Err(err.into());
            }
        }
        if rel.to_ascii_lowercase().ends_with(MD_EXT) {
            if let Ok(bytes) = fs::read(&from) {
                shared_echo().register(rel, &compute_full_hash(&bytes));
            }
        }
        if let Err(err) = rename_with_retry(&from, &dest) {
            rollback_restore(&moved);
            return Err(err);
        }
        moved.push((from, dest));
    }
    let _ = fs::remove_dir_all(&token_abs);
    Ok(origin)
}

pub(crate) fn trash_read_origin(
    vault_root: &Path,
    token: &str,
) -> Result<Option<String>, VaultError> {
    let manifest = vault_abs_path(vault_root, &format!("{TRASH_DIR}/{token}/{TRASH_ORIGIN}"))?;
    let Ok(bytes) = fs::read(&manifest) else {
        return Ok(None);
    };
    Ok(serde_json::from_slice::<TrashOrigin>(&bytes)
        .ok()
        .map(|origin| origin.path))
}

pub(crate) fn trash_tokens(vault_root: &Path) -> Result<Vec<String>, VaultError> {
    let trash = match vault_abs_path(vault_root, TRASH_DIR) {
        Ok(path) => path,
        Err(_) => return Ok(Vec::new()),
    };
    let Ok(entries) = fs::read_dir(&trash) else {
        return Ok(Vec::new());
    };
    let mut tokens: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    tokens.sort();
    tokens.reverse();
    Ok(tokens)
}

/// Все файлы под каталогом, rel-пути с `/`-разделителями, отсортированы.
pub(crate) fn walk_rel_files(abs_dir: &Path) -> Result<Vec<String>, VaultError> {
    let mut out = Vec::new();
    let mut stack = vec![(abs_dir.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        for entry in fs::read_dir(&dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push((entry.path(), rel));
            } else if file_type.is_file() {
                out.push(rel);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Текущий момент в ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn now_iso_utc() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    format_epoch_ms(ms)
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

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), VaultError> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                attempt += 1;
                if attempt >= RENAME_ATTEMPTS {
                    return Err(err.into());
                }
                std::thread::sleep(Duration::from_millis(RENAME_RETRY_MS));
            }
        }
    }
}

fn rollback_restore(moved: &[(PathBuf, PathBuf)]) {
    for (from, dest) in moved.iter().rev() {
        let _ = fs::rename(dest, from);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashOrigin {
    path: String,
    deleted_at: String,
}
