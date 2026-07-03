//! Резолвинг ссылок и `ref`-адресов (CONTRACT §1.4, формат §9).
//!
//! Порядок резолва цели: точный относительный путь → форма `id:` →
//! уникальный `title` → уникальный `alias`; неуникальность → `Ambiguous`
//! со списком кандидатов. Сравнение — по нормализации формата §9.3.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{
    Anchor, Block, LinkDirection, LinkEdge, LinkIn, LinkOut, LinksGetParams, LinksGetResponse,
    NoteId, NoteMeta, NoteRef, NoteType, RelType, Rev, Status,
};

/// Префикс id-формы `ref` (CONTRACT §1.4).
pub const REF_ID_PREFIX: &str = "id:";
/// Префикс path-формы `ref` (CONTRACT §1.4).
pub const REF_PATH_PREFIX: &str = "path:";

const INDEX_STEM: &str = "_index";
const ULID_LEN: usize = 26;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRef {
    Id(NoteId),
    Path(String),
}

/// Адресация внутри заметки: `#Секция` либо `#^якорь` (формат §9.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fragment {
    Section(String),
    Anchor(Anchor),
}

/// Разобранная цель wiki-ссылки `[[цель#фрагмент|текст]]` в любой форме §9.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiTarget {
    pub target: String,
    pub fragment: Option<Fragment>,
    pub display: Option<String>,
}

/// Строка отчёта «Разорванные связи»: ребро без `dst_id` и кандидаты починки
/// по alias/истории заголовков (переименование кладёт старый title в aliases).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLink {
    pub edge: LinkEdge,
    pub src_path: String,
    pub candidates: Vec<NoteMeta>,
}

/// Нормализация для сравнения (формат §9.3): Unicode NFC → casefold →
/// `ё`→`е` → трим краевых пробелов. Файлы не меняются, только сравнение.
pub fn normalize_key(raw: &str) -> String {
    let mut folded = String::with_capacity(raw.len());
    for c in compose_nfc(raw) {
        for lower in c.to_lowercase() {
            folded.push(if lower == 'ё' { 'е' } else { lower });
        }
    }
    folded.trim().to_string()
}

