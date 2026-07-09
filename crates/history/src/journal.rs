//! Append-only журнал операций (SPEC §6.8): `.graphite/journal/YYYY-MM.jsonl`,
//! одна JSON-строка на операцию (`JournalOp` из `rpc::types`, сериализация CONTRACT §1.1).
//! Чтение — в обратном хронологическом порядке: месячные файлы от новых к старым,
//! каждый файл — блоками с конца.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rpc::types::limits::ACTIVITY_LIMIT_DEFAULT;
use rpc::types::{ActivityEvent, ActivityGetParams, ActivityGetResponse, ActorFilter, NoteRef};

use crate::error::HistoryError;
use crate::model::{Actor, JournalOp};

const CHUNK: usize = 64 * 1024;
const MONTH_SKIP_MARGIN_MS: i64 = 86_400_000;
const PATH_REF_PREFIX: &str = "path:";
const ID_REF_PREFIX: &str = "id:";

/// Фильтры чтения журнала (`activity_get` / `journal_list`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JournalFilter {
    /// ISO 8601 (`2026-07-01T00:00:00Z`, дата `2026-07-01`) или относительная
    /// форма `-7d` / `-24h` / `-30m` / `-1w` от текущего момента.
    pub since: Option<String>,
    /// Префикс пути от корня vault (`Проекты` или `path:Проекты`);
    /// операция проходит, если затрагивает хотя бы один файл внутри префикса.
    pub scope: Option<String>,
    pub actor: Option<Actor>,
    /// Максимум записей, default 100 (CONTRACT §1.5).
    pub limit: Option<u32>,
}

/// Новый `op_id`: ULID, 26 символов Crockford base32.
pub fn new_op_id() -> String {
    ulid::Ulid::new().to_string()
}

/// Текущий момент в ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn now_ts() -> String {
    format_ts_ms(now_ms())
}

/// Дописывает операцию в месячный файл, выбранный по `op.ts`.
pub fn append_op(journal_dir: &Path, op: &JournalOp) -> Result<(), HistoryError> {
    if parse_ts_ms(&op.ts).is_none() {
        return Err(HistoryError::Invalid(format!("bad op ts: {}", op.ts)));
    }
    let month = &op.ts.trim()[0..7];
    std::fs::create_dir_all(journal_dir)?;
    let path = journal_dir.join(format!("{month}.jsonl"));
    let mut line = serde_json::to_string(op)
        .map_err(|e| HistoryError::Invalid(format!("op serialize: {e}")))?;
    line.push('\n');
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    file.write_all(line.as_bytes())?;
    file.sync_data()?;
    Ok(())
}

