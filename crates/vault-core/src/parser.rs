//! Парсер формата хранилища (docs/vault-format.md, vault_format 1).
//!
//! Правила чтения: UTF-8 (BOM допускается и пропускается), `\r\n` эквивалентен
//! `\n` и никогда не переписывается, битый frontmatter деградирует мягко —
//! файл читается как тело без метаданных. Внутри fenced-код-блоков и
//! инлайн-кода wiki-ссылки, теги, задачи и заголовки не распознаются (§11).

use std::collections::BTreeSet;

use comrak::nodes::{AstNode, NodeValue};
use comrak::{Arena, Options, parse_document};

use crate::error::VaultError;
use crate::model::{
    Anchor, Block, Frontmatter, LinkEdge, NoteId, NoteType, Priority, RelType, Status, TaskItem,
    TaskStatus,
};

/// Разобранная заметка целиком: frontmatter, тело и связи `rel:`
/// в порядке появления в документе.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedNote {
    pub frontmatter: Frontmatter,
    /// Тело заметки ровно как в файле (переводы строк не переписываются).
    pub body: String,
    /// Байтовое смещение начала тела в исходном тексте файла (включая BOM).
    pub body_offset: usize,
    /// Типизированные связи из `rel:` в порядке документа
    /// (`Frontmatter.rel` — BTreeMap и порядок документа не хранит).
    pub rel_links: Vec<RelLink>,
    /// Мягкая ошибка frontmatter (§4.1): текст не теряется, файл читается
    /// как заметка без метаданных, проблема подсвечивается в UI.
    pub frontmatter_error: Option<String>,
}

/// Связь из frontmatter `rel:`: тип + исходное значение (wiki-ссылка).
#[derive(Debug, Clone, PartialEq)]
pub struct RelLink {
    pub rel_type: RelType,
    pub raw: String,
}

/// ATX-заголовок тела (setext в v1 не распознаются, §6).
#[derive(Debug, Clone, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    /// 1-based номер строки относительно тела.
    pub line: u32,
    /// Байтовое смещение начала строки заголовка относительно тела.
    pub pos: u32,
}

/// Wiki-ссылка в синтаксическом виде (§9.1); резолвинг здесь не выполняется.
#[derive(Debug, Clone, PartialEq)]
pub struct WikiLink {
    /// Точный текст из файла, включая `!` эмбеда и `\|`.
    pub raw: String,
    /// Цель до `#`/`|`: заголовок, путь или `id:…` — как написано.
    pub target: String,
    /// Секция после `#`.
    pub heading: Option<String>,
    /// Блочный якорь после `#^` (без `^`).
    pub block_anchor: Option<String>,
    /// Отображаемый текст после `|` (или `\|` в таблицах).
    pub alias: Option<String>,
    pub embed: bool,
    /// Байтовое смещение `raw` относительно тела.
    pub pos: u32,
}

pub fn parse_note(raw: &str) -> Result<ParsedNote, VaultError> {
    let bom_len = if raw.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    };
    let text = &raw[bom_len..];
    let Some(split) = split_frontmatter(text) else {
        return Ok(ParsedNote {
            frontmatter: Frontmatter::default(),
            body: text.to_string(),
            body_offset: bom_len,
            rel_links: Vec::new(),
            frontmatter_error: None,
        });
    };
    let with_body = |frontmatter: Frontmatter, rel_links: Vec<RelLink>| ParsedNote {
        frontmatter,
        body: text[split.body_offset..].to_string(),
        body_offset: bom_len + split.body_offset,
        rel_links,
        frontmatter_error: None,
    };
    let yaml_src = split.yaml.replace("\r\n", "\n");
    if yaml_src.trim().is_empty() {
        return Ok(with_body(Frontmatter::default(), Vec::new()));
    }
    match serde_yml::from_str::<serde_yml::Value>(&yaml_src) {
        Ok(serde_yml::Value::Mapping(mapping)) => {
            let (frontmatter, rel_links) = frontmatter_from_mapping(mapping);
            Ok(with_body(frontmatter, rel_links))
        }
        Ok(serde_yml::Value::Null) => Ok(with_body(Frontmatter::default(), Vec::new())),
        Ok(_) => Ok(ParsedNote {
            frontmatter: Frontmatter::default(),
            body: text.to_string(),
            body_offset: bom_len,
            rel_links: Vec::new(),
            frontmatter_error: Some("frontmatter не является YAML-словарём".to_string()),
        }),
        Err(err) => Ok(ParsedNote {
            frontmatter: Frontmatter::default(),
            body: text.to_string(),
            body_offset: bom_len,
            rel_links: Vec::new(),
            frontmatter_error: Some(err.to_string()),
        }),
    }
}

pub fn parse_frontmatter(raw: &str) -> Result<(Frontmatter, String), VaultError> {
    let parsed = parse_note(raw)?;
    Ok((parsed.frontmatter, parsed.body))
}