fn compose_nfc(raw: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for c in raw.chars() {
        if let Some(&base) = out.last() {
            if let Some(composed) = compose_pair(base, c) {
                let last = out.len() - 1;
                out[last] = composed;
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn compose_pair(base: char, mark: char) -> Option<char> {
    let composed = match (base, mark) {
        ('е', '\u{0308}') => 'ё',
        ('Е', '\u{0308}') => 'Ё',
        ('і', '\u{0308}') => 'ї',
        ('І', '\u{0308}') => 'Ї',
        ('и', '\u{0306}') => 'й',
        ('И', '\u{0306}') => 'Й',
        ('у', '\u{0306}') => 'ў',
        ('У', '\u{0306}') => 'Ў',
        ('г', '\u{0301}') => 'ѓ',
        ('Г', '\u{0301}') => 'Ѓ',
        ('к', '\u{0301}') => 'ќ',
        ('К', '\u{0301}') => 'Ќ',
        ('a', '\u{0300}') => 'à',
        ('a', '\u{0301}') => 'á',
        ('a', '\u{0302}') => 'â',
        ('a', '\u{0303}') => 'ã',
        ('a', '\u{0306}') => 'ă',
        ('a', '\u{0308}') => 'ä',
        ('A', '\u{0300}') => 'À',
        ('A', '\u{0301}') => 'Á',
        ('A', '\u{0302}') => 'Â',
        ('A', '\u{0303}') => 'Ã',
        ('A', '\u{0306}') => 'Ă',
        ('A', '\u{0308}') => 'Ä',
        ('e', '\u{0300}') => 'è',
        ('e', '\u{0301}') => 'é',
        ('e', '\u{0302}') => 'ê',
        ('e', '\u{0308}') => 'ë',
        ('E', '\u{0300}') => 'È',
        ('E', '\u{0301}') => 'É',
        ('E', '\u{0302}') => 'Ê',
        ('E', '\u{0308}') => 'Ë',
        ('i', '\u{0300}') => 'ì',
        ('i', '\u{0301}') => 'í',
        ('i', '\u{0302}') => 'î',
        ('i', '\u{0308}') => 'ï',
        ('I', '\u{0300}') => 'Ì',
        ('I', '\u{0301}') => 'Í',
        ('I', '\u{0302}') => 'Î',
        ('I', '\u{0308}') => 'Ï',
        ('o', '\u{0300}') => 'ò',
        ('o', '\u{0301}') => 'ó',
        ('o', '\u{0302}') => 'ô',
        ('o', '\u{0303}') => 'õ',
        ('o', '\u{0308}') => 'ö',
        ('O', '\u{0300}') => 'Ò',
        ('O', '\u{0301}') => 'Ó',
        ('O', '\u{0302}') => 'Ô',
        ('O', '\u{0303}') => 'Õ',
        ('O', '\u{0308}') => 'Ö',
        ('u', '\u{0300}') => 'ù',
        ('u', '\u{0301}') => 'ú',
        ('u', '\u{0302}') => 'û',
        ('u', '\u{0308}') => 'ü',
        ('U', '\u{0300}') => 'Ù',
        ('U', '\u{0301}') => 'Ú',
        ('U', '\u{0302}') => 'Û',
        ('U', '\u{0308}') => 'Ü',
        ('y', '\u{0301}') => 'ý',
        ('y', '\u{0308}') => 'ÿ',
        ('Y', '\u{0301}') => 'Ý',
        ('Y', '\u{0308}') => 'Ÿ',
        ('n', '\u{0303}') => 'ñ',
        ('N', '\u{0303}') => 'Ñ',
        ('c', '\u{0301}') => 'ć',
        ('C', '\u{0301}') => 'Ć',
        ('c', '\u{0327}') => 'ç',
        ('C', '\u{0327}') => 'Ç',
        ('s', '\u{0301}') => 'ś',
        ('S', '\u{0301}') => 'Ś',
        ('z', '\u{0301}') => 'ź',
        ('Z', '\u{0301}') => 'Ź',
        _ => return None,
    };
    Some(composed)
}

/// Строгий разбор канонического `ref`: только `id:…` и `path:…` (CONTRACT §1.4).
pub fn parse_ref(note_ref: &NoteRef) -> Result<ParsedRef, VaultError> {
    let raw = note_ref.0.trim();
    if let Some(rest) = raw.strip_prefix(REF_ID_PREFIX) {
        let canon = canonical_ulid(rest)
            .ok_or_else(|| VaultError::Validation(format!("некорректный ULID в ref: {raw}")))?;
        return Ok(ParsedRef::Id(NoteId(canon)));
    }
    if let Some(rest) = raw.strip_prefix(REF_PATH_PREFIX) {
        let path = clean_path(rest)
            .ok_or_else(|| VaultError::Validation(format!("некорректный путь в ref: {raw}")))?;
        return Ok(ParsedRef::Path(path));
    }
    Err(VaultError::Validation(format!(
        "ref должен начинаться с id: или path:, получено: {raw}"
    )))
}

fn canonical_ulid(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() != ULID_LEN {
        return None;
    }
    let mut canon = String::with_capacity(ULID_LEN);
    for c in trimmed.chars() {
        let up = c.to_ascii_uppercase();
        if !up.is_ascii_alphanumeric() || matches!(up, 'I' | 'L' | 'O' | 'U') {
            return None;
        }
        canon.push(up);
    }
    Some(canon)
}

fn clean_path(raw: &str) -> Option<String> {
    let replaced = raw.trim().replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    for segment in replaced.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        None
    } else {
        Some(segments.join("/"))
    }
}

/// Разбор сырой цели wiki-ссылки: снимает `![[`/`[[`/`]]`, отделяет
/// отображаемый текст после `|` (в GFM-таблицах разделитель пишется `\|`
/// и трактуется как `|`, формат §9.1) и фрагмент `#Секция`/`#^якорь`.
pub fn parse_wikilink_target(raw: &str) -> WikiTarget {
    let mut inner = raw.trim();
    if let Some(rest) = inner.strip_prefix('!') {
        inner = rest.trim_start();
    }
    if let Some(rest) = inner.strip_prefix("[[") {
        inner = rest.strip_suffix("]]").unwrap_or(rest);
    }
    let (body, display) = split_display(inner);
    let (target, fragment) = split_fragment(&body);
    WikiTarget {
        target,
        fragment,
        display,
    }
}

fn split_display(inner: &str) -> (String, Option<String>) {
    let mut body = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('|') => return (body, clean_display(chars.as_str())),
                Some(other) => {
                    body.push('\\');
                    body.push(other);
                }
                None => body.push('\\'),
            }
        } else if c == '|' {
            return (body, clean_display(chars.as_str()));
        } else {
            body.push(c);
        }
    }
    (body, None)
}

