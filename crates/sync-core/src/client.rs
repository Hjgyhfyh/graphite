//! HTTP-клиент протокола синхронизации v1 (reqwest blocking, таймауты).
//!
//! Все `/v1/*` шлют `Authorization: Bearer <код>`. Разбор статусов и тел вынесен
//! в чистые функции ([`classify_status`], [`parse_conflict_body`],
//! [`parse_manifest`]), которые тестируются без сети; сетевые вызовы — тонкая
//! обёртка над ними. Интеграция с реальным сервером проверяется вручную.

use std::time::Duration;

use serde::Deserialize;

use crate::code;
use crate::diff::RemoteEntry;
use crate::error::{SyncError, SyncResult};
use crate::paths;

/// Литерал `X-If-Hash` для «файла на сервере быть не должно».
pub const IF_HASH_ABSENT: &str = "absent";

/// Разобранный ответ манифеста/изменений.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteManifest {
    pub rev: i64,
    pub files: Vec<RemoteEntry>,
}

/// Клиент одного хранилища: базовый URL + код доступа.
pub struct SyncClient {
    http: reqwest::blocking::Client,
    base: String,
    code: String,
}

/// Классификация HTTP-статуса мутации в доменную ошибку (или Ok для 2xx). Тело
/// 409 разбирается вызывающим (нужен `server_hash`), здесь — прочие статусы.
pub fn classify_status(status: u16) -> SyncResult<()> {
    match status {
        200..=299 => Ok(()),
        400 => Err(SyncError::Validation("сервер отверг путь (400)".to_string())),
        401 => Err(SyncError::BadCode),
        409 => Err(SyncError::Conflict { server_hash: None }),
        413 => Err(SyncError::Limit("файл превышает 20 МБ (413)".to_string())),
        507 => Err(SyncError::Limit("хранилище переполнено (507)".to_string())),
        other => Err(SyncError::Http(format!("неожиданный статус {other}"))),
    }
}

/// Тело конфликта `{"error":"conflict","hash":<hex|null>}` → актуальный серверный
/// хеш (или `None`, если `absent`/null). Битое тело — `None` (движок перечитает
/// состояние отдельно).
pub fn parse_conflict_body(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Body {
        #[serde(default)]
        hash: Option<String>,
    }
    let parsed: Body = serde_json::from_str(body).ok()?;
    parsed.hash.filter(|h| !h.is_empty())
}

/// Разбор JSON манифеста/изменений в [`RemoteManifest`].
pub fn parse_manifest(body: &str) -> SyncResult<RemoteManifest> {
    #[derive(Deserialize)]
    struct Entry {
        path: String,
        #[serde(default)]
        hash: String,
        #[serde(default)]
        size: i64,
        #[serde(default, rename = "mtimeUtc")]
        mtime_utc: String,
        #[serde(default)]
        rev: i64,
        #[serde(default)]
        deleted: bool,
    }
    #[derive(Deserialize)]
    struct Manifest {
        rev: i64,
        #[serde(default)]
        files: Vec<Entry>,
    }
    let m: Manifest = serde_json::from_str(body)
        .map_err(|e| SyncError::Protocol(format!("манифест: {e}")))?;
    let files = m
        .files
        .into_iter()
        .map(|e| RemoteEntry {
            path: e.path,
            hash: e.hash,
            size: e.size,
            mtime_utc: e.mtime_utc,
            rev: e.rev,
            deleted: e.deleted,
        })
        .collect();
    Ok(RemoteManifest { rev: m.rev, files })
}

/// Ответ мутации `{"rev":int,"hash":str}` (hash есть у PUT, у DELETE — нет).
fn parse_mut_body(body: &str) -> SyncResult<(i64, String)> {
    #[derive(Deserialize)]
    struct Body {
        rev: i64,
        #[serde(default)]
        hash: String,
    }
    let b: Body = serde_json::from_str(body)
        .map_err(|e| SyncError::Protocol(format!("ответ мутации: {e}")))?;
    Ok((b.rev, b.hash))
}

/// Ответ `POST /v1/vault` — `{"vaultId":str,"rev":int}`.
fn parse_vault_body(body: &str) -> SyncResult<(String, i64)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        vault_id: String,
        rev: i64,
    }
    let b: Body = serde_json::from_str(body)
        .map_err(|e| SyncError::Protocol(format!("ответ vault: {e}")))?;
    Ok((b.vault_id, b.rev))
}

/// Гарантирует установленный процессный крипто-провайдер rustls (ring). reqwest
/// собран с `rustls-no-provider`, поэтому провайдер должен быть выбран до TLS.
/// Вызов идемпотентен: повторная установка (например, после плагина обновлений
/// tauri) возвращает Err и молча игнорируется.
fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