pub fn serialize_frontmatter(frontmatter: &Frontmatter) -> Result<String, VaultError> {
    use serde_yml::Value;

    let mut mapping = serde_yml::Mapping::new();
    if let Some(id) = &frontmatter.id {
        mapping.insert("id", Value::from(id.0.clone()));
    }
    if let Some(note_type) = frontmatter.r#type {
        mapping.insert("type", Value::from(note_type.as_str()));
    }
    if let Some(title) = &frontmatter.title {
        mapping.insert("title", Value::from(title.clone()));
    }
    if !frontmatter.aliases.is_empty() {
        mapping.insert("aliases", string_seq(&frontmatter.aliases));
    }
    if !frontmatter.tags.is_empty() {
        mapping.insert("tags", string_seq(&frontmatter.tags));
    }
    if let Some(status) = frontmatter.status {
        mapping.insert("status", Value::from(status.as_str()));
    }
    if let Some(priority) = frontmatter.priority {
        mapping.insert("priority", Value::from(priority.as_str()));
    }
    if let Some(due) = &frontmatter.due {
        mapping.insert("due", Value::from(due.clone()));
    }
    if let Some(scheduled) = &frontmatter.scheduled {
        mapping.insert("scheduled", Value::from(scheduled.clone()));
    }
    if let Some(goal) = &frontmatter.goal {
        mapping.insert("goal", Value::from(goal.clone()));
    }
    if let Some(target_date) = &frontmatter.target_date {
        mapping.insert("target_date", Value::from(target_date.clone()));
    }
    if !frontmatter.rel.is_empty() {
        let mut rel = serde_yml::Mapping::new();
        for (name, targets) in &frontmatter.rel {
            rel.insert(name.clone(), string_seq(targets));
        }
        mapping.insert("rel", Value::Mapping(rel));
    }
    if let Some(sort) = frontmatter.sort {
        mapping.insert("sort", Value::from(sort));
    }
    if let Some(created) = &frontmatter.created {
        mapping.insert("created", Value::from(created.clone()));
    }
    if let Some(updated) = &frontmatter.updated {
        mapping.insert("updated", Value::from(updated.clone()));
    }
    for (key, value) in &frontmatter.extra {
        if !mapping.contains_key(key.as_str()) {
            mapping.insert(key.clone(), value.clone());
        }
    }
    if mapping.is_empty() {
        return Ok(String::new());
    }
    let yaml = serde_yml::to_string(&serde_yml::Value::Mapping(mapping))
        .map_err(|err| VaultError::Validation(format!("сериализация frontmatter: {err}")))?;
    let yaml = yaml.trim_end_matches('\n');
    Ok(format!("---\n{yaml}\n---\n"))
}

pub fn extract_headings(body: &str) -> Result<Vec<Heading>, VaultError> {
    Ok(body_context(body).headings)
}

pub fn extract_blocks(note_id: &NoteId, body: &str) -> Result<Vec<Block>, VaultError> {
    Ok(body_context(body)
        .blocks
        .into_iter()
        .map(|block| Block {
            note_id: note_id.clone(),
            anchor: block.anchor.map(Anchor),
            heading_path: block.heading_path,
            text: block.text,
            pos: block.start as u32,
        })
        .collect())
}

pub fn extract_tasks(note_id: &NoteId, body: &str) -> Result<Vec<TaskItem>, VaultError> {
    let ctx = body_context(body);
    let mut tasks = Vec::new();
    for (index, span) in ctx.spans.iter().enumerate() {
        let line_no = index + 1;
        let line = &body[span.start..span.content_end];
        let Some(parsed) = parse_task_line(line, span.start, &ctx.mask) else {
            continue;
        };
        let anchor = parsed.anchor.unwrap_or_default();
        tasks.push(TaskItem {
            id: anchor.clone(),
            note_id: note_id.clone(),
            anchor: Anchor(anchor),
            text: parsed.text,
            done: parsed.status == TaskStatus::Done,
            status: parsed.status,
            due: parsed.due,
            priority: parsed.priority,
            every: parsed.every,
            line: line_no as u32,
            plan: None,
            stage: stage_for_line(&ctx.headings, line_no),
        });
    }
    Ok(tasks)
}

pub fn extract_links(src_id: &NoteId, body: &str) -> Result<Vec<LinkEdge>, VaultError> {
    let ctx = body_context(body);
    Ok(scan_wikilinks_with_mask(body, &ctx.mask)
        .into_iter()
        .map(|link| {
            let pos = link.pos as usize;
            let block = ctx
                .blocks
                .iter()
                .find(|block| block.anchor.is_some() && pos >= block.start && pos < block.end)
                .and_then(|block| block.anchor.clone())
                .map(Anchor);
            LinkEdge {
                src_id: src_id.clone(),
                dst_id: None,
                dst_raw: link.raw,
                rel_type: RelType::Related,
                block,
                context: None,
            }
        })
        .collect())
}

/// Все wiki-ссылки тела в порядке документа (код исключён, §11).
pub fn scan_wikilinks(body: &str) -> Vec<WikiLink> {
    let ctx = body_context(body);
    scan_wikilinks_with_mask(body, &ctx.mask)
}

/// Разбор одиночной wiki-ссылки вида `[[…]]` / `![[…]]`
/// (значения `rel:` frontmatter, §9.5).
pub fn parse_wikilink(text: &str) -> Option<WikiLink> {
    let trimmed = text.trim();
    let (embed, rest) = match trimmed.strip_prefix('!') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let inner = rest.strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.contains('\n') || inner.contains('\r') || inner.contains("[[") {
        return None;
    }
    let mut link = parse_link_content(inner)?;
    link.raw = trimmed.to_string();
    link.embed = embed;
    Some(link)
}

/// Инлайн-теги тела в порядке появления, без дублей по нормализации §9.3.
pub fn extract_tags(body: &str) -> Vec<String> {
    let ctx = body_context(body);
    let mut ranges = ctx.mask.ranges.clone();
    for link in scan_wikilinks_with_mask(body, &ctx.mask) {
        let start = link.pos as usize;
        ranges.push((start, start + link.raw.len()));
    }
    let mask = Mask::new(ranges);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    let mut pos = 0;
    while pos < body.len() {
        let ch = body[pos..].chars().next().unwrap();
        if ch == '#' && !mask.contains(pos) && prev.is_none_or(|p| !blocks_tag_start(p)) {
            let tag_start = pos + 1;
            let mut end = tag_start;
            while end < body.len() && !mask.contains(end) {
                let next = body[end..].chars().next().unwrap();
                if is_tag_char(next) {
                    end += next.len_utf8();
                } else {
                    break;
                }
            }
            let candidate = &body[tag_start..end];
            if !candidate.is_empty()
                && !candidate.chars().all(|c| c.is_ascii_digit())
                && seen.insert(normalize_for_compare(candidate))
            {
                out.push(candidate.to_string());
            }
            prev = body[pos..end.max(tag_start)].chars().last();
            pos = end;
        } else {
            prev = Some(ch);
            pos += ch.len_utf8();
        }
    }
    out
}