fn clean_display(rest: &str) -> Option<String> {
    let display = rest.replace("\\|", "|").trim().to_string();
    (!display.is_empty()).then_some(display)
}

fn split_fragment(body: &str) -> (String, Option<Fragment>) {
    match body.split_once('#') {
        None => (body.trim().to_string(), None),
        Some((target, frag)) => {
            let frag = frag.trim();
            let fragment = if let Some(anchor) = frag.strip_prefix('^') {
                Some(Fragment::Anchor(Anchor(anchor.trim().to_string())))
            } else if frag.is_empty() {
                None
            } else {
                Some(Fragment::Section(frag.to_string()))
            };
            (target.trim().to_string(), fragment)
        }
    }
}

/// Резолв `ref` в метаданные заметки. Канонические формы `id:`/`path:` —
/// строго по CONTRACT §1.4; строка без префикса резолвится лестницей §9.2:
/// путь (если есть `/`) → уникальный title → уникальный alias.
pub fn resolve(index: &Index, note_ref: &NoteRef) -> Result<NoteMeta, VaultError> {
    let raw = note_ref.0.trim();
    if raw.starts_with(REF_ID_PREFIX) || raw.starts_with(REF_PATH_PREFIX) {
        return match parse_ref(note_ref)? {
            ParsedRef::Id(id) => find_by_id(index, &id.0)?
                .map(|row| row.meta)
                .ok_or_else(|| VaultError::NotFound(raw.to_string())),
            ParsedRef::Path(path) => {
                let rows = load_all_notes(index)?;
                find_by_path(&rows, &path)
                    .map(|row| row.meta.clone())
                    .ok_or_else(|| VaultError::NotFound(raw.to_string()))
            }
        };
    }
    if raw.is_empty() {
        return Err(VaultError::Validation("пустой ref".to_string()));
    }
    let rows = load_all_notes(index)?;
    if raw.contains('/') || raw.contains('\\') {
        if let Some(path) = clean_path(raw) {
            if let Some(row) = find_by_path(&rows, &path) {
                return Ok(row.meta.clone());
            }
        }
        return Err(VaultError::NotFound(raw.to_string()));
    }
    find_by_title_or_alias(&rows, raw, raw)?
        .map(|row| row.meta.clone())
        .ok_or_else(|| VaultError::NotFound(raw.to_string()))
}

/// Резолв цели wiki-ссылки в id заметки. Битая ссылка — валидный текст
/// (формат §9.2), поэтому нерезолвящаяся цель — `Ok(None)`; единственная
/// ошибка резолва — `Ambiguous`. Пустая цель с фрагментом (`[[#…]]`) —
/// ссылка на саму заметку-источник.
pub fn resolve_wikilink(
    index: &Index,
    from: &NoteId,
    target: &str,
) -> Result<Option<NoteId>, VaultError> {
    let parsed = parse_wikilink_target(target);
    if parsed.target.is_empty() {
        return Ok(parsed.fragment.is_some().then(|| from.clone()));
    }
    if let Some(rest) = parsed.target.strip_prefix(REF_ID_PREFIX) {
        let Some(canon) = canonical_ulid(rest) else {
            return Ok(None);
        };
        return Ok(find_by_id(index, &canon)?.map(|row| row.meta.id));
    }
    let rows = load_all_notes(index)?;
    if parsed.target.contains('/') || parsed.target.contains('\\') {
        let Some(path) = clean_path(&parsed.target) else {
            return Ok(None);
        };
        return Ok(find_by_path(&rows, &path).map(|row| row.meta.id.clone()));
    }
    Ok(find_by_title_or_alias(&rows, &parsed.target, target)?.map(|row| row.meta.id.clone()))
}

