//! Код доступа к sync-хранилищу.
//!
//! Формат `GRPH-XXXXX-XXXXX-XXXXX-XXXXX`, где X — символ алфавита Крокфорда
//! (`0-9 A-Z` без `I L O U`): 20 значащих символов = 100 бит энтропии. Сервер
//! идентифицирует хранилище как `sha256(код)` в hex; сам код на сервере не
//! хранится, поэтому восстановить его нельзя — генерируем из криптослучайных байт.

use rand::TryRngCore;
use sha2::{Digest, Sha256};

/// Алфавит Крокфорда без визуально спорных `I L O U` — 32 символа (5 бит).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Число значащих символов кода (без префикса и дефисов).
const BODY_LEN: usize = 20;
/// Размер одной группы символов между дефисами.
const GROUP: usize = 5;
const PREFIX: &str = "GRPH";

/// Заполняет буфер криптослучайными байтами из ОС. `OsRng` в rand 0.9 фаллибелен;
/// сбой источника энтропии на десктопе исключителен, поэтому паника уместнее
/// тихого вырождения кода до предсказуемого.
fn fill_random(buf: &mut [u8]) {
    rand::rngs::OsRng
        .try_fill_bytes(buf)
        .expect("источник системной энтропии недоступен");
}

/// Генерирует новый код доступа в каноничном виде `GRPH-…`.
///
/// 20 символов по 5 бит = 100 бит. Берём по одному случайному байту на символ и
/// маппим младшие 5 бит в алфавит — равномерно (32 | 256, смещения нет).
pub fn generate() -> String {
    let mut bytes = [0u8; BODY_LEN];
    fill_random(&mut bytes);
    let body: String = bytes
        .iter()
        .map(|b| ALPHABET[(b & 0x1f) as usize] as char)
        .collect();
    format_code(&body)
}

/// Складывает 20-символьное тело в `GRPH-XXXXX-XXXXX-XXXXX-XXXXX`.
fn format_code(body: &str) -> String {
    let mut out = String::with_capacity(PREFIX.len() + 1 + BODY_LEN + BODY_LEN / GROUP);
    out.push_str(PREFIX);
    for (i, ch) in body.chars().enumerate() {
        if i % GROUP == 0 {
            out.push('-');
        }
        out.push(ch);
    }
    out
}

/// Приводит ввод пользователя к каноничному коду: верхний регистр, убраны
/// дефисы/пробелы, исправлены типичные омоглифы ввода (`I/L→1`, `O→0`, `U→V`).
/// Возвращает `Some` только если после чистки получилось ровно [`BODY_LEN`]
/// символов алфавита. Префикс `GRPH` в начале ввода опционален — он отбрасывается.
pub fn normalize(input: &str) -> Option<String> {
    let mut body = String::with_capacity(BODY_LEN);
    for ch in input.chars() {
        if ch == '-' || ch.is_whitespace() {
            continue;
        }
        let up = ch.to_ascii_uppercase();
        let mapped = match up {
            'I' | 'L' => '1',
            'O' => '0',
            'U' => 'V',
            other => other,
        };
        body.push(mapped);
    }
    // Ввод мог включать префикс GRPH — снимаем его, если тело длиннее нужного и
    // начинается с префикса (после маппинга O→0 не затрагивает буквы GRPH).
    if body.len() == BODY_LEN + PREFIX.len() {
        if let Some(rest) = body.strip_prefix(PREFIX) {
            body = rest.to_string();
        }
    }
    if body.len() != BODY_LEN {
        return None;
    }
    if !body.bytes().all(|b| ALPHABET.contains(&b)) {
        return None;
    }
    Some(format_code(&body))
}

/// Строгая проверка формата: ровно `GRPH-XXXXX-XXXXX-XXXXX-XXXXX`, каждый X — из
/// алфавита Крокфорда. Клиент проверяет заранее (неверный формат — на сервере 401).
pub fn is_valid(code: &str) -> bool {
    let expected_len = PREFIX.len() + 1 + BODY_LEN + (BODY_LEN / GROUP - 1);
    if code.len() != expected_len {
        return false;
    }
    let Some(rest) = code.strip_prefix(PREFIX) else {
        return false;
    };
    let groups: Vec<&str> = rest.split('-').collect();
    // Первый split-сегмент пуст (строка начинается с '-' после префикса).
    if groups.len() != BODY_LEN / GROUP + 1 || !groups[0].is_empty() {
        return false;
    }
    for group in &groups[1..] {
        if group.len() != GROUP || !group.bytes().all(|b| ALPHABET.contains(&b)) {
            return false;
        }
    }
    true
}