/// Границы секции по заголовку: от строки заголовка до следующего заголовка
/// того же или более высокого уровня (или до конца тела).
pub fn find_section(body: &str, heading: &str) -> Result<Option<(usize, usize)>, VaultError> {
    let headings = body_context(body).headings;
    let wanted = normalize_for_compare(heading.trim_start().trim_start_matches('#'));
    let Some(index) = headings
        .iter()
        .position(|h| normalize_for_compare(&h.text) == wanted)
    else {
        return Ok(None);
    };
    let target = &headings[index];
    let end = headings[index + 1..]
        .iter()
        .find(|h| h.level <= target.level)
        .map(|h| h.pos as usize)
        .unwrap_or(body.len());
    Ok(Some((target.pos as usize, end)))
}

/// Новый якорь задачи: `t-` + 5 символов Crockford base32 в нижнем регистре
/// (грамматика §7.1). Уникальность в пределах файла обеспечивает вызывающий.
pub fn generate_anchor() -> Anchor {
    let ulid = ulid::Ulid::new().to_string().to_lowercase();
    Anchor(format!("t-{}", &ulid[ulid.len() - 5..]))
}

/// Нормализация для сравнения (§9.3): casefold, `ё`→`е`, трим краёв.
/// Unicode NFC не применяется: зависимость нормализации в крейте отсутствует.
pub fn normalize_for_compare(text: &str) -> String {
    text.trim().to_lowercase().replace('ё', "е")
}

struct FrontmatterSplit<'a> {
    yaml: &'a str,
    body_offset: usize,
}

fn split_frontmatter(text: &str) -> Option<FrontmatterSplit<'_>> {
    let (first_line, mut cursor) = match text.find('\n') {
        Some(pos) => (&text[..pos], pos + 1),
        None => return None,
    };
    if !is_frontmatter_delimiter(first_line) {
        return None;
    }
    let yaml_start = cursor;
    while cursor < text.len() {
        let (line, next) = match text[cursor..].find('\n') {
            Some(pos) => (&text[cursor..cursor + pos], cursor + pos + 1),
            None => (&text[cursor..], text.len()),
        };
        if is_frontmatter_delimiter(line) {
            return Some(FrontmatterSplit {
                yaml: &text[yaml_start..cursor],
                body_offset: next,
            });
        }
        cursor = next;
    }
    None
}

fn is_frontmatter_delimiter(line: &str) -> bool {
    line.trim_end() == "---"
}

fn frontmatter_from_mapping(mapping: serde_yml::Mapping) -> (Frontmatter, Vec<RelLink>) {
    let mut fm = Frontmatter::default();
    let mut rel_links = Vec::new();
    for (key, value) in mapping {
        let name = key;
        let consumed = match name.as_str() {
            "id" => yaml_string(&value)
                .map(|v| fm.id = Some(NoteId(v)))
                .is_some(),
            "type" => yaml_enum::<NoteType>(&value)
                .map(|v| fm.r#type = Some(v))
                .is_some(),
            "title" => yaml_string(&value).map(|v| fm.title = Some(v)).is_some(),
            "aliases" => yaml_string_list(&value).map(|v| fm.aliases = v).is_some(),
            "tags" => yaml_string_list(&value).map(|v| fm.tags = v).is_some(),
            "status" => yaml_enum::<Status>(&value)
                .map(|v| fm.status = Some(v))
                .is_some(),
            "priority" => yaml_enum::<Priority>(&value)
                .map(|v| fm.priority = Some(v))
                .is_some(),
            "due" => yaml_string(&value).map(|v| fm.due = Some(v)).is_some(),
            "scheduled" => yaml_string(&value)
                .map(|v| fm.scheduled = Some(v))
                .is_some(),
            "goal" => yaml_string(&value).map(|v| fm.goal = Some(v)).is_some(),
            "target_date" => yaml_string(&value)
                .map(|v| fm.target_date = Some(v))
                .is_some(),
            "sort" => value.as_f64().map(|v| fm.sort = Some(v)).is_some(),
            "created" => yaml_string(&value).map(|v| fm.created = Some(v)).is_some(),
            "updated" => yaml_string(&value).map(|v| fm.updated = Some(v)).is_some(),
            "rel" => match yaml_rel(&value) {
                Some(entries) => {
                    for (rel_name, targets) in &entries {
                        if let Ok(rel_type) = rel_name.parse::<RelType>() {
                            for target in targets {
                                rel_links.push(RelLink {
                                    rel_type: rel_type.clone(),
                                    raw: target.clone(),
                                });
                            }
                        }
                    }
                    fm.rel = entries.into_iter().collect();
                    true
                }
                None => false,
            },
            _ => false,
        };
        if !consumed {
            fm.extra.insert(name, value);
        }
    }
    (fm, rel_links)
}

fn yaml_string(value: &serde_yml::Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn yaml_enum<T: std::str::FromStr>(value: &serde_yml::Value) -> Option<T> {
    value.as_str().and_then(|s| s.parse::<T>().ok())
}

fn yaml_string_list(value: &serde_yml::Value) -> Option<Vec<String>> {
    let seq = value.as_sequence()?;
    let mut out = Vec::with_capacity(seq.len());
    for item in seq {
        out.push(item.as_str()?.to_string());
    }
    Some(out)
}

fn yaml_rel(value: &serde_yml::Value) -> Option<Vec<(String, Vec<String>)>> {
    let mapping = value.as_mapping()?;
    let mut out = Vec::with_capacity(mapping.len());
    for (key, targets) in mapping {
        out.push((key.clone(), yaml_string_list(targets)?));
    }
    Some(out)
}

fn string_seq(items: &[String]) -> serde_yml::Value {
    serde_yml::Value::Sequence(
        items
            .iter()
            .map(|item| serde_yml::Value::from(item.clone()))
            .collect(),
    )
}

#[derive(Debug, Clone, Copy)]
struct LineSpan {
    start: usize,
    content_end: usize,
    end: usize,
}

fn line_spans(body: &str) -> Vec<LineSpan> {
    let bytes = body.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            let mut content_end = index;
            if content_end > start && bytes[content_end - 1] == b'\r' {
                content_end -= 1;
            }
            spans.push(LineSpan {
                start,
                content_end,
                end: index + 1,
            });
            start = index + 1;
        }
    }
    if start < bytes.len() {
        spans.push(LineSpan {
            start,
            content_end: bytes.len(),
            end: bytes.len(),
        });
    }
    spans
}