/// Резолв `#Секция` по heading path блоков: регистронезависимо, с
/// нормализацией §9.3; возвращает первый блок секции по позиции.
pub fn resolve_section(index: &Index, note_id: &NoteId, heading: &str) -> Result<Block, VaultError> {
    let key = normalize_key(heading);
    if key.is_empty() {
        return Err(VaultError::Validation("пустой заголовок секции".to_string()));
    }
    load_blocks(index, note_id)?
        .into_iter()
        .find(|block| block.heading_path.iter().any(|h| normalize_key(h) == key))
        .ok_or_else(|| VaultError::NotFound(format!("секция «{heading}» в {}", note_id.0)))
}

/// Резолв `#^якорь` по таблице blocks: якоря сравниваются буквально (§9.3),
/// ведущий `^` в аргументе допускается.
pub fn resolve_anchor(index: &Index, note_id: &NoteId, anchor: &str) -> Result<Block, VaultError> {
    let trimmed = anchor.trim();
    let bare = trimmed.strip_prefix('^').unwrap_or(trimmed);
    if bare.is_empty() {
        return Err(VaultError::Validation("пустой якорь".to_string()));
    }
    load_blocks(index, note_id)?
        .into_iter()
        .find(|block| block.anchor.as_ref().is_some_and(|a| a.0 == bare))
        .ok_or_else(|| VaultError::NotFound(format!("якорь ^{bare} в {}", note_id.0)))
}

/// Диспетчер фрагмента из `parse_wikilink_target`.
pub fn resolve_fragment(
    index: &Index,
    note_id: &NoteId,
    fragment: &Fragment,
) -> Result<Block, VaultError> {
    match fragment {
        Fragment::Section(heading) => resolve_section(index, note_id, heading),
        Fragment::Anchor(anchor) => resolve_anchor(index, note_id, &anchor.0),
    }
}

/// Исходящие рёбра заметки из таблицы `links` (включая битые, `dst_id = None`).
pub fn outgoing(index: &Index, note_id: &NoteId) -> Result<Vec<LinkEdge>, VaultError> {
    query_links(
        index,
        "SELECT * FROM links WHERE src_id = ?1 ORDER BY rowid",
        &[&note_id.0],
    )
}

/// Бэклинки заметки: рёбра `links`, у которых `dst_id` — эта заметка.
/// В файлах бэклинки не хранятся никогда (формат §9.4).
pub fn backlinks(index: &Index, note_id: &NoteId) -> Result<Vec<LinkEdge>, VaultError> {
    query_links(
        index,
        "SELECT * FROM links WHERE dst_id = ?1 ORDER BY rowid",
        &[&note_id.0],
    )
}

