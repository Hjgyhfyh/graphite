//! История отправленных промтов: `.graphite/prompts/YYYY-MM.jsonl`, одна
//! JSON-строка на запись (зеркало журнала операций). Каталог служебный —
//! индексер и watcher игнорируют точечные папки, синк её не трогает, поэтому
//! история локальна для устройства, как и история версий.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::commands::lock_core;
use crate::dto::{GraphiteError, GraphiteErrorCode};

/// Кап на сохраняемый текст промта: брифы бывают на сотни тысяч знаков,
/// но месячный файл не должен разрастаться безгранично.
const TEXT_CAP: usize = 300_000;
const LIST_LIMIT_DEFAULT: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptLogEntry {
    pub id: String,
    /// ISO 8601 UTC, назначается при записи.
    pub ts: String,
    /// Откуда отправлено: copyPage | bundle | prompt | brief.
    pub source: String,
    pub title: String,
    /// Длина исходного текста в знаках (до капа).
    pub chars: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
    pub text: String,
}

/// Строка списка — без текста, чтобы листание истории не тянуло мегабайты.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptLogMeta {
    pub id: String,
    pub ts: String,
    pub source: String,
    pub title: String,
    pub chars: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptLogAppendParams {
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub refs: Vec<String>,
    pub text: String,
}

fn prompt_err(code: GraphiteErrorCode, msg: impl Into<String>) -> GraphiteError {
    GraphiteError {
        code,
        message: msg.into(),
        hint: None,
        data: None,
    }
}

fn vault_root() -> Result<PathBuf, GraphiteError> {
    lock_core()
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(|| prompt_err(GraphiteErrorCode::Unavailable, "Хранилище не открыто"))
}

fn prompts_dir(root: &Path) -> PathBuf {
    root.join(".graphite").join("prompts")
}

/// Месячные файлы истории, новые первыми.
fn month_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() == "YYYY-MM.jsonl".len() && n.ends_with(".jsonl"))
        .collect();
    names.sort();
    names.reverse();
    names.into_iter().map(|n| dir.join(n)).collect()
}

fn truncate_on_char_boundary(text: &str, cap: usize) -> &str {
    if text.len() <= cap {
        return text;
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[tauri::command(async)]
#[specta::specta]
pub fn prompt_log_append(params: PromptLogAppendParams) -> Result<PromptLogMeta, GraphiteError> {
    let root = vault_root()?;
    let ts = history::journal::now_ts();
    let entry = PromptLogEntry {
        id: ulid::Ulid::new().to_string(),
        ts: ts.clone(),
        source: params.source,
        title: params.title.trim().to_string(),
        chars: params.text.chars().count() as u32,
        refs: params.refs,
        text: truncate_on_char_boundary(&params.text, TEXT_CAP).to_string(),
    };
    let dir = prompts_dir(&root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| prompt_err(GraphiteErrorCode::Unavailable, format!("prompts dir: {e}")))?;
    let mut line = serde_json::to_string(&entry)
        .map_err(|e| prompt_err(GraphiteErrorCode::Validation, format!("serialize: {e}")))?;
    line.push('\n');
    let path = dir.join(format!("{}.jsonl", &ts[0..7]));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| prompt_err(GraphiteErrorCode::Unavailable, format!("prompts open: {e}")))?;
    file.write_all(line.as_bytes())
        .and_then(|()| file.sync_data())
        .map_err(|e| prompt_err(GraphiteErrorCode::Unavailable, format!("prompts write: {e}")))?;
    Ok(PromptLogMeta {
        id: entry.id,
        ts: entry.ts,
        source: entry.source,
        title: entry.title,
        chars: entry.chars,
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn prompt_log_list(limit: Option<u32>) -> Result<Vec<PromptLogMeta>, GraphiteError> {
    let root = vault_root()?;
    let limit = limit.unwrap_or(LIST_LIMIT_DEFAULT) as usize;
    let mut out: Vec<PromptLogMeta> = Vec::new();
    for path in month_files(&prompts_dir(&root)) {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Внутри файла записи хронологические — читаем с конца, новые первыми.
        for line in content.lines().rev() {
            if out.len() >= limit {
                return Ok(out);
            }
            let Ok(entry) = serde_json::from_str::<PromptLogEntry>(line) else {
                continue;
            };
            out.push(PromptLogMeta {
                id: entry.id,
                ts: entry.ts,
                source: entry.source,
                title: entry.title,
                chars: entry.chars,
            });
        }
    }
    Ok(out)
}

#[tauri::command(async)]
#[specta::specta]
pub fn prompt_log_get(id: String) -> Result<PromptLogEntry, GraphiteError> {
    let root = vault_root()?;
    for path in month_files(&prompts_dir(&root)) {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines().rev() {
            let Ok(entry) = serde_json::from_str::<PromptLogEntry>(line) else {
                continue;
            };
            if entry.id == id {
                return Ok(entry);
            }
        }
    }
    Err(prompt_err(GraphiteErrorCode::NotFound, "Промт не найден в истории"))
}