#[derive(Debug, Default)]
struct Mask {
    ranges: Vec<(usize, usize)>,
}

impl Mask {
    fn new(mut ranges: Vec<(usize, usize)>) -> Self {
        ranges.retain(|range| range.1 > range.0);
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
        for range in ranges {
            match merged.last_mut() {
                Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
                _ => merged.push(range),
            }
        }
        Mask { ranges: merged }
    }

    fn contains(&self, pos: usize) -> bool {
        let index = self.ranges.partition_point(|range| range.1 <= pos);
        self.ranges.get(index).is_some_and(|range| range.0 <= pos)
    }
}

struct RawBlock {
    start: usize,
    end: usize,
    text: String,
    anchor: Option<String>,
    heading_path: Vec<String>,
}

struct BodyContext {
    spans: Vec<LineSpan>,
    mask: Mask,
    headings: Vec<Heading>,
    blocks: Vec<RawBlock>,
}

fn md_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options
}

fn body_context(body: &str) -> BodyContext {
    let spans = line_spans(body);
    if spans.is_empty() {
        return BodyContext {
            spans,
            mask: Mask::default(),
            headings: Vec::new(),
            blocks: Vec::new(),
        };
    }
    let arena = Arena::new();
    let root = parse_document(&arena, body, &md_options());

    let mut fence_lines = vec![false; spans.len()];
    let mut headings = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        match &data.value {
            NodeValue::CodeBlock(code) if code.fenced => {
                let from = data.sourcepos.start.line.max(1);
                let to = data.sourcepos.end.line.min(spans.len());
                for line in from..=to {
                    fence_lines[line - 1] = true;
                }
            }
            NodeValue::Heading(heading) if !heading.setext => {
                let line = data.sourcepos.start.line;
                if line >= 1 && line <= spans.len() {
                    headings.push(Heading {
                        level: heading.level,
                        text: collect_inline_text(node),
                        line: line as u32,
                        pos: spans[line - 1].start as u32,
                    });
                }
            }
            _ => {}
        }
    }

    let mut blocks = Vec::new();
    let mut path: Vec<(u8, String)> = Vec::new();
    for child in root.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::FrontMatter(_) => {}
            NodeValue::Heading(heading) if !heading.setext => {
                while path.last().is_some_and(|(level, _)| *level >= heading.level) {
                    path.pop();
                }
                path.push((heading.level, collect_inline_text(child)));
            }
            NodeValue::Heading(_) => {}
            _ => {
                let start_line = data.sourcepos.start.line;
                if start_line < 1 || start_line > spans.len() {
                    continue;
                }
                let end_line = data.sourcepos.end.line.clamp(start_line, spans.len());
                let start = spans[start_line - 1].start;
                let last = spans[end_line - 1];
                blocks.push(RawBlock {
                    start,
                    end: last.end,
                    text: body[start..last.content_end].to_string(),
                    anchor: trailing_anchor(&body[last.start..last.content_end]),
                    heading_path: path.iter().map(|(_, text)| text.clone()).collect(),
                });
            }
        }
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, flagged) in fence_lines.iter().enumerate() {
        if *flagged {
            ranges.push((spans[index].start, spans[index].end));
        }
    }
    let bytes = body.as_bytes();
    let blank = |span: &LineSpan| body[span.start..span.content_end].trim().is_empty();
    let mut index = 0;
    while index < spans.len() {
        if fence_lines[index] || blank(&spans[index]) {
            index += 1;
            continue;
        }
        let run_start = index;
        while index < spans.len() && !fence_lines[index] && !blank(&spans[index]) {
            index += 1;
        }
        let from = spans[run_start].start;
        let to = spans[index - 1].content_end;
        collect_code_spans(&bytes[from..to], from, &mut ranges);
    }

    BodyContext {
        spans,
        mask: Mask::new(ranges),
        headings,
        blocks,
    }
}

fn collect_inline_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    for child in node.descendants() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(text) => out.push_str(text),
            NodeValue::Code(code) => out.push_str(&code.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn collect_code_spans(bytes: &[u8], base: usize, out: &mut Vec<(usize, usize)>) {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let open_start = i;
        while i < bytes.len() && bytes[i] == b'`' {
            i += 1;
        }
        let fence = i - open_start;
        let mut j = i;
        let mut closed = None;
        while j < bytes.len() {
            if bytes[j] != b'`' {
                j += 1;
                continue;
            }
            let run_start = j;
            while j < bytes.len() && bytes[j] == b'`' {
                j += 1;
            }
            if j - run_start == fence {
                closed = Some(j);
                break;
            }
        }
        if let Some(end) = closed {
            out.push((base + open_start, base + end));
            i = end;
        }
    }
}

/// Блочный якорь в конце строки: `^` + `[a-z0-9][a-z0-9-]{1,31}`,
/// отделён пробелом, строго последний токен (§6).
fn trailing_anchor(line: &str) -> Option<String> {
    let trimmed = line.trim_end();
    let ws = trimmed.rfind(|c: char| c.is_whitespace())?;
    let sep = trimmed[ws..].chars().next()?;
    parse_anchor_token(&trimmed[ws + sep.len_utf8()..])
}