/// Исполнитель инструмента `links_get` (CONTRACT §3.1): направление
/// default `both`, фильтр по типам связи; битые исходящие не включаются.
pub fn links_get(index: &Index, params: &LinksGetParams) -> Result<LinksGetResponse, VaultError> {
    let meta = resolve(index, &params.r#ref)?;
    let direction = params.direction.unwrap_or(LinkDirection::Both);
    let passes = |rel: &RelType| params.types.as_ref().is_none_or(|types| types.contains(rel));
    let mut out = Vec::new();
    if matches!(direction, LinkDirection::Out | LinkDirection::Both) {
        for edge in outgoing(index, &meta.id)? {
            let Some(dst) = edge.dst_id else { continue };
            if !passes(&edge.rel_type) {
                continue;
            }
            out.push(LinkOut {
                to: NoteRef(format!("{REF_ID_PREFIX}{}", dst.0)),
                r#type: edge.rel_type,
                context: edge.context,
            });
        }
    }
    let mut incoming = Vec::new();
    if matches!(direction, LinkDirection::In | LinkDirection::Both) {
        for edge in backlinks(index, &meta.id)? {
            if !passes(&edge.rel_type) {
                continue;
            }
            incoming.push(LinkIn {
                from: NoteRef(format!("{REF_ID_PREFIX}{}", edge.src_id.0)),
                r#type: edge.rel_type,
            });
        }
    }
    Ok(LinksGetResponse { out, r#in: incoming })
}

/// Отчёт «Разорванные связи»: все рёбра `dst_raw` без `dst_id` с кандидатами
/// починки по title/alias (alias хранит историю переименований, §6.11 SPEC).
pub fn broken_links(index: &Index) -> Result<Vec<BrokenLink>, VaultError> {
    let rows = load_all_notes(index)?;
    let path_by_id: HashMap<&str, &str> = rows
        .iter()
        .map(|row| (row.meta.id.0.as_str(), row.meta.path.as_str()))
        .collect();
    let edges = query_links(
        index,
        "SELECT * FROM links WHERE dst_id IS NULL ORDER BY rowid",
        &[],
    )?;
    let mut report: Vec<BrokenLink> = edges
        .into_iter()
        .map(|edge| {
            let src_path = path_by_id
                .get(edge.src_id.0.as_str())
                .map(|path| (*path).to_string())
                .unwrap_or_default();
            let candidates = repair_candidates(&rows, &edge.dst_raw);
            BrokenLink {
                edge,
                src_path,
                candidates,
            }
        })
        .collect();
    report.sort_by(|a, b| {
        (a.src_path.as_str(), a.edge.dst_raw.as_str())
            .cmp(&(b.src_path.as_str(), b.edge.dst_raw.as_str()))
    });
    Ok(report)
}

fn repair_candidates(rows: &[NoteRow], dst_raw: &str) -> Vec<NoteMeta> {
    let parsed = parse_wikilink_target(dst_raw);
    if parsed.target.is_empty() || parsed.target.starts_with(REF_ID_PREFIX) {
        return Vec::new();
    }
    let name = parsed
        .target
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(parsed.target.as_str());
    let norm = normalize_key(name);
    let key = strip_md_key(&norm).to_string();
    if key.is_empty() {
        return Vec::new();
    }
    let mut candidates: Vec<NoteMeta> = rows
        .iter()
        .filter(|row| row.title_keys().contains(&key) || row.alias_keys().contains(&key))
        .map(|row| row.meta.clone())
        .collect();
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    candidates
}

struct NoteRow {
    meta: NoteMeta,
    aliases: Vec<String>,
}

impl NoteRow {
    fn title_keys(&self) -> Vec<String> {
        let mut keys = vec![normalize_key(&self.meta.title)];
        let stem = normalize_key(&file_stem(&self.meta.path));
        if !keys.contains(&stem) {
            keys.push(stem);
        }
        keys.retain(|key| !key.is_empty());
        keys
    }

    fn alias_keys(&self) -> Vec<String> {
        self.aliases
            .iter()
            .map(|alias| normalize_key(alias))
            .filter(|key| !key.is_empty())
            .collect()
    }
}

fn file_stem(path: &str) -> String {
    let mut segments = path.split('/').rev();
    let last = segments.next().unwrap_or_default();
    let stem = strip_md_name(last);
    if normalize_key(stem) == INDEX_STEM {
        segments.next().unwrap_or_default().to_string()
    } else {
        stem.to_string()
    }
}

fn strip_md_name(name: &str) -> &str {
    name.strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .or_else(|| name.strip_suffix(".Md"))
        .or_else(|| name.strip_suffix(".mD"))
        .unwrap_or(name)
}

fn strip_md_key(norm: &str) -> &str {
    norm.strip_suffix(".md").unwrap_or(norm)
}

fn find_by_id(index: &Index, id: &str) -> Result<Option<NoteRow>, VaultError> {
    let rows = query_note_rows(
        index,
        "SELECT * FROM notes WHERE id = ?1 COLLATE NOCASE",
        &[&id],
    )?;
    Ok(rows.into_iter().next())
}

fn load_all_notes(index: &Index) -> Result<Vec<NoteRow>, VaultError> {
    query_note_rows(index, "SELECT * FROM notes ORDER BY path", &[])
}

fn find_by_path<'a>(rows: &'a [NoteRow], cleaned_path: &str) -> Option<&'a NoteRow> {
    let norm = normalize_key(cleaned_path);
    let key = strip_md_key(&norm);
    if key.is_empty() {
        return None;
    }
    let mut parent_hit = None;
    for row in rows {
        let row_norm = normalize_key(&row.meta.path);
        let stem = strip_md_key(&row_norm);
        if stem == key {
            return Some(row);
        }
        if parent_hit.is_none() {
            if let Some(parent) = stem.strip_suffix("/_index") {
                if parent == key {
                    parent_hit = Some(row);
                }
            }
        }
    }
    parent_hit
}

fn find_by_title_or_alias<'a>(
    rows: &'a [NoteRow],
    target: &str,
    raw_ref: &str,
) -> Result<Option<&'a NoteRow>, VaultError> {
    let key = normalize_key(target);
    if key.is_empty() {
        return Ok(None);
    }
    let title_hits: Vec<&NoteRow> = rows
        .iter()
        .filter(|row| row.title_keys().contains(&key))
        .collect();
    match title_hits.len() {
        1 => return Ok(Some(title_hits[0])),
        0 => {}
        _ => return Err(ambiguous(raw_ref, &title_hits)),
    }
    let alias_hits: Vec<&NoteRow> = rows
        .iter()
        .filter(|row| row.alias_keys().contains(&key))
        .collect();
    match alias_hits.len() {
        0 => Ok(None),
        1 => Ok(Some(alias_hits[0])),
        _ => Err(ambiguous(raw_ref, &alias_hits)),
    }
}

