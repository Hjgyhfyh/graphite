//! Golden-прогон парсера: все фикстуры `tests/fixtures/vault` сверяются
//! с машинными ожиданиями `tests/fixtures/expected.json` (обе — данные,
//! канон формата — docs/vault-format.md).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use vault_core::parser::{self, WikiLink};
use vault_core::{NoteId, TaskItem};

#[derive(Debug, Deserialize)]
struct Expected {
    not_indexed: Vec<String>,
    files: Vec<ExpectedFile>,
}

#[derive(Debug, Deserialize)]
struct ExpectedFile {
    file: String,
    id: Option<String>,
    #[serde(rename = "type")]
    note_type: String,
    status: Option<String>,
    title: String,
    tasks: Vec<ExpectedTask>,
    links: Vec<ExpectedLink>,
    headings: Vec<ExpectedHeading>,
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ExpectedTask {
    anchor: Option<String>,
    text: String,
    state: String,
    done: bool,
    due: Option<String>,
    priority: Option<String>,
    every: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExpectedLink {
    raw: String,
    form: String,
    #[serde(default)]
    rel: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExpectedHeading {
    level: u8,
    text: String,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
}

fn collect_note_files(root: &Path) -> BTreeSet<String> {
    fn walk(root: &Path, dir: &Path, found: &mut BTreeSet<String>) {
        for entry in fs::read_dir(dir).expect("каталог фикстур читается") {
            let entry = entry.expect("запись каталога читается");
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if name.starts_with('.') || name == "_assets" {
                    continue;
                }
                walk(root, &path, found);
            } else if name.ends_with(".md") && !name.starts_with('.') {
                let rel = path
                    .strip_prefix(root)
                    .expect("путь внутри vault")
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                found.insert(rel);
            }
        }
    }
    let mut found = BTreeSet::new();
    walk(root, root, &mut found);
    found
}

fn effective_title(file: &str, frontmatter_title: Option<&str>) -> String {
    if let Some(title) = frontmatter_title {
        return title.to_string();
    }
    let mut parts = file.rsplit('/');
    let name = parts.next().unwrap_or(file);
    if name == "_index.md" {
        return parts.next().unwrap_or_default().to_string();
    }
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

fn form_of(link: &WikiLink) -> String {
    let mut form = String::new();
    if link.embed {
        form.push('!');
    }
    form.push_str(if link.target.starts_with("id:") {
        "id"
    } else if link.target.contains('/') {
        "path"
    } else {
        "title"
    });
    if link.heading.is_some() {
        form.push_str("#heading");
    }
    if link.block_anchor.is_some() {
        form.push_str("#^block");
    }
    if link.alias.is_some() {
        form.push_str("|alias");
    }
    form
}

fn compare_tasks(file: &str, actual: &[TaskItem], expected: &[ExpectedTask], errors: &mut Vec<String>) {
    if actual.len() != expected.len() {
        let texts: Vec<&str> = actual.iter().map(|t| t.text.as_str()).collect();
        errors.push(format!(
            "[{file}] tasks: ожидалось {}, получено {} {texts:?}",
            expected.len(),
            actual.len()
        ));
        return;
    }
    for (index, (a, e)) in actual.iter().zip(expected).enumerate() {
        let anchor = (!a.anchor.0.is_empty()).then(|| a.anchor.0.clone());
        if anchor != e.anchor {
            errors.push(format!(
                "[{file}] task#{index} anchor: ожидалось {:?}, получено {anchor:?}",
                e.anchor
            ));
        }
        if a.id != a.anchor.0 {
            errors.push(format!(
                "[{file}] task#{index}: id {:?} расходится с anchor {:?}",
                a.id, a.anchor.0
            ));
        }
        if a.text != e.text {
            errors.push(format!(
                "[{file}] task#{index} text: ожидалось {:?}, получено {:?}",
                e.text, a.text
            ));
        }
        if a.status.as_str() != e.state {
            errors.push(format!(
                "[{file}] task#{index} state: ожидалось {:?}, получено {:?}",
                e.state,
                a.status.as_str()
            ));
        }
        if a.done != e.done {
            errors.push(format!(
                "[{file}] task#{index} done: ожидалось {}, получено {}",
                e.done, a.done
            ));
        }
        if a.due != e.due {
            errors.push(format!(
                "[{file}] task#{index} due: ожидалось {:?}, получено {:?}",
                e.due, a.due
            ));
        }
        let priority = a.priority.map(|p| p.as_str().to_string());
        if priority != e.priority {
            errors.push(format!(
                "[{file}] task#{index} priority: ожидалось {:?}, получено {priority:?}",
                e.priority
            ));
        }
        if a.every != e.every {
            errors.push(format!(
                "[{file}] task#{index} every: ожидалось {:?}, получено {:?}",
                e.every, a.every
            ));
        }
    }
}

fn check_file(vault: &Path, exp: &ExpectedFile, errors: &mut Vec<String>) {
    let file = &exp.file;
    let raw = match fs::read_to_string(vault.join(file)) {
        Ok(raw) => raw,
        Err(err) => {
            errors.push(format!("[{file}] не читается: {err}"));
            return;
        }
    };
    let note = match parser::parse_note(&raw) {
        Ok(note) => note,
        Err(err) => {
            errors.push(format!("[{file}] parse_note: {err}"));
            return;
        }
    };
    let fm = &note.frontmatter;
    if let Some(problem) = &note.frontmatter_error {
        errors.push(format!("[{file}] неожиданная ошибка frontmatter: {problem}"));
    }

    let id = fm.id.as_ref().map(|id| id.0.clone());
    if id != exp.id {
        errors.push(format!(
            "[{file}] id: ожидалось {:?}, получено {id:?}",
            exp.id
        ));
    }

    let note_type = fm
        .r#type
        .map(|t| t.as_str().to_string())
        .unwrap_or_else(|| "note".to_string());
    if note_type != exp.note_type {
        errors.push(format!(
            "[{file}] type: ожидалось {:?}, получено {note_type:?}",
            exp.note_type
        ));
    }

    let status = fm.status.map(|s| s.as_str().to_string()).or_else(|| {
        fm.extra
            .get("status")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    if status != exp.status {
        errors.push(format!(
            "[{file}] status: ожидалось {:?}, получено {status:?}",
            exp.status
        ));
    }

    let title = effective_title(file, fm.title.as_deref());
    if title != exp.title {
        errors.push(format!(
            "[{file}] title: ожидалось {:?}, получено {title:?}",
            exp.title
        ));
    }

    let note_id = NoteId(id.unwrap_or_default());
    let tasks = parser::extract_tasks(&note_id, &note.body).expect("extract_tasks");
    compare_tasks(file, &tasks, &exp.tasks, errors);

    let mut actual_links: Vec<(String, String, Option<String>)> = Vec::new();
    for rel in &note.rel_links {
        let form = parser::parse_wikilink(&rel.raw)
            .map(|link| form_of(&link))
            .unwrap_or_else(|| "raw".to_string());
        actual_links.push((rel.raw.clone(), form, Some(rel.rel_type.as_str().to_string())));
    }
    let body_links = parser::scan_wikilinks(&note.body);
    for link in &body_links {
        actual_links.push((link.raw.clone(), form_of(link), None));
    }
    let expected_links: Vec<(String, String, Option<String>)> = exp
        .links
        .iter()
        .map(|l| (l.raw.clone(), l.form.clone(), l.rel.clone()))
        .collect();
    if actual_links != expected_links {
        errors.push(format!(
            "[{file}] links:\n    ожидалось: {expected_links:?}\n    получено:  {actual_links:?}"
        ));
    }

    let edges = parser::extract_links(&note_id, &note.body).expect("extract_links");
    let edge_raws: Vec<&str> = edges.iter().map(|e| e.dst_raw.as_str()).collect();
    let scan_raws: Vec<&str> = body_links.iter().map(|l| l.raw.as_str()).collect();
    if edge_raws != scan_raws {
        errors.push(format!(
            "[{file}] LinkEdge.dst_raw расходится со сканом: {edge_raws:?} != {scan_raws:?}"
        ));
    }

    let headings: Vec<(u8, String)> = parser::extract_headings(&note.body)
        .expect("extract_headings")
        .into_iter()
        .map(|h| (h.level, h.text))
        .collect();
    let expected_headings: Vec<(u8, String)> = exp
        .headings
        .iter()
        .map(|h| (h.level, h.text.clone()))
        .collect();
    if headings != expected_headings {
        errors.push(format!(
            "[{file}] headings: ожидалось {expected_headings:?}, получено {headings:?}"
        ));
    }

    let mut tags: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for tag in fm
        .tags
        .iter()
        .cloned()
        .chain(parser::extract_tags(&note.body))
    {
        if seen.insert(parser::normalize_for_compare(&tag)) {
            tags.push(tag);
        }
    }
    if tags != exp.tags {
        errors.push(format!(
            "[{file}] tags: ожидалось {:?}, получено {tags:?}",
            exp.tags
        ));
    }
}

#[test]
fn golden_vault_matches_expected() {
    let fixtures = fixtures_dir();
    let expected: Expected = serde_json::from_str(
        &fs::read_to_string(fixtures.join("expected.json")).expect("expected.json читается"),
    )
    .expect("expected.json — валидный JSON");
    let vault = fixtures.join("vault");
    assert!(vault.is_dir(), "нет каталога фикстур: {}", vault.display());

    let mut errors: Vec<String> = Vec::new();

    let found = collect_note_files(&vault);
    let expected_files: BTreeSet<String> = expected.files.iter().map(|f| f.file.clone()).collect();
    for missing in expected_files.difference(&found) {
        errors.push(format!("[{missing}] описан в expected.json, но не найден при обходе"));
    }
    for extra in found.difference(&expected_files) {
        errors.push(format!("[{extra}] найден при обходе, но не описан в expected.json"));
    }
    for skipped in &expected.not_indexed {
        if found.contains(skipped) {
            errors.push(format!("[{skipped}] служебный путь попал в обход заметок"));
        }
    }

    for exp in &expected.files {
        check_file(&vault, exp, &mut errors);
    }

    assert!(
        errors.is_empty(),
        "расхождения с golden-ожиданиями ({}):\n{}",
        errors.len(),
        errors.join("\n")
    );
}