impl SyncClient {
    /// Создаёт клиента. Валидирует формат кода заранее (иначе сервер вернул бы
    /// 401 на каждом запросе). Таймауты: 30 с общий, 10 с на соединение.
    pub fn new(base: &str, code: &str) -> SyncResult<Self> {
        if !code::is_valid(code) {
            return Err(SyncError::BadCode);
        }
        ensure_crypto_provider();
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| SyncError::Http(format!("не удалось создать HTTP-клиент: {e}")))?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            code: code.to_string(),
        })
    }

    fn url(&self, suffix: &str) -> String {
        format!("{}{}", self.base, suffix)
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.code)
    }

    /// `GET /health` без auth — проба доступности сервиса.
    pub fn health(&self) -> SyncResult<()> {
        let resp = self
            .http
            .get(self.url("/health"))
            .send()
            .map_err(|e| SyncError::Http(format!("health: {e}")))?;
        classify_status(resp.status().as_u16())
    }

    /// `POST /v1/vault` → `(vaultId, rev)`; идемпотентно создаёт хранилище.
    pub fn ensure_vault(&self) -> SyncResult<(String, i64)> {
        let resp = self
            .http
            .post(self.url("/v1/vault"))
            .header(reqwest::header::AUTHORIZATION, self.bearer())
            .send()
            .map_err(|e| SyncError::Http(format!("vault: {e}")))?;
        let status = resp.status().as_u16();
        classify_status(status)?;
        let body = resp
            .text()
            .map_err(|e| SyncError::Http(format!("vault тело: {e}")))?;
        parse_vault_body(&body)
    }

    /// `GET /v1/manifest` → полный список файлов (включая томбстоуны).
    pub fn manifest(&self) -> SyncResult<RemoteManifest> {
        self.get_manifest("/v1/manifest")
    }

    /// `GET /v1/changes?since=<int>` → записи с `rev > since`.
    pub fn changes(&self, since: i64) -> SyncResult<RemoteManifest> {
        self.get_manifest(&format!("/v1/changes?since={since}"))
    }

    fn get_manifest(&self, suffix: &str) -> SyncResult<RemoteManifest> {
        let resp = self
            .http
            .get(self.url(suffix))
            .header(reqwest::header::AUTHORIZATION, self.bearer())
            .send()
            .map_err(|e| SyncError::Http(format!("manifest: {e}")))?;
        classify_status(resp.status().as_u16())?;
        let body = resp
            .text()
            .map_err(|e| SyncError::Http(format!("manifest тело: {e}")))?;
        parse_manifest(&body)
    }

    /// `GET /v1/file?path=…` → сырые байты (200) или `None` (404).
    pub fn get_file(&self, path: &str) -> SyncResult<Option<Vec<u8>>> {
        let resp = self
            .http
            .get(self.url("/v1/file"))
            .header(reqwest::header::AUTHORIZATION, self.bearer())
            .query(&[("path", path)])
            .send()
            .map_err(|e| SyncError::Http(format!("get_file: {e}")))?;
        let status = resp.status().as_u16();
        if status == 404 {
            return Ok(None);
        }
        classify_status(status)?;
        let bytes = resp
            .bytes()
            .map_err(|e| SyncError::Http(format!("get_file тело: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    /// `PUT /v1/file?path=…` с телом-байтами и опц. `X-If-Hash`. Успех →
    /// `(rev, hash)`; 409 → `Conflict{server_hash}` (хеш из тела).
    pub fn put_file(
        &self,
        path: &str,
        body: &[u8],
        if_hash: Option<&str>,
    ) -> SyncResult<(i64, String)> {
        paths::validate(path)?;
        let mut req = self
            .http
            .put(self.url("/v1/file"))
            .header(reqwest::header::AUTHORIZATION, self.bearer())
            .query(&[("path", path)])
            .body(body.to_vec());
        if let Some(h) = if_hash {
            req = req.header("X-If-Hash", h);
        }
        let resp = req
            .send()
            .map_err(|e| SyncError::Http(format!("put_file: {e}")))?;
        let status = resp.status().as_u16();
        if status == 409 {
            let text = resp.text().unwrap_or_default();
            return Err(SyncError::Conflict {
                server_hash: parse_conflict_body(&text),
            });
        }
        classify_status(status)?;
        let text = resp
            .text()
            .map_err(|e| SyncError::Http(format!("put_file тело: {e}")))?;
        parse_mut_body(&text)
    }

    /// `DELETE /v1/file?path=…` с опц. `X-If-Hash`. Успех → новый rev;
    /// 409 → `Conflict{server_hash}`.
    pub fn delete_file(&self, path: &str, if_hash: Option<&str>) -> SyncResult<i64> {
        paths::validate(path)?;
        let mut req = self
            .http
            .delete(self.url("/v1/file"))
            .header(reqwest::header::AUTHORIZATION, self.bearer())
            .query(&[("path", path)]);
        if let Some(h) = if_hash {
            req = req.header("X-If-Hash", h);
        }
        let resp = req
            .send()
            .map_err(|e| SyncError::Http(format!("delete_file: {e}")))?;
        let status = resp.status().as_u16();
        if status == 409 {
            let text = resp.text().unwrap_or_default();
            return Err(SyncError::Conflict {
                server_hash: parse_conflict_body(&text),
            });
        }
        classify_status(status)?;
        let text = resp
            .text()
            .map_err(|e| SyncError::Http(format!("delete_file тело: {e}")))?;
        let (rev, _) = parse_mut_body(&text)?;
        Ok(rev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_statuses() {
        assert!(classify_status(200).is_ok());
        assert!(classify_status(204).is_ok());
        assert!(matches!(classify_status(400), Err(SyncError::Validation(_))));
        assert!(matches!(classify_status(401), Err(SyncError::BadCode)));
        assert!(matches!(
            classify_status(409),
            Err(SyncError::Conflict { server_hash: None })
        ));
        assert!(matches!(classify_status(413), Err(SyncError::Limit(_))));
        assert!(matches!(classify_status(507), Err(SyncError::Limit(_))));
        assert!(matches!(classify_status(500), Err(SyncError::Http(_))));
    }

    #[test]
    fn conflict_body_parsing() {
        assert_eq!(
            parse_conflict_body(r#"{"error":"conflict","hash":"abcdef"}"#),
            Some("abcdef".to_string())
        );
        assert_eq!(parse_conflict_body(r#"{"error":"conflict","hash":null}"#), None);
        assert_eq!(parse_conflict_body(r#"{"error":"conflict"}"#), None);
        assert_eq!(parse_conflict_body("not json"), None);
    }

    #[test]
    fn manifest_parsing() {
        let body = r#"{"rev":7,"files":[
            {"path":"a.md","hash":"h1","size":3,"mtimeUtc":"2026-01-01T00:00:00Z","rev":5,"deleted":false},
            {"path":"b.md","hash":"","size":0,"mtimeUtc":"2026-01-02T00:00:00Z","rev":7,"deleted":true}
        ]}"#;
        let m = parse_manifest(body).unwrap();
        assert_eq!(m.rev, 7);
        assert_eq!(m.files.len(), 2);
        assert_eq!(m.files[0].path, "a.md");
        assert_eq!(m.files[0].hash, "h1");
        assert_eq!(m.files[0].rev, 5);
        assert!(!m.files[0].deleted);
        assert!(m.files[1].deleted);
    }

    #[test]
    fn manifest_empty_files() {
        let m = parse_manifest(r#"{"rev":0,"files":[]}"#).unwrap();
        assert_eq!(m.rev, 0);
        assert!(m.files.is_empty());
        // Отсутствие files допустимо (serde default).
        let m2 = parse_manifest(r#"{"rev":1}"#).unwrap();
        assert_eq!(m2.rev, 1);
        assert!(m2.files.is_empty());
    }

    #[test]
    fn manifest_bad_json_is_protocol_error() {
        assert!(matches!(parse_manifest("{"), Err(SyncError::Protocol(_))));
    }

    #[test]
    fn mut_and_vault_body_parsing() {
        assert_eq!(parse_mut_body(r#"{"rev":9,"hash":"x"}"#).unwrap(), (9, "x".to_string()));
        assert_eq!(parse_mut_body(r#"{"rev":3}"#).unwrap(), (3, String::new()));
        assert_eq!(
            parse_vault_body(r#"{"vaultId":"abc123def456","rev":0}"#).unwrap(),
            ("abc123def456".to_string(), 0)
        );
    }

    #[test]
    fn new_rejects_bad_code() {
        assert!(matches!(
            SyncClient::new(DEFAULT_BASE_URL_TEST, "bad"),
            Err(SyncError::BadCode)
        ));
        // Валидный код — клиент создаётся.
        assert!(SyncClient::new(DEFAULT_BASE_URL_TEST, "GRPH-23456-789AB-CDEFG-HJKMN").is_ok());
    }

    const DEFAULT_BASE_URL_TEST: &str = "https://example.invalid/graphite-sync";
}