fn ambiguous(raw_ref: &str, hits: &[&NoteRow]) -> VaultError {
    let mut candidates: Vec<NoteMeta> = hits.iter().map(|row| row.meta.clone()).collect();
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    VaultError::Ambiguous {
        ref_: raw_ref.to_string(),
        candidates,
    }
}

fn query_note_rows(
    index: &Index,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<NoteRow>, VaultError> {
    let mut stmt = index.conn.prepare(sql).map_err(index_err)?;
    let mut sql_rows = stmt.query(params).map_err(index_err)?;
    let mut rows = Vec::new();
    while let Some(row) = sql_rows.next().map_err(index_err)? {
        rows.push(note_row_from(row)?);
    }
    if !rows.is_empty() && has_aliases_table(index)? {
        let alias_map = load_alias_map(index)?;
        for row in &mut rows {
            if let Some(extra) = alias_map.get(&row.meta.id.0) {
                for alias in extra {
                    if !row.aliases.contains(alias) {
                        row.aliases.push(alias.clone());
                    }
                }
            }
        }
    }
    Ok(rows)
}

fn note_row_from(row: &rusqlite::Row<'_>) -> Result<NoteRow, VaultError> {
    let id = req_text(row, "id")?;
    let path = req_text(row, "path")?;
    let props = opt_text(row, "props")
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let title = opt_text(row, "title")
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| file_stem(&path));
    let r#type = opt_text(row, "type")
        .and_then(|raw| raw.parse::<NoteType>().ok())
        .unwrap_or(NoteType::Note);
    let status = opt_text(row, "status").and_then(|raw| raw.parse::<Status>().ok());
    let tags = opt_text(row, "tags")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .or_else(|| json_strings(props.as_ref(), "tags"))
        .unwrap_or_default();
    let updated = opt_text(row, "updated")
        .or_else(|| json_string(props.as_ref(), "updated"))
        .or_else(|| opt_text(row, "mtime"))
        .unwrap_or_default();
    let rev = opt_text(row, "rev").unwrap_or_else(|| rev_from_hash(opt_text(row, "hash")));
    let children_count = opt_int(row, "children_count").unwrap_or(0).max(0) as u32;
    let aliases = json_strings(props.as_ref(), "aliases").unwrap_or_default();
    Ok(NoteRow {
        meta: NoteMeta {
            id: NoteId(id),
            path,
            title,
            r#type,
            status,
            tags,
            updated,
            rev: Rev(rev),
            children_count,
        },
        aliases,
    })
}