/// `sha256(код)` в hex-строке нижнего регистра — идентификатор хранилища на
/// сервере. Хешируется каноничная строка кода как есть (включая `GRPH-` и дефисы).
pub fn vault_id_hex(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_are_valid() {
        for _ in 0..1000 {
            let code = generate();
            assert!(is_valid(&code), "невалиден: {code}");
            assert!(code.starts_with("GRPH-"));
            assert_eq!(code.len(), 28);
        }
    }

    #[test]
    fn rejects_excluded_letters() {
        assert!(!is_valid("GRPH-IIIII-IIIII-IIIII-IIIII"));
        assert!(!is_valid("GRPH-LLLLL-LLLLL-LLLLL-LLLLL"));
        assert!(!is_valid("GRPH-OOOOO-OOOOO-OOOOO-OOOOO"));
        assert!(!is_valid("GRPH-UUUUU-UUUUU-UUUUU-UUUUU"));
    }

    #[test]
    fn rejects_bad_shape() {
        assert!(!is_valid(""));
        assert!(!is_valid("GRPH-12345-12345-12345"));
        assert!(!is_valid("GRPH-12345-12345-12345-123456"));
        assert!(!is_valid("XXXX-12345-12345-12345-12345"));
        assert!(!is_valid("GRPH_12345_12345_12345_12345"));
        assert!(!is_valid("grph-12345-12345-12345-12345"));
        // Валидная эталонная форма — как контроль.
        assert!(is_valid("GRPH-2345P-QRST0-9ABCD-EFGHJ"));
    }

    #[test]
    fn normalize_fixes_input() {
        // Нижний регистр и пробелы вместо дефисов приводятся к канону.
        let got = normalize("grph 2345p qrst0 9abcd efghj").unwrap();
        assert_eq!(got, "GRPH-2345P-QRST0-9ABCD-EFGHJ");
        assert!(is_valid(&got));
        // Голое 20-символьное тело (без префикса/дефисов) тоже канонизируется.
        let canon = normalize("2345PQRST09ABCDEFGHJ").unwrap();
        assert_eq!(canon, "GRPH-2345P-QRST0-9ABCD-EFGHJ");
        // Некорректная длина после чистки — отказ.
        assert!(normalize("2345P").is_none());
    }

    #[test]
    fn normalize_maps_homoglyphs_exactly() {
        // Ровно 20 символов ввода, все — омоглифы, чтобы проверить маппинг.
        let got = normalize("ILOU-ILOU-ILOU-ILOU-ILOU").unwrap();
        // I,L→1 ; O→0 ; U→V, повторено 5 раз = «110V» ×5.
        assert_eq!(got, "GRPH-110V1-10V11-0V110-V110V");
        assert!(is_valid(&got));
    }

    #[test]
    fn normalize_strips_optional_prefix() {
        // GRPH + ровно 20 символов тела (24 символа ввода без дефисов).
        let a = normalize("GRPH23456789ABCDEFGHJKMN").unwrap();
        assert_eq!(a, "GRPH-23456-789AB-CDEFG-HJKMN");
        assert!(is_valid(&a));
    }

    #[test]
    fn vault_id_matches_reference_sha256() {
        // Эталон: sha256("GRPH-00000-00000-00000-00000").
        let code = "GRPH-00000-00000-00000-00000";
        let id = vault_id_hex(code);
        assert_eq!(id.len(), 64);
        // Стабильность: повтор даёт то же значение.
        assert_eq!(id, vault_id_hex(code));
        // Известный вектор sha256 пустой строки — контроль самой функции хеша.
        assert_eq!(
            vault_id_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn vault_id_differs_per_code() {
        assert_ne!(
            vault_id_hex("GRPH-00000-00000-00000-00001"),
            vault_id_hex("GRPH-00000-00000-00000-00002")
        );
    }
}
