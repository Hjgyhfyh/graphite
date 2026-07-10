//! Санитизация относительных путей протокола v1 (общая для клиента, совместимая
//! с серверной). Разделитель — `/`, кодировка UTF-8. Запрещены `..`, `.`, пустые
//! сегменты, ведущий `/`, `\0`. Бэкслеши нормализуются в `/` ДО валидации.
//! Служебные пути (`.graphite/**`, `.trash/**`, `.obsidian/**`, `desktop.ini`,
//! `thumbs.db`, `*.tmp`) в синхронизацию не попадают.

use crate::error::{SyncError, SyncResult};

/// Заменяет бэкслеши на прямые слэши — Windows-пути приводятся к канону протокола.
pub fn to_forward(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// `false` для служебных путей, которые клиент не синхронизирует (регистр
/// игнорируется). Совпадает с тем, что игнорирует watcher/индекс vault-core:
/// точечные служебные каталоги, системные файлы, временные `*.tmp`.
pub fn is_syncable(rel: &str) -> bool {
    let norm = to_forward(rel);
    let lower = norm.to_ascii_lowercase();
    if lower.starts_with(".graphite/")
        || lower.starts_with(".trash/")
        || lower.starts_with(".obsidian/")
    {
        return false;
    }
    // Любой сегмент с ".tmp" (temp-файлы атомарной записи, черновики редакторов).
    if lower.contains(".tmp") {
        return false;
    }
    // Базовое имя — системные файлы Windows/индексаторов.
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if base == "desktop.ini" || base == "thumbs.db" {
        return false;
    }
    true
}

/// Проверяет относительный путь строго по спеке. Бэкслеши приводятся к `/` до
/// проверки. Отказ — [`SyncError::Validation`] (на сервере это 400).
pub fn validate(rel: &str) -> SyncResult<()> {
    if rel.is_empty() {
        return Err(SyncError::Validation("пустой путь".to_string()));
    }
    let norm = to_forward(rel);
    if norm.contains('\0') {
        return Err(SyncError::Validation("путь содержит NUL".to_string()));
    }
    if norm.starts_with('/') {
        return Err(SyncError::Validation(format!("ведущий слэш: {rel}")));
    }
    if norm.ends_with('/') {
        return Err(SyncError::Validation(format!("завершающий слэш: {rel}")));
    }
    for segment in norm.split('/') {
        if segment.is_empty() {
            return Err(SyncError::Validation(format!("пустой сегмент: {rel}")));
        }
        if segment == "." || segment == ".." {
            return Err(SyncError::Validation(format!("сегмент \"{segment}\": {rel}")));
        }
    }
    Ok(())
}

/// Percent-encode относительного пути для строки запроса `?path=`. Кодирует всё,
/// кроме незарезервированных символов RFC 3986 и `/` (разделитель сегментов
/// сохраняется читаемым). Даёт явный контроль поверх авто-кодирования reqwest.
pub fn encode_path_query(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for &b in to_forward(rel).as_bytes() {
        let keep = matches!(b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/');
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

fn hex_upper(nib: u8) -> char {
    match nib {
        0..=9 => (b'0' + nib) as char,
        _ => (b'A' + (nib - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_traversal_and_empty() {
        assert!(validate("../etc").is_err());
        assert!(validate("a/../b").is_err());
        assert!(validate("./a").is_err());
        assert!(validate("a/./b").is_err());
        assert!(validate("a//b").is_err());
        assert!(validate("/lead").is_err());
        assert!(validate("trail/").is_err());
        assert!(validate("").is_err());
        assert!(validate("a\0b").is_err());
    }

    #[test]
    fn validate_accepts_normal_and_cyrillic() {
        assert!(validate("note.md").is_ok());
        assert!(validate("Проекты/Идея.md").is_ok());
        assert!(validate("_assets/картинка.png").is_ok());
        // Бэкслеши нормализуются и проходят как валидный вложенный путь.
        assert!(validate("Проекты\\Идея.md").is_ok());
    }

    #[test]
    fn syncable_filters_service() {
        assert!(!is_syncable(".graphite/sync/index.json"));
        assert!(!is_syncable(".trash/token/x.md"));
        assert!(!is_syncable(".obsidian/workspace.json"));
        assert!(!is_syncable("note.tmp"));
        assert!(!is_syncable(".note.md.01H.tmp"));
        assert!(!is_syncable("Thumbs.db"));
        assert!(!is_syncable("dir/desktop.ini"));
    }

    #[test]
    fn syncable_accepts_content() {
        assert!(is_syncable("Проекты/Идея.md"));
        assert!(is_syncable("note.md"));
        assert!(is_syncable("_assets/pic.png"));
        // Каталог с похожим именем, но не служебный.
        assert!(is_syncable("graphite-notes/x.md"));
    }

    #[test]
    fn encode_path_query_escapes_and_keeps_slashes() {
        assert_eq!(encode_path_query("a/b.md"), "a/b.md");
        assert_eq!(encode_path_query("a b.md"), "a%20b.md");
        // Кириллица кодируется в UTF-8 percent-байтах.
        assert_eq!(encode_path_query("Идея"), "%D0%98%D0%B4%D0%B5%D1%8F");
        // Бэкслеш нормализуется в слэш, а не кодируется.
        assert_eq!(encode_path_query("a\\b"), "a/b");
    }
}
