//! Git-версионирование хранилища: тонкая обёртка над системным git (шелл-аут),
//! рабочая директория — корень смонтированного vault. Ни git2, ни новых крейтов —
//! только std::process::Command. Аутентификация push/pull делегируется git
//! (URL с токеном или Windows Credential Manager); своих токенов не храним и не
//! логируем.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::commands::lock_core;
use crate::dto::*;

/// Доменная ошибка git-модуля: код + сообщение (без hint/data).
fn git_err(code: GraphiteErrorCode, msg: impl Into<String>) -> GraphiteError {
    GraphiteError {
        code,
        message: msg.into(),
        hint: None,
        data: None,
    }
}

/// Корень смонтированного хранилища — рабочая директория для всех вызовов git.
fn vault_root() -> Result<PathBuf, GraphiteError> {
    lock_core()
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(|| git_err(GraphiteErrorCode::Unavailable, "Хранилище не открыто"))
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: git — консольная программа, без флага в GUI-приложении на
    // каждый вызов мигало бы окно консоли.
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// Базовая команда git в корне хранилища. `-c core.quotepath=false` — чтобы
/// юникод-пути (кириллица) выводились как есть, а не в \NNN-экранировании.
fn base_cmd(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    cmd.current_dir(root);
    cmd.stdin(Stdio::null());
    hide_console(&mut cmd);
    cmd
}

/// Запуск git с захватом вывода. Ошибка запуска (git не в PATH) отличается от
/// ненулевого кода возврата: первая приходит как io-ошибка вызывающему.
fn run(root: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    base_cmd(root).args(args).output()
}

/// Прогоняет git и требует нулевой код возврата; stdout как UTF-8. Ненулевой
/// код — доменная ошибка с текстом stderr.
fn git_out(root: &Path, args: &[&str]) -> Result<String, GraphiteError> {
    let out = run(root, args)
        .map_err(|e| git_err(GraphiteErrorCode::Unavailable, format!("не удалось запустить git: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "git завершился с ошибкой".to_string()
        } else {
            stderr
        };
        return Err(git_err(GraphiteErrorCode::Unavailable, msg));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Прогоняет git; при ошибке запуска или ненулевом коде — None. Для
/// необязательных запросов (upstream, remote, HEAD в свежем репозитории).
fn git_soft(root: &Path, args: &[&str]) -> Option<String> {
    let out = run(root, args).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Проверяет, что строка — git-хэш (hex, 4..=64 символа): защита от подстановки
/// опций/ревизий в аргументы git.
fn sanitize_rev(hash: &str) -> Result<String, GraphiteError> {
    let h = hash.trim();
    if (4..=64).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(h.to_string())
    } else {
        Err(git_err(GraphiteErrorCode::Validation, "некорректный идентификатор коммита"))
    }
}

/// Короткий хэш для (возможно полного) идентификатора; фолбэк — первые 7 символов.
fn short_hash(root: &Path, hash: &str) -> String {
    git_soft(root, &["rev-parse", "--short", hash])
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| hash.chars().take(7).collect())
}

/// Метка снимка по умолчанию: «ГГГГ-ММ-ДД ЧЧ:ММ». Штамп в UTC, как и прочие
/// временные метки хранилища; реальное время коммита git пишет в локальной зоне.
fn snapshot_stamp() -> String {
    vault_core::writer::now_iso_utc()
        .chars()
        .take(16)
        .map(|c| if c == 'T' { ' ' } else { c })
        .collect()
}

/// Усекает строку до предела в байтах по границе символа (валидный UTF-8).
fn truncate_bytes(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n…(усечено)");
    s
}

/// Парсит вывод `rev-list --left-right --count @{u}...HEAD`: левое число —
/// отставание (behind, коммиты upstream), правое — опережение (ahead, свои).
fn parse_ahead_behind(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split_whitespace();
    let behind: u32 = it.next()?.parse().ok()?;
    let ahead: u32 = it.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Парсит `log -1 --format=%H%n%h%n%s%n%cI` в краткое описание коммита.
fn parse_commit_brief(s: &str) -> Option<GitCommitBrief> {
    let mut lines = s.lines();
    let hash = lines.next()?.trim().to_string();
    if hash.is_empty() {
        return None;
    }
    Some(GitCommitBrief {
        hash,
        short_hash: lines.next().unwrap_or("").trim().to_string(),
        subject: lines.next().unwrap_or("").to_string(),
        date: lines.next().unwrap_or("").trim().to_string(),
    })
}

/// Разбирает `log --numstat` с RS/US-разделителями. 0x1E разделяет коммиты, 0x1F —
/// поля: это управляющие символы, не встречающиеся в теме/имени/пути, поэтому
/// парсинг без экранирования. filesChanged = число строк numstat после метаданных.
fn parse_log(raw: &str) -> Vec<GitCommit> {
    let mut out = Vec::new();
    for chunk in raw.split('\u{1e}') {
        let chunk = chunk.trim_start_matches(['\n', '\r']);
        if chunk.is_empty() {
            continue;
        }
        let mut lines = chunk.lines();
        let Some(meta) = lines.next() else { continue };
        let mut f = meta.split('\u{1f}');
        let hash = f.next().unwrap_or("").trim().to_string();
        if hash.is_empty() {
            continue;
        }
        let short_hash = f.next().unwrap_or("").to_string();
        let subject = f.next().unwrap_or("").to_string();
        let author = f.next().unwrap_or("").to_string();
        let date = f.next().unwrap_or("").trim().to_string();
        let files_changed = lines.filter(|l| !l.trim().is_empty()).count() as u32;
        out.push(GitCommit {
            hash,
            short_hash,
            subject,
            author,
            date,
            files_changed,
        });
    }
    out
}

/// Нормализует код `--name-status` (A/M/D/R/C/T, возможно с числом сходства,
/// напр. R100) к контрактному набору "A"|"M"|"D"|"R".
fn normalize_status(code: &str) -> &'static str {
    match code.chars().next() {
        Some('A') => "A",
        Some('D') => "D",
        Some('R') => "R",
        Some('C') => "A",
        _ => "M",
    }
}

/// Разбирает `show --name-status --format=`: строки «код<TAB>путь», для
/// переименования путь назначения — последний столбец.
fn parse_name_status(raw: &str) -> Vec<GitFileChange> {
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let code = code.trim();
        if code.is_empty() {
            continue;
        }
        let status = normalize_status(code);
        let path = if status == "R" {
            parts.last().unwrap_or("").to_string()
        } else {
            parts.next().unwrap_or("").to_string()
        };
        if path.is_empty() {
            continue;
        }
        out.push(GitFileChange {
            path,
            status: status.to_string(),
        });
    }
    out
}

/// Собранный вывод процесса с таймаутом (пайпы уже прочитаны в строки).
struct TimedOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Читает пайп полностью в строку (потерянные при не-UTF8 байты заменяются).
fn read_pipe<R: Read>(pipe: Option<R>) -> String {
    let mut buf = Vec::new();
    if let Some(mut p) = pipe {
        let _ = p.read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// Запуск git с ограничением по времени: сетевые операции (push/pull) не должны
/// висеть вечно при недоступном узле. Пайпы дренируются в отдельных потоках,
/// иначе объёмный прогресс переполнит буфер и заблокирует процесс. По истечении
/// таймаута процесс убивается.
fn run_timed(root: &Path, args: &[&str], timeout: Duration) -> Result<TimedOutput, GraphiteError> {
    let mut cmd = base_cmd(root);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| git_err(GraphiteErrorCode::Unavailable, format!("не удалось запустить git: {e}")))?;
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_h = std::thread::spawn(move || read_pipe(out_pipe));
    let err_h = std::thread::spawn(move || read_pipe(err_pipe));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(git_err(
                        GraphiteErrorCode::Unavailable,
                        "операция git превысила время ожидания",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(git_err(GraphiteErrorCode::Unavailable, format!("ошибка ожидания git: {e}")));
            }
        }
    };
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    Ok(TimedOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

/// Собирает результат сетевой операции: ok по коду возврата, message — вывод git
/// (stdout+stderr, усечён). Токены/креды git в вывод не печатает, сообщение
/// безопасно показать пользователю.
fn action_from_output(out: TimedOutput, ok_note: &str) -> GitActionResult {
    let mut msg = String::new();
    let stdout = out.stdout.trim();
    let stderr = out.stderr.trim();
    if !stdout.is_empty() {
        msg.push_str(stdout);
    }
    if !stderr.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(stderr);
    }
    if out.success && msg.is_empty() {
        msg = ok_note.to_string();
    }
    GitActionResult {
        ok: out.success,
        message: truncate_bytes(msg, 8 * 1024),
    }
}

/// Пустой статус: git не установлен или каталог не является репозиторием.
fn empty_status(installed: bool, is_repo: bool) -> GitStatus {
    GitStatus {
        installed,
        is_repo,
        branch: None,
        changed_files: 0,
        ahead: 0,
        behind: 0,
        has_remote: false,
        remote_url: None,
        last_commit: None,
    }
}

/// Гарантирует user.name/user.email в локальной конфигурации репозитория: без
/// них git commit падает. Значения по умолчанию — служебные.
fn ensure_identity(root: &Path) -> Result<(), GraphiteError> {
    if git_soft(root, &["config", "user.name"]).filter(|s| !s.is_empty()).is_none() {
        git_out(root, &["config", "user.name", "Graphite"])?;
    }
    if git_soft(root, &["config", "user.email"]).filter(|s| !s.is_empty()).is_none() {
        git_out(root, &["config", "user.email", "graphite@local"])?;
    }
    Ok(())
}

/// Дописывает служебные пути в .gitignore корня, не затирая пользовательские
/// строки: добавляются только отсутствующие записи.
fn append_gitignore(root: &Path) -> Result<(), GraphiteError> {
    let path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let have: std::collections::HashSet<&str> = existing.lines().map(|l| l.trim()).collect();
    let wanted = [".graphite/", "index.db", "index.db-wal", "index.db-shm"];
    let missing: Vec<&str> = wanted.into_iter().filter(|w| !have.contains(*w)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for line in missing {
        out.push_str(line);
        out.push('\n');
    }
    std::fs::write(&path, out)
        .map_err(|e| git_err(GraphiteErrorCode::Unavailable, format!("не удалось записать .gitignore: {e}")))
}

#[tauri::command]
#[specta::specta]
pub fn git_status() -> Result<GitStatus, GraphiteError> {
    let root = vault_root()?;
    let installed = run(&root, &["--version"]).map(|o| o.status.success()).unwrap_or(false);
    if !installed {
        return Ok(empty_status(false, false));
    }
    let is_repo = git_soft(&root, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
    if !is_repo {
        return Ok(empty_status(true, false));
    }
    let changed_files = git_soft(&root, &["status", "--porcelain"])
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);
    let branch = git_soft(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty());
    // ahead/behind считаем только при настроенном upstream (@{u}); иначе 0/0.
    let (ahead, behind) = git_soft(&root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .and_then(|s| parse_ahead_behind(&s))
        .unwrap_or((0, 0));
    let remote_url = git_soft(&root, &["remote", "get-url", "origin"]).filter(|u| !u.is_empty());
    let has_remote = remote_url.is_some();
    let last_commit =
        git_soft(&root, &["log", "-1", "--format=%H%n%h%n%s%n%cI"]).and_then(|s| parse_commit_brief(&s));
    Ok(GitStatus {
        installed: true,
        is_repo: true,
        branch,
        changed_files,
        ahead,
        behind,
        has_remote,
        remote_url,
        last_commit,
    })
}

#[tauri::command]
#[specta::specta]
pub fn git_init() -> Result<GitStatus, GraphiteError> {
    let root = vault_root()?;
    git_out(&root, &["init"])?;
    ensure_identity(&root)?;
    append_gitignore(&root)?;
    git_out(&root, &["add", "-A"])?;
    git_out(&root, &["commit", "-m", "Первый снимок хранилища"])?;
    git_status()
}

#[tauri::command]
#[specta::specta]
pub fn git_snapshot(message: Option<String>) -> Result<GitActionResult, GraphiteError> {
    let root = vault_root()?;
    git_out(&root, &["add", "-A"])?;
    let dirty = git_soft(&root, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return Ok(GitActionResult {
            ok: false,
            message: "Нет изменений для снимка".to_string(),
        });
    }
    let msg = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("Снимок {}", snapshot_stamp()));
    git_out(&root, &["commit", "-m", &msg])?;
    Ok(GitActionResult { ok: true, message: msg })
}

#[tauri::command]
#[specta::specta]
pub fn git_log(limit: Option<u32>) -> Result<Vec<GitCommit>, GraphiteError> {
    let root = vault_root()?;
    // Пустой репозиторий (нет ни одного коммита) — не ошибка, а пустой список.
    if git_soft(&root, &["rev-parse", "--verify", "HEAD"]).is_none() {
        return Ok(Vec::new());
    }
    let n = limit.unwrap_or(100).max(1);
    let max = format!("--max-count={n}");
    let raw = git_out(
        &root,
        &["log", &max, "--numstat", "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%cI"],
    )?;
    Ok(parse_log(&raw))
}

#[tauri::command]
#[specta::specta]
pub fn git_commit_files(hash: String) -> Result<Vec<GitFileChange>, GraphiteError> {
    let root = vault_root()?;
    let h = sanitize_rev(&hash)?;
    let raw = git_out(&root, &["show", "--name-status", "--format=", &h])?;
    Ok(parse_name_status(&raw))
}

#[tauri::command]
#[specta::specta]
pub fn git_diff(params: GitDiffParams) -> Result<String, GraphiteError> {
    let root = vault_root()?;
    let h = sanitize_rev(&params.hash)?;
    let mut args: Vec<String> = vec!["show".to_string(), h];
    // Путь после `--` — не может быть истолкован как опция.
    if let Some(path) = params.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = git_out(&root, &refs)?;
    Ok(truncate_bytes(raw, 200 * 1024))
}

#[tauri::command]
#[specta::specta]
pub fn git_restore_commit(hash: String) -> Result<GitActionResult, GraphiteError> {
    let root = vault_root()?;
    let h = sanitize_rev(&hash)?;
    // Неразрушительно: переносим состояние коммита в рабочее дерево и фиксируем
    // новым коммитом — история не переписывается.
    git_out(&root, &["checkout", &h, "--", "."])?;
    git_out(&root, &["add", "-A"])?;
    let dirty = git_soft(&root, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return Ok(GitActionResult {
            ok: false,
            message: "Уже в этом состоянии".to_string(),
        });
    }
    let msg = format!("Восстановление к {}", short_hash(&root, &h));
    git_out(&root, &["commit", "-m", &msg])?;
    Ok(GitActionResult { ok: true, message: msg })
}

#[tauri::command]
#[specta::specta]
pub fn git_restore_file(params: GitRestoreFileParams) -> Result<GitActionResult, GraphiteError> {
    let root = vault_root()?;
    let h = sanitize_rev(&params.hash)?;
    let path = params.path.trim();
    if path.is_empty() {
        return Err(git_err(GraphiteErrorCode::Validation, "не передан путь файла"));
    }
    git_out(&root, &["checkout", &h, "--", path])?;
    git_out(&root, &["add", "-A"])?;
    let dirty = git_soft(&root, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return Ok(GitActionResult {
            ok: false,
            message: "Уже в этом состоянии".to_string(),
        });
    }
    let msg = format!("Восстановлен файл {path}");
    git_out(&root, &["commit", "-m", &msg])?;
    Ok(GitActionResult { ok: true, message: msg })
}

#[tauri::command]
#[specta::specta]
pub fn git_remote_set(url: String) -> Result<GitStatus, GraphiteError> {
    let root = vault_root()?;
    let url = url.trim();
    let has_origin = git_soft(&root, &["remote", "get-url", "origin"]).is_some();
    if url.is_empty() {
        if has_origin {
            git_out(&root, &["remote", "remove", "origin"])?;
        }
    } else {
        if url.starts_with('-') {
            return Err(git_err(GraphiteErrorCode::Validation, "недопустимый URL"));
        }
        if has_origin {
            git_out(&root, &["remote", "set-url", "origin", url])?;
        } else {
            git_out(&root, &["remote", "add", "origin", url])?;
        }
    }
    git_status()
}

#[tauri::command]
#[specta::specta]
pub fn git_push() -> Result<GitActionResult, GraphiteError> {
    let root = vault_root()?;
    let out = run_timed(&root, &["push", "-u", "origin", "HEAD"], Duration::from_secs(60))?;
    Ok(action_from_output(out, "Отправлено в удалённый репозиторий"))
}

#[tauri::command]
#[specta::specta]
pub fn git_pull() -> Result<GitActionResult, GraphiteError> {
    let root = vault_root()?;
    let out = run_timed(&root, &["pull", "--ff-only", "origin"], Duration::from_secs(60))?;
    Ok(action_from_output(out, "Обновлено из удалённого репозитория"))
}