fn parse_anchor_token(token: &str) -> Option<String> {
    let ident = token.strip_prefix('^')?;
    let bytes = ident.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 {
        return None;
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return None;
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return None;
    }
    Some(ident.to_string())
}

fn stage_for_line(headings: &[Heading], line_no: usize) -> Option<String> {
    let mut stage = None;
    for heading in headings {
        if heading.line as usize >= line_no {
            break;
        }
        match heading.level {
            1 => stage = None,
            2 => stage = Some(heading.text.clone()),
            _ => {}
        }
    }
    stage
}

struct ParsedTaskLine {
    status: TaskStatus,
    text: String,
    anchor: Option<String>,
    due: Option<String>,
    priority: Option<Priority>,
    every: Option<String>,
}

/// Грамматика §7.1: `отступ маркер " [" state "] " текст [" " якорь]`,
/// маркеры `-`/`*`/`+`/`число.`/`число)`, state — ` / x X -`.
fn parse_task_line(line: &str, line_start: usize, mask: &Mask) -> Option<ParsedTaskLine> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i >= bytes.len() || mask.contains(line_start + i) {
        return None;
    }
    match bytes[i] {
        b'-' | b'*' | b'+' => i += 1,
        b'0'..=b'9' => {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i >= bytes.len() || (bytes[i] != b'.' && bytes[i] != b')') {
                return None;
            }
            i += 1;
        }
        _ => return None,
    }
    let after_marker = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == after_marker || i + 2 >= bytes.len() || bytes[i] != b'[' || bytes[i + 2] != b']' {
        return None;
    }
    let status = match bytes[i + 1] {
        b' ' => TaskStatus::Todo,
        b'/' => TaskStatus::Doing,
        b'x' | b'X' => TaskStatus::Done,
        b'-' => TaskStatus::Dropped,
        _ => return None,
    };
    i += 3;
    let after_checkbox = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == after_checkbox || i >= bytes.len() {
        return None;
    }
    let rest = &line[i..];
    let base = line_start + i;

    let mut anchor = None;
    let trimmed = rest.trim_end();
    let mut cut = trimmed.len();
    if let Some(ws) = trimmed.rfind(|c: char| c.is_whitespace()) {
        let sep = trimmed[ws..].chars().next()?;
        let token_start = ws + sep.len_utf8();
        if !mask.contains(base + token_start) {
            if let Some(found) = parse_anchor_token(&trimmed[token_start..]) {
                anchor = Some(found);
                cut = ws;
            }
        }
    }
    let (text, due, priority, every) = strip_annotations(&rest[..cut], base, mask);
    Some(ParsedTaskLine {
        status,
        text,
        anchor,
        due,
        priority,
        every,
    })
}

enum AnnotationKind {
    Due,
    Priority,
    Every,
}

/// Аннотации `@due(YYYY-MM-DD)` / `@p(low|normal|high|urgent)` / `@every(…)`
/// в любом месте текста после чекбокса; при дублях действует первая.
/// Текст задачи — строка без аннотаций и якоря, пробелы схлопнуты.
fn strip_annotations(
    source: &str,
    base: usize,
    mask: &Mask,
) -> (String, Option<String>, Option<Priority>, Option<String>) {
    const KINDS: [(&str, AnnotationKind); 3] = [
        ("@due(", AnnotationKind::Due),
        ("@p(", AnnotationKind::Priority),
        ("@every(", AnnotationKind::Every),
    ];
    let mut due = None;
    let mut priority = None;
    let mut every = None;
    let mut removed: Vec<(usize, usize)> = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' || mask.contains(base + i) {
            i += 1;
            continue;
        }
        let rest = &source[i..];
        let mut matched = None;
        for (prefix, kind) in &KINDS {
            let Some(tail) = rest.strip_prefix(prefix) else {
                continue;
            };
            if let Some(close) = tail.find(')') {
                let content = &tail[..close];
                let full_len = prefix.len() + close + 1;
                matched = match kind {
                    AnnotationKind::Due if is_plain_date(content) => {
                        if due.is_none() {
                            due = Some(content.to_string());
                        }
                        Some(full_len)
                    }
                    AnnotationKind::Priority => match content.parse::<Priority>() {
                        Ok(value) => {
                            if priority.is_none() {
                                priority = Some(value);
                            }
                            Some(full_len)
                        }
                        Err(_) => None,
                    },
                    AnnotationKind::Every if !content.is_empty() => {
                        if every.is_none() {
                            every = Some(content.to_string());
                        }
                        Some(full_len)
                    }
                    _ => None,
                };
            }
            break;
        }
        match matched {
            Some(len) => {
                removed.push((i, i + len));
                i += len;
            }
            None => i += 1,
        }
    }
    let mut cleaned = String::with_capacity(source.len());
    let mut cursor = 0;
    for (from, to) in removed {
        cleaned.push_str(&source[cursor..from]);
        cursor = to;
    }
    cleaned.push_str(&source[cursor..]);
    let text = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    (text, due, priority, every)
}

fn is_plain_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0usize, 1, 2, 3, 5, 6, 8, 9]
            .into_iter()
            .all(|i| bytes[i].is_ascii_digit())
}

fn scan_wikilinks_with_mask(body: &str, mask: &Mask) -> Vec<WikiLink> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    'scan: while i + 1 < bytes.len() {
        if bytes[i] != b'[' || bytes[i + 1] != b'[' || mask.contains(i) {
            i += 1;
            continue;
        }
        let content_start = i + 2;
        let mut j = content_start;
        loop {
            if j >= bytes.len() || bytes[j] == b'\n' || bytes[j] == b'\r' {
                i += 2;
                continue 'scan;
            }
            if bytes[j] == b'[' && j + 1 < bytes.len() && bytes[j + 1] == b'[' {
                i = j;
                continue 'scan;
            }
            if bytes[j] == b']' && j + 1 < bytes.len() && bytes[j + 1] == b']' {
                break;
            }
            j += 1;
        }
        let embed = i > 0 && bytes[i - 1] == b'!' && !mask.contains(i - 1);
        let raw_start = if embed { i - 1 } else { i };
        let raw_end = j + 2;
        if let Some(mut link) = parse_link_content(&body[content_start..j]) {
            link.raw = body[raw_start..raw_end].to_string();
            link.embed = embed;
            link.pos = raw_start as u32;
            out.push(link);
        }
        i = raw_end;
    }
    out
}