/// Читает операции по фильтрам, новые первыми. Нечитаемые строки
/// (обрыв записи, чужой мусор) пропускаются.
pub fn read_ops(journal_dir: &Path, filter: &JournalFilter) -> Result<Vec<JournalOp>, HistoryError> {
    let limit = filter.limit.unwrap_or(ACTIVITY_LIMIT_DEFAULT) as usize;
    let mut out = Vec::new();
    if limit == 0 {
        return Ok(out);
    }
    let since_ms = match &filter.since {
        Some(s) => Some(resolve_since(s)?),
        None => None,
    };
    let scope = filter.scope.as_deref().and_then(normalize_scope);
    let actor = filter.actor;
    scan_ops(journal_dir, since_ms, |op| {
        if op_matches(&op, since_ms, scope.as_deref(), actor) {
            out.push(op);
            if out.len() >= limit {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    })?;
    Ok(out)
}

/// Находит операцию по `op_id`.
pub fn read_op(journal_dir: &Path, op_id: &str) -> Result<JournalOp, HistoryError> {
    let mut found = None;
    scan_ops(journal_dir, None, |op| {
        if op.op_id == op_id {
            found = Some(op);
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    found.ok_or_else(|| HistoryError::NotFound(format!("journal op {op_id}")))
}

/// Последний известный `after`-хэш файла по журналу (`blake3:<64hex>`): свежайшая
/// операция, затронувшая ровно этот путь, и её состояние файла после мутации.
/// Используется как `before`-хэш при фиксации внешней правки — так undo такой
/// правки находит своё исходное содержимое в объектном хранилище. Нет записей по
/// пути или последняя оставила файл отсутствующим (`after: None`) → `None`.
pub fn last_after_for_path(journal_dir: &Path, path: &str) -> Option<String> {
    let mut found = None;
    let _ = scan_ops(journal_dir, None, |op| {
        if let Some(change) = op.files.iter().find(|c| c.path == path) {
            found = change.after.clone();
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    found
}

/// Все операции сессии, новые первыми.
pub fn read_session_ops(journal_dir: &Path, session: &str) -> Result<Vec<JournalOp>, HistoryError> {
    let mut out = Vec::new();
    scan_ops(journal_dir, None, |op| {
        if op.session.as_deref() == Some(session) {
            out.push(op);
        }
        ControlFlow::Continue(())
    })?;
    Ok(out)
}

/// Проставляет флаг `undone` записи журнала (единственная разрешённая правка
/// задним числом: строка переписывается на месте, соседние строки — байт в байт).
/// Возвращает обновлённую запись; совпадающий флаг — no-op.
pub fn mark_undone(
    journal_dir: &Path,
    op_id: &str,
    undone: bool,
) -> Result<JournalOp, HistoryError> {
    for (_, path) in month_files_desc(journal_dir)? {
        let content = std::fs::read_to_string(&path)?;
        let mut updated: Option<JournalOp> = None;
        let mut rebuilt = String::with_capacity(content.len() + 8);
        for piece in content.split_inclusive('\n') {
            if updated.is_none() {
                let trimmed = piece.trim_end_matches(['\n', '\r']).trim();
                if !trimmed.is_empty() {
                    if let Ok(mut op) = serde_json::from_str::<JournalOp>(trimmed) {
                        if op.op_id == op_id {
                            if op.undone == undone {
                                return Ok(op);
                            }
                            op.undone = undone;
                            let line = serde_json::to_string(&op).map_err(|e| {
                                HistoryError::Invalid(format!("op serialize: {e}"))
                            })?;
                            rebuilt.push_str(&line);
                            rebuilt.push('\n');
                            updated = Some(op);
                            continue;
                        }
                    }
                }
            }
            rebuilt.push_str(piece);
        }
        if let Some(op) = updated {
            write_atomic(&path, rebuilt.as_bytes())?;
            return Ok(op);
        }
    }
    Err(HistoryError::NotFound(format!("journal op {op_id}")))
}

/// `activity_get` (CONTRACT §3.1): журнал → события.
/// `scope` принимается только в path-форме; id-форму резолвит ядро до вызова.
pub fn activity(
    journal_dir: &Path,
    params: &ActivityGetParams,
) -> Result<ActivityGetResponse, HistoryError> {
    let ops = read_ops(journal_dir, &filter_from_params(params)?)?;
    let events = ops
        .into_iter()
        .map(|op| ActivityEvent {
            ts: op.ts,
            actor: op.actor,
            tool: op.tool,
            summary: op.summary,
            refs: op
                .files
                .into_iter()
                .map(|f| NoteRef(format!("{PATH_REF_PREFIX}{}", f.path)))
                .collect(),
        })
        .collect();
    Ok(ActivityGetResponse { events })
}

/// `journal_list` (CONTRACT §5): те же фильтры, но записи целиком.
pub fn list(
    journal_dir: &Path,
    params: &ActivityGetParams,
) -> Result<Vec<JournalOp>, HistoryError> {
    read_ops(journal_dir, &filter_from_params(params)?)
}

fn filter_from_params(params: &ActivityGetParams) -> Result<JournalFilter, HistoryError> {
    let scope = match &params.scope {
        None => None,
        Some(r) => {
            let raw = r.0.as_str();
            if raw.starts_with(ID_REF_PREFIX) {
                return Err(HistoryError::Invalid(
                    "activity scope: id-ref must be resolved to a path by the caller".into(),
                ));
            }
            Some(raw.strip_prefix(PATH_REF_PREFIX).unwrap_or(raw).to_string())
        }
    };
    let actor = params.actor.and_then(|a| match a {
        ActorFilter::All => None,
        ActorFilter::User => Some(Actor::User),
        ActorFilter::Assistant => Some(Actor::Assistant),
        ActorFilter::External => Some(Actor::External),
    });
    Ok(JournalFilter {
        since: Some(params.since.clone()),
        scope,
        actor,
        limit: params.limit,
    })
}

fn op_matches(
    op: &JournalOp,
    since_ms: Option<i64>,
    scope: Option<&str>,
    actor: Option<Actor>,
) -> bool {
    if let Some(a) = actor {
        if op.actor != a {
            return false;
        }
    }
    if let Some(since) = since_ms {
        match parse_ts_ms(&op.ts) {
            Some(ts) if ts >= since => {}
            _ => return false,
        }
    }
    if let Some(prefix) = scope {
        if !op.files.iter().any(|f| path_in_scope(&f.path, prefix)) {
            return false;
        }
    }
    true
}

fn normalize_scope(scope: &str) -> Option<String> {
    let s = scope.strip_prefix(PATH_REF_PREFIX).unwrap_or(scope);
    let s = s.trim().trim_end_matches('/');
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn path_in_scope(path: &str, scope: &str) -> bool {
    path == scope
        || path
            .strip_prefix(scope)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn scan_ops<F>(journal_dir: &Path, since_ms: Option<i64>, mut visit: F) -> Result<(), HistoryError>
where
    F: FnMut(JournalOp) -> ControlFlow<()>,
{
    for (month, path) in month_files_desc(journal_dir)? {
        if let (Some(since), Some(month_end)) = (since_ms, month_end_ms(&month)) {
            if month_end + MONTH_SKIP_MARGIN_MS < since {
                break;
            }
        }
        for line in RevLines::new(&path)? {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(op) = serde_json::from_str::<JournalOp>(trimmed) else {
                continue;
            };
            if let ControlFlow::Break(()) = visit(op) {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn month_files_desc(journal_dir: &Path) -> Result<Vec<(String, PathBuf)>, HistoryError> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(journal_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(month) = month_key(&name) {
            files.push((month.to_string(), entry.path()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files)
}

fn month_key(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(".jsonl")?;
    let b = stem.as_bytes();
    if b.len() != 7
        || b[4] != b'-'
        || !b[0..4].iter().all(u8::is_ascii_digit)
        || !b[5..7].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let month: u32 = stem[5..7].parse().ok()?;
    if (1..=12).contains(&month) {
        Some(stem)
    } else {
        None
    }
}

fn month_end_ms(month: &str) -> Option<i64> {
    let year: i64 = month[0..4].parse().ok()?;
    let m: i64 = month[5..7].parse().ok()?;
    let (next_year, next_month) = if m == 12 { (year + 1, 1) } else { (year, m + 1) };
    Some(days_from_civil(next_year, next_month, 1) * 86_400_000)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), HistoryError> {
    let dir = path
        .parent()
        .ok_or_else(|| HistoryError::Invalid(format!("no parent dir: {}", path.display())))?;
    let tmp = dir.join(format!(".tmp-{}", ulid::Ulid::new()));
    let written = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_data()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(HistoryError::from)
}

struct RevLines {
    file: File,
    pos: u64,
    carry: Vec<u8>,
    ready: Vec<Vec<u8>>,
    finished: bool,
}

impl RevLines {
    fn new(path: &Path) -> Result<Self, HistoryError> {
        let file = File::open(path)?;
        let pos = file.metadata()?.len();
        Ok(Self {
            file,
            pos,
            carry: Vec::new(),
            ready: Vec::new(),
            finished: false,
        })
    }

    fn load(&mut self) -> std::io::Result<()> {
        while self.ready.is_empty() && !self.finished {
            if self.pos == 0 {
                self.finished = true;
                if !self.carry.is_empty() {
                    let line = std::mem::take(&mut self.carry);
                    self.ready.push(line);
                }
                break;
            }
            let take = CHUNK.min(self.pos as usize);
            self.pos -= take as u64;
            self.file.seek(SeekFrom::Start(self.pos))?;
            let mut buf = vec![0u8; take];
            self.file.read_exact(&mut buf)?;
            buf.append(&mut self.carry);
            let mut parts = buf.split(|b| *b == b'\n');
            self.carry = parts.next().unwrap_or_default().to_vec();
            self.ready = parts.map(<[u8]>::to_vec).collect();
        }
        Ok(())
    }
}

impl Iterator for RevLines {
    type Item = Result<String, HistoryError>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(mut line) = self.ready.pop() {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                match String::from_utf8(line) {
                    Ok(s) => return Some(Ok(s)),
                    Err(_) => continue,
                }
            }
            if self.finished {
                return None;
            }
            if let Err(e) = self.load() {
                self.finished = true;
                return Some(Err(e.into()));
            }
        }
    }
}

fn resolve_since(since: &str) -> Result<i64, HistoryError> {
    let s = since.trim();
    if let Some(relative) = s.strip_prefix('-') {
        let (amount, unit) = relative.split_at(relative.len().saturating_sub(1));
        let n: i64 = amount
            .parse()
            .map_err(|_| HistoryError::Invalid(format!("bad since: {since}")))?;
        let unit_ms: i64 = match unit {
            "m" => 60_000,
            "h" => 3_600_000,
            "d" => 86_400_000,
            "w" => 604_800_000,
            _ => return Err(HistoryError::Invalid(format!("bad since: {since}"))),
        };
        let delta = n
            .checked_mul(unit_ms)
            .ok_or_else(|| HistoryError::Invalid(format!("bad since: {since}")))?;
        return Ok(now_ms() - delta);
    }
    parse_ts_ms(s).ok_or_else(|| HistoryError::Invalid(format!("bad since: {since}")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_num(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut value: i64 = 0;
    for &b in bytes {
        value = value * 10 + i64::from(b - b'0');
    }
    Some(value)
}

/// ISO 8601 → epoch ms. Понимает `YYYY-MM-DD`, `…THH:MM[:SS[.fff]]`,
/// оффсеты `Z` / `±HH:MM` / `±HHMM` / `±HH`; без оффсета — UTC.
fn parse_ts_ms(ts: &str) -> Option<i64> {
    let b = ts.trim().as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = parse_num(&b[0..4])?;
    let month = parse_num(&b[5..7])?;
    let day = parse_num(&b[8..10])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut hour = 0;
    let mut minute = 0;
    let mut second = 0;
    let mut frac_ms = 0;
    let mut offset_min = 0;
    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        let mut i = 11;
        hour = parse_num(b.get(i..i + 2)?)?;
        if b.get(i + 2) != Some(&b':') {
            return None;
        }
        minute = parse_num(b.get(i + 3..i + 5)?)?;
        i += 5;
        if b.get(i) == Some(&b':') {
            second = parse_num(b.get(i + 1..i + 3)?)?;
            i += 3;
        }
        if matches!(b.get(i), Some(&b'.') | Some(&b',')) {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return None;
            }
            let digits = &b[start..i.min(start + 3)];
            let mut value = parse_num(digits)?;
            for _ in digits.len()..3 {
                value *= 10;
            }
            frac_ms = value;
        }
        match b.get(i) {
            None => {}
            Some(b'Z') | Some(b'z') => {
                if i + 1 != b.len() {
                    return None;
                }
            }
            Some(&sign) if sign == b'+' || sign == b'-' => {
                i += 1;
                let off_h = parse_num(b.get(i..i + 2)?)?;
                i += 2;
                if b.get(i) == Some(&b':') {
                    i += 1;
                }
                let off_m = if i < b.len() {
                    let v = parse_num(b.get(i..i + 2)?)?;
                    i += 2;
                    v
                } else {
                    0
                };
                if i != b.len() || off_h > 14 || off_m > 59 {
                    return None;
                }
                offset_min = off_h * 60 + off_m;
                if sign == b'-' {
                    offset_min = -offset_min;
                }
            }
            _ => return None,
        }
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
    }
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60) * 1_000 + frac_ms)
}

fn format_ts_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let secs = rem / 1_000;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3_600,
        (secs / 60) % 60,
        secs % 60,
        rem % 1_000
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { y + 1 } else { y }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_variants() {
        assert_eq!(parse_ts_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts_ms("1970-01-01"), Some(0));
        assert_eq!(parse_ts_ms("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(
            parse_ts_ms("2026-07-03T14:02:11+03:00"),
            parse_ts_ms("2026-07-03T11:02:11Z")
        );
        assert_eq!(
            parse_ts_ms("2026-07-03T14:02:11+0300"),
            parse_ts_ms("2026-07-03T11:02:11Z")
        );
        assert_eq!(
            parse_ts_ms("2026-07-03T14:02:11-05"),
            parse_ts_ms("2026-07-03T19:02:11Z")
        );
        assert_eq!(
            parse_ts_ms("2026-07-03T14:02:11.250Z"),
            parse_ts_ms("2026-07-03T14:02:11Z").map(|v| v + 250)
        );
        assert_eq!(
            parse_ts_ms("2026-07-03T14:02"),
            parse_ts_ms("2026-07-03T14:02:00Z")
        );
        assert_eq!(parse_ts_ms("2026-13-01"), None);
        assert_eq!(parse_ts_ms("garbage"), None);
        assert_eq!(parse_ts_ms("2026-07-03T14:02:11+25:00"), None);
    }

    #[test]
    fn formats_round_trip() {
        for ts in [
            "2026-07-03T11:02:11.000Z",
            "1999-12-31T23:59:59.999Z",
            "2000-02-29T00:00:00.000Z",
        ] {
            let ms = parse_ts_ms(ts).unwrap();
            assert_eq!(format_ts_ms(ms), ts);
        }
    }

    #[test]
    fn scope_prefix_is_segment_aware() {
        assert!(path_in_scope("Проекты/A.md", "Проекты"));
        assert!(path_in_scope("Проекты/A.md", "Проекты/A.md"));
        assert!(!path_in_scope("Проекты2/C.md", "Проекты"));
        assert!(!path_in_scope("Проекты", "Проекты/A.md"));
    }

    #[test]
    fn month_keys_and_bounds() {
        assert_eq!(month_key("2026-07.jsonl"), Some("2026-07"));
        assert_eq!(month_key("2026-13.jsonl"), None);
        assert_eq!(month_key("notes.jsonl"), None);
        assert_eq!(month_key("2026-07.json"), None);
        assert_eq!(
            month_end_ms("2026-06"),
            parse_ts_ms("2026-07-01T00:00:00Z")
        );
        assert_eq!(
            month_end_ms("2026-12"),
            parse_ts_ms("2027-01-01T00:00:00Z")
        );
    }
}