fn json_string(props: Option<&serde_json::Value>, key: &str) -> Option<String> {
    props?.get(key)?.as_str().map(str::to_string)
}

fn json_strings(props: Option<&serde_json::Value>, key: &str) -> Option<Vec<String>> {
    let items = props?.get(key)?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
    )
}

fn rev_from_hash(hash: Option<String>) -> String {
    let Some(hash) = hash else {
        return String::new();
    };
    let bare = hash.strip_prefix("blake3:").unwrap_or(&hash);
    bare.chars().take(16).collect::<String>().to_ascii_lowercase()
}

fn has_aliases_table(index: &Index) -> Result<bool, VaultError> {
    index
        .conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'aliases'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(index_err)
}

fn load_alias_map(index: &Index) -> Result<HashMap<String, Vec<String>>, VaultError> {
    let mut stmt = index
        .conn
        .prepare("SELECT note_id, alias FROM aliases")
        .map_err(index_err)?;
    let mut rows = stmt.query([]).map_err(index_err)?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    while let Some(row) = rows.next().map_err(index_err)? {
        let note_id: String = row.get(0).map_err(index_err)?;
        let alias: String = row.get(1).map_err(index_err)?;
        map.entry(note_id).or_default().push(alias);
    }
    Ok(map)
}

fn load_blocks(index: &Index, note_id: &NoteId) -> Result<Vec<Block>, VaultError> {
    let mut stmt = index
        .conn
        .prepare("SELECT * FROM blocks WHERE note_id = ?1 ORDER BY pos")
        .map_err(index_err)?;
    let mut sql_rows = stmt.query([&note_id.0]).map_err(index_err)?;
    let mut blocks = Vec::new();
    while let Some(row) = sql_rows.next().map_err(index_err)? {
        blocks.push(Block {
            note_id: NoteId(req_text(row, "note_id")?),
            anchor: opt_text(row, "anchor").map(Anchor),
            heading_path: opt_text(row, "heading_path")
                .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                .unwrap_or_default(),
            text: opt_text(row, "text").unwrap_or_default(),
            pos: opt_int(row, "pos").unwrap_or(0).max(0) as u32,
        });
    }
    Ok(blocks)
}

fn query_links(
    index: &Index,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<LinkEdge>, VaultError> {
    let mut stmt = index.conn.prepare(sql).map_err(index_err)?;
    let mut sql_rows = stmt.query(params).map_err(index_err)?;
    let mut edges = Vec::new();
    while let Some(row) = sql_rows.next().map_err(index_err)? {
        edges.push(LinkEdge {
            src_id: NoteId(req_text(row, "src_id")?),
            dst_id: opt_text(row, "dst_id").map(NoteId),
            dst_raw: opt_text(row, "dst_raw").unwrap_or_default(),
            rel_type: parse_rel(opt_text(row, "rel_type")),
            block: opt_text(row, "block").map(Anchor),
            context: opt_text(row, "context"),
        });
    }
    Ok(edges)
}

fn parse_rel(raw: Option<String>) -> RelType {
    match raw {
        None => RelType::Related,
        Some(value) => value
            .parse::<RelType>()
            .unwrap_or_else(|_| RelType::Custom(value)),
    }
}

fn req_text(row: &rusqlite::Row<'_>, column: &str) -> Result<String, VaultError> {
    row.get::<&str, String>(column).map_err(index_err)
}

fn opt_text(row: &rusqlite::Row<'_>, column: &str) -> Option<String> {
    row.get::<&str, Option<String>>(column).ok().flatten()
}

fn opt_int(row: &rusqlite::Row<'_>, column: &str) -> Option<i64> {
    row.get::<&str, Option<i64>>(column).ok().flatten()
}

fn index_err(err: rusqlite::Error) -> VaultError {
    VaultError::Index(err.to_string())
}