/// Внутренность `[[…]]`: цель, `#Секция` / `#^блок`, `|текст`
/// (`\|` внутри ссылки эквивалентен `|`, §9.1).
fn parse_link_content(content: &str) -> Option<WikiLink> {
    if content.trim().is_empty() {
        return None;
    }
    let (target_part, alias) = match content.find('|') {
        Some(pipe) => {
            let target_end = if pipe >= 1 && content.as_bytes()[pipe - 1] == b'\\' {
                pipe - 1
            } else {
                pipe
            };
            (&content[..target_end], Some(content[pipe + 1..].to_string()))
        }
        None => (content, None),
    };
    let (target, heading, block_anchor) = match target_part.find('#') {
        Some(hash) => {
            let section = &target_part[hash + 1..];
            match section.strip_prefix('^') {
                Some(anchor) => (&target_part[..hash], None, Some(anchor.to_string())),
                None => (&target_part[..hash], Some(section.to_string()), None),
            }
        }
        None => (target_part, None, None),
    };
    if target.trim().is_empty() && heading.is_none() && block_anchor.is_none() {
        return None;
    }
    Some(WikiLink {
        raw: String::new(),
        target: target.to_string(),
        heading,
        block_anchor,
        alias,
        embed: false,
        pos: 0,
    })
}

fn blocks_tag_start(prev: char) -> bool {
    prev.is_alphanumeric() || prev == '_' || prev == '-' || prev == '/' || prev == '#'
}

fn is_tag_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '-' || ch == '/'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_full_fields_and_rel_order() {
        let raw = "---\nid: 01KWKK9MK8AKM3AECZ8W7CGJZ9\ntype: project\ntitle: Приложение заметок\naliases: [graphite-app, заметочник]\ntags: [проект/приложение, mvp]\nstatus: active\npriority: high\ndue: 2026-09-15\nscheduled: 2026-07-07\nsort: 1.5\nrel:\n  part_of: [\"[[id:01KWKK9KM07MQT3YZJZDBWJ647|Проекты]]\"]\n  depends_on: [\"[[План MVP]]\"]\ncreated: 2026-07-01T10:05:00+03:00\nupdated: 2026-07-03T14:30:00+03:00\nx-заказчик: я сам\nx-ревизия: 3\n---\nТело.\n";
        let note = parse_note(raw).unwrap();
        let fm = &note.frontmatter;
        assert_eq!(fm.id.as_ref().unwrap().0, "01KWKK9MK8AKM3AECZ8W7CGJZ9");
        assert_eq!(fm.r#type, Some(NoteType::Project));
        assert_eq!(fm.title.as_deref(), Some("Приложение заметок"));
        assert_eq!(fm.aliases, vec!["graphite-app", "заметочник"]);
        assert_eq!(fm.tags, vec!["проект/приложение", "mvp"]);
        assert_eq!(fm.status, Some(Status::Active));
        assert_eq!(fm.priority, Some(Priority::High));
        assert_eq!(fm.due.as_deref(), Some("2026-09-15"));
        assert_eq!(fm.scheduled.as_deref(), Some("2026-07-07"));
        assert_eq!(fm.sort, Some(1.5));
        assert_eq!(fm.created.as_deref(), Some("2026-07-01T10:05:00+03:00"));
        assert_eq!(fm.updated.as_deref(), Some("2026-07-03T14:30:00+03:00"));
        assert_eq!(fm.rel.len(), 2);
        assert_eq!(fm.extra.get("x-заказчик").unwrap().as_str(), Some("я сам"));
        assert!(fm.extra.contains_key("x-ревизия"));
        let rels: Vec<(&str, &str)> = note
            .rel_links
            .iter()
            .map(|r| (r.rel_type.as_str(), r.raw.as_str()))
            .collect();
        assert_eq!(
            rels,
            vec![
                ("part_of", "[[id:01KWKK9KM07MQT3YZJZDBWJ647|Проекты]]"),
                ("depends_on", "[[План MVP]]"),
            ]
        );
        assert_eq!(note.body, "Тело.\n");
    }

    #[test]
    fn frontmatter_absent_minimal_empty() {
        let (fm, body) = parse_frontmatter("просто текст").unwrap();
        assert_eq!(fm, Frontmatter::default());
        assert_eq!(body, "просто текст");

        let (fm, body) = parse_frontmatter("---\nstatus: inbox\n---\nтело").unwrap();
        assert_eq!(fm.status, Some(Status::Inbox));
        assert_eq!(fm.id, None);
        assert_eq!(body, "тело");

        let (fm, body) = parse_frontmatter("").unwrap();
        assert_eq!(fm, Frontmatter::default());
        assert_eq!(body, "");

        let (fm, body) = parse_frontmatter("---\n---\nтело").unwrap();
        assert_eq!(fm, Frontmatter::default());
        assert_eq!(body, "тело");
    }

    #[test]
    fn frontmatter_broken_yaml_keeps_whole_text() {
        let raw = "---\n: [битый yaml\n---\nтело\n";
        let note = parse_note(raw).unwrap();
        assert!(note.frontmatter_error.is_some());
        assert_eq!(note.frontmatter, Frontmatter::default());
        assert_eq!(note.body, raw);
    }

    #[test]
    fn frontmatter_bom_and_crlf() {
        let raw = "\u{feff}---\r\ntitle: CRLF заголовок\r\nstatus: shaping\r\n---\r\nтело\r\n";
        let note = parse_note(raw).unwrap();
        assert_eq!(note.frontmatter.title.as_deref(), Some("CRLF заголовок"));
        assert_eq!(note.frontmatter.status, Some(Status::Shaping));
        assert_eq!(note.body, "тело\r\n");
    }

    #[test]
    fn frontmatter_task_status_degrades_to_extra() {
        let (fm, _) = parse_frontmatter("---\ntype: task\nstatus: todo\n---\n").unwrap();
        assert_eq!(fm.r#type, Some(NoteType::Task));
        assert_eq!(fm.status, None);
        assert_eq!(fm.extra.get("status").unwrap().as_str(), Some("todo"));
    }

    #[test]
    fn frontmatter_unknown_type_degrades_to_extra() {
        let (fm, _) = parse_frontmatter("---\ntype: рецепт\n---\n").unwrap();
        assert_eq!(fm.r#type, None);
        assert_eq!(fm.extra.get("type").unwrap().as_str(), Some("рецепт"));
    }

    #[test]
    fn serialize_roundtrip() {
        let raw = "---\nid: 01KWKK9RG8FSTPM4X2APC8X4AB\ntype: plan\ntitle: План MVP\ngoal: Рабочий прототип\ntarget_date: 2026-08-01\nstatus: active\nsort: 3.5\nrel:\n  part_of: [\"[[Приложение заметок]]\"]\nx-поле: значение\n---\n";
        let (fm, _) = parse_frontmatter(raw).unwrap();
        let serialized = serialize_frontmatter(&fm).unwrap();
        assert!(serialized.starts_with("---\n"));
        assert!(serialized.ends_with("---\n"));
        let (back, _) = parse_frontmatter(&serialized).unwrap();
        assert_eq!(back, fm);
    }

    #[test]
    fn serialize_empty_frontmatter() {
        assert_eq!(serialize_frontmatter(&Frontmatter::default()).unwrap(), "");
    }

    #[test]
    fn tasks_grammar_and_annotations() {
        let note_id = NoteId("N".to_string());
        let body = "# Дела\n\n- [ ] Выбрать платформу @due(2026-07-15) @p(high) @every(mon) ^t-8f2k\n- [x] Готово @p(normal) ^t-9m3q\n- [/] В работе\n- [-] Брошена\n* [ ] Звёздочка\n+ [ ] Плюс\n1. [ ] Номер точкой\n2) [ ] Номер скобкой\n  - [X] Вложенная капсом\n- [ ] Согласовать @p(high) бюджет ^t-md1e\n- [ ] Кривая дата @due(тест) остаётся\n- [?] не задача\n-[ ] нет пробела\n- [x]нет текста\n";
        let tasks = extract_tasks(&note_id, body).unwrap();
        let texts: Vec<&str> = tasks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "Выбрать платформу",
                "Готово",
                "В работе",
                "Брошена",
                "Звёздочка",
                "Плюс",
                "Номер точкой",
                "Номер скобкой",
                "Вложенная капсом",
                "Согласовать бюджет",
                "Кривая дата @due(тест) остаётся",
            ]
        );
        assert_eq!(tasks[0].anchor.0, "t-8f2k");
        assert_eq!(tasks[0].id, "t-8f2k");
        assert_eq!(tasks[0].due.as_deref(), Some("2026-07-15"));
        assert_eq!(tasks[0].priority, Some(Priority::High));
        assert_eq!(tasks[0].every.as_deref(), Some("mon"));
        assert_eq!(tasks[0].status, TaskStatus::Todo);
        assert_eq!(tasks[0].line, 3);
        assert!(tasks[1].done);
        assert_eq!(tasks[2].status, TaskStatus::Doing);
        assert_eq!(tasks[3].status, TaskStatus::Dropped);
        assert!(!tasks[3].done);
        assert_eq!(tasks[8].status, TaskStatus::Done);
        assert_eq!(tasks[9].anchor.0, "t-md1e");
        assert_eq!(tasks[9].priority, Some(Priority::High));
        assert_eq!(tasks[10].due, None);
    }

    #[test]
    fn tasks_stage_from_level_two_heading() {
        let note_id = NoteId("N".to_string());
        let body = "# План\n\n- [ ] Без этапа\n\n## Этап 1\n\n- [ ] В этапе\n";
        let tasks = extract_tasks(&note_id, body).unwrap();
        assert_eq!(tasks[0].stage, None);
        assert_eq!(tasks[1].stage.as_deref(), Some("Этап 1"));
    }

    #[test]
    fn tasks_excluded_inside_code() {
        let note_id = NoteId("N".to_string());
        let body = "```text\n- [ ] не задача @due(2026-01-01) ^t-fake\n```\n\n- [ ] настоящая\n";
        let tasks = extract_tasks(&note_id, body).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].text, "настоящая");
        assert_eq!(tasks[0].anchor.0, "");
    }

    #[test]
    fn links_all_forms() {
        let body = "Простая: [[Тёмная тема]]\nСекция: [[Тёмная тема#Палитра]]\nБлок: [[Тёмная тема#^b3k9q]]\nТекст: [[Тёмная тема|как красят тьму]]\nId: [[id:01KWKK9PHRG3EBGPKXNQ3M2EP2|та же]]\nПуть: [[Проекты/План MVP|по пути]]\nЭмбед: ![[Ёжик]]\nТаблица: [[Ёжик в тумане\\|ёж]]\n";
        let links = scan_wikilinks(body);
        assert_eq!(links.len(), 8);
        assert_eq!(links[0].raw, "[[Тёмная тема]]");
        assert_eq!(links[0].target, "Тёмная тема");
        assert_eq!(links[1].heading.as_deref(), Some("Палитра"));
        assert_eq!(links[2].block_anchor.as_deref(), Some("b3k9q"));
        assert_eq!(links[3].alias.as_deref(), Some("как красят тьму"));
        assert!(links[4].target.starts_with("id:"));
        assert!(links[5].target.contains('/'));
        assert!(links[6].embed);
        assert_eq!(links[6].raw, "![[Ёжик]]");
        assert_eq!(links[7].raw, "[[Ёжик в тумане\\|ёж]]");
        assert_eq!(links[7].target, "Ёжик в тумане");
        assert_eq!(links[7].alias.as_deref(), Some("ёж"));
    }

    #[test]
    fn links_excluded_inside_code() {
        let body =
            "```\n[[не-ссылка]]\n```\n\nИнлайн `[[тоже нет]]` и настоящая [[Цель]] ссылка.\n";
        let links = scan_wikilinks(body);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw, "[[Цель]]");
    }

    #[test]
    fn links_edge_cases() {
        assert!(scan_wikilinks("[[]] и [[|только текст]]").is_empty());
        assert!(scan_wikilinks("незакрытая [[ссылка\nна двух строках]]").is_empty());
        let nested = scan_wikilinks("[[внешняя [[внутренняя]]");
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].target, "внутренняя");
    }

    #[test]
    fn parse_wikilink_rel_values() {
        let link = parse_wikilink("[[id:01KWKK9KM07MQT3YZJZDBWJ647|Проекты]]").unwrap();
        assert_eq!(link.target, "id:01KWKK9KM07MQT3YZJZDBWJ647");
        assert_eq!(link.alias.as_deref(), Some("Проекты"));
        assert!(!link.embed);
        let embed = parse_wikilink("![[План#^t-8f2k]]").unwrap();
        assert!(embed.embed);
        assert_eq!(embed.block_anchor.as_deref(), Some("t-8f2k"));
        assert!(parse_wikilink("просто текст").is_none());
    }

    #[test]
    fn link_edges_carry_source_block_anchor() {
        let src = NoteId("N".to_string());
        let body = "Абзац со ссылкой [[Цель]] и якорем. ^b3k9q\n\nБез якоря [[Цель]].\n";
        let edges = extract_links(&src, body).unwrap();
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].block.as_ref().map(|a| a.0.as_str()), Some("b3k9q"));
        assert_eq!(edges[0].dst_raw, "[[Цель]]");
        assert_eq!(edges[0].rel_type, RelType::Related);
        assert_eq!(edges[0].dst_id, None);
        assert_eq!(edges[1].block, None);
    }

    #[test]
    fn tags_rules() {
        let body = "Простой #тег, вложенный #вложенный/тег, латинский #tag-mix_2.\n\nЧисло #2026 не тег, слово#нет не тег, дубль #Тег не добавляется.\n\nВ ссылке [[Тема#Палитра]] тега нет, в коде `#нет` тоже.\n";
        assert_eq!(extract_tags(body), vec!["тег", "вложенный/тег", "tag-mix_2"]);
    }

    #[test]
    fn headings_hierarchy_and_sections() {
        let body = "# Идея\n\nтекст\n\n## Риски\n\nещё\n\n## Палитра\n\nхвост\n\n# Другая\n";
        let headings = extract_headings(body).unwrap();
        let flat: Vec<(u8, &str)> = headings.iter().map(|h| (h.level, h.text.as_str())).collect();
        assert_eq!(
            flat,
            vec![(1, "Идея"), (2, "Риски"), (2, "Палитра"), (1, "Другая")]
        );
        let (start, end) = find_section(body, "Риски").unwrap().unwrap();
        assert_eq!(&body[start..end], "## Риски\n\nещё\n\n");
        let (_, end) = find_section(body, "## ПАЛИТРА").unwrap().unwrap();
        assert_eq!(&body[..end], &body[..body.find("# Другая").unwrap()]);
        assert_eq!(find_section(body, "Нет такой").unwrap(), None);
    }

    #[test]
    fn headings_skip_code_and_setext() {
        let body = "```\n# не заголовок\n```\n\nЗаголовок setext\n===\n\n# Настоящий\n";
        let headings = extract_headings(body).unwrap();
        assert_eq!(headings.len(), 1);
        assert_eq!(headings[0].text, "Настоящий");
    }

    #[test]
    fn blocks_have_heading_path_anchor_and_pos() {
        let note_id = NoteId("N".to_string());
        let body = "# Идея\n\nПервый абзац. ^b3k9q\n\n## Риски\n\nВторой абзац.\n";
        let blocks = extract_blocks(&note_id, body).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].heading_path, vec!["Идея"]);
        assert_eq!(blocks[0].anchor.as_ref().map(|a| a.0.as_str()), Some("b3k9q"));
        assert_eq!(blocks[0].text, "Первый абзац. ^b3k9q");
        assert_eq!(blocks[0].pos as usize, body.find("Первый").unwrap());
        assert_eq!(blocks[1].heading_path, vec!["Идея", "Риски"]);
        assert_eq!(blocks[1].anchor, None);
    }

    #[test]
    fn generated_anchor_matches_grammar() {
        for _ in 0..32 {
            let anchor = generate_anchor();
            let ident = anchor.0.strip_prefix("t-").unwrap();
            assert_eq!(ident.len(), 5);
            assert!(parse_anchor_token(&format!("^{}", anchor.0)).is_some());
        }
    }

    #[test]
    fn crlf_body_constructs() {
        let body = "# Файл с CRLF\r\n\r\n- [ ] Задача @due(2026-07-21) ^t-cr1f\r\n\r\nСсылка: [[Тёмная тема]].\r\n";
        let headings = extract_headings(body).unwrap();
        assert_eq!(headings[0].text, "Файл с CRLF");
        let tasks = extract_tasks(&NoteId("N".into()), body).unwrap();
        assert_eq!(tasks[0].text, "Задача");
        assert_eq!(tasks[0].anchor.0, "t-cr1f");
        assert_eq!(tasks[0].due.as_deref(), Some("2026-07-21"));
        let links = scan_wikilinks(body);
        assert_eq!(links[0].raw, "[[Тёмная тема]]");
    }
}
