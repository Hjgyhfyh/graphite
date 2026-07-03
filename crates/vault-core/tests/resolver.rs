use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::Connection;
use vault_core::indexer::Index;
use vault_core::resolver::{self, Fragment, ParsedRef};
use vault_core::{Anchor, LinkDirection, LinksGetParams, NoteId, NoteRef, RelType, VaultError};

const SCHEMA: &str = "
CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT,
    type TEXT,
    status TEXT,
    tags TEXT,
    props TEXT,
    updated TEXT,
    rev TEXT,
    children_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE blocks (
    note_id TEXT NOT NULL,
    anchor TEXT,
    heading_path TEXT,
    text TEXT,
    pos INTEGER NOT NULL
);
CREATE TABLE links (
    src_id TEXT NOT NULL,
    dst_id TEXT,
    dst_raw TEXT NOT NULL,
    rel_type TEXT,
    block TEXT,
    context TEXT
);
";

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

fn note_id(n: u32) -> String {
    format!("01TEST{n:020}")
}

fn nid(n: u32) -> NoteId {
    NoteId(note_id(n))
}

fn rid(n: u32) -> NoteRef {
    NoteRef(format!("id:{}", note_id(n)))
}

struct TempVault {
    root: PathBuf,
    index: Index,
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn unique_temp_dir() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "graphite-resolver-{}-{nanos}-{seq}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn vault_files() -> Vec<(String, String)> {
    vec![
        (
            "Проекты/_index.md".to_string(),
            format!(
                "---\nid: {}\n---\n# Проекты\n\nКорневой раздел проектов.\n",
                note_id(1)
            ),
        ),
        (
            "Проекты/Приложение заметок/_index.md".to_string(),
            format!(
                "---\nid: {}\ntype: project\ntitle: Приложение заметок\nstatus: active\n---\n# Приложение заметок\n\nПроект локального приложения.\n",
                note_id(2)
            ),
        ),
        (
            "Проекты/Приложение заметок/Идеи/Тёмная тема.md".to_string(),
            format!(
                "---\nid: {}\ntype: note\ntitle: Тёмная тема\naliases: [dark-mode]\ntags: [дизайн, mvp]\nstatus: planned\n---\n# Тёмная тема\n\nНочной режим, чтобы глаза жили дольше.\n\n## Палитра\n\nФон почти чёрный, текст тёплый. ^b3k9q\n\n## Триггеры\n\nАвтопереключение по времени суток.\n",
                note_id(3)
            ),
        ),
        (
            "Проекты/Приложение заметок/Идеи/Ёжик в тумане.md".to_string(),
            format!(
                "---\nid: {}\n---\nЗаметка, чьё имя различается только буквой ё.\n",
                note_id(4)
            ),
        ),
        (
            "Проекты/Приложение заметок/План MVP.md".to_string(),
            format!(
                "---\nid: {}\ntype: plan\ntitle: План MVP\ngoal: собрать минимальную версию\nrel:\n  part_of: [\"[[Приложение заметок]]\"]\n---\n# План MVP\n\nЧерновик плана.\n",
                note_id(5)
            ),
        ),
        (
            "Связи/Цель с алиасами.md".to_string(),
            format!(
                "---\nid: {}\ntitle: Цель с алиасами\naliases: [поисковый-mvp, цель]\nstatus: shaping\n---\n# Цель с алиасами\n\nМишень для проверки резолвинга.\n\n## Секция вторая\n\nАбзац с блочным якорем. ^q7w8e\n\nПервое вхождение дубликата. ^dup\nВторое вхождение дубликата. ^dup\n",
                note_id(6)
            ),
        ),
        (
            "Планы/Цель.md".to_string(),
            format!(
                "---\nid: {}\n---\nФайл, чей заголовок берётся из имени файла.\n",
                note_id(7)
            ),
        ),
        (
            "Дубли/Первый дубль.md".to_string(),
            format!(
                "---\nid: {}\ntitle: Дубль\naliases: [омоним]\n---\nПервый носитель неуникального заголовка.\n",
                note_id(8)
            ),
        ),
        (
            "Дубли/Второй дубль.md".to_string(),
            format!(
                "---\nid: {}\ntitle: Дубль\naliases: [омоним]\n---\nВторой носитель неуникального заголовка.\n",
                note_id(9)
            ),
        ),
        (
            "Связи/Все формы ссылок.md".to_string(),
            format!(
                "---\nid: {id10}\ntitle: Все формы ссылок\nstatus: shaping\n---\n# Все формы ссылок\n\nПростая: [[Тёмная тема]]\nНа секцию: [[Тёмная тема#Палитра]]\nНа блок: [[Тёмная тема#^b3k9q]]\nС заменой текста: [[Тёмная тема|как красят тьму]]\nПо id: [[id:{id3}|та же тема по id]]\nПо алиасу: [[поисковый-mvp]]\nПо пути: [[Проекты/Приложение заметок/План MVP|план по пути]]\nПо пути с расширением: [[Проекты/Приложение заметок/Идеи/Ёжик в тумане.md]]\nПо пути папки: [[Проекты/Приложение заметок]]\nСекция с текстом: [[Цель с алиасами#Секция вторая|про вторую секцию]]\nЭмбед: ![[Ёжик в тумане]]\n\n| Ссылка | Комментарий |\n| --- | --- |\n| [[Ёжик в тумане\\|ёж]] | разделитель экранирован для таблицы |\n\nБитая: [[Несуществующая заметка]]\nБитая по пути: [[Архив/Цель с алиасами]]\nБитая по алиасу в пути: [[Архив/поисковый-mvp]]\nНеоднозначная: [[Дубль]]\nБитая id-форма: [[id:{id99}]]\n",
                id10 = note_id(10),
                id3 = note_id(3),
                id99 = note_id(99)
            ),
        ),
        (
            "Связи/Ссылки с ё и регистром.md".to_string(),
            format!(
                "---\nid: {}\ntitle: Ссылки с ё и регистром\n---\n# Нормализация при резолвинге\n\nЧерез е: [[Ежик в тумане]]\nКапсом: [[ТЁМНАЯ ТЕМА]]\nС пробелами: [[ Тёмная тема ]]\nПёстрый регистр: [[тЁмНаЯ тЕмА|регистр не важен]]\nРазложенная ё: [[Е\u{0308}жик в тумане]]\n",
                note_id(11)
            ),
        ),
    ]
}

fn build_vault() -> TempVault {
    let root = unique_temp_dir();
    for (rel, content) in vault_files() {
        let path = root.join(&rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content.replace("\r\n", "\n")).unwrap();
    }
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    let vault = TempVault {
        root,
        index: Index { conn },
    };
    index_vault(&vault);
    vault
}

fn index_vault(vault: &TempVault) {
    let mut files = Vec::new();
    collect_md(&vault.root, &mut files);
    let mut pending = Vec::new();
    for path in files {
        let raw = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
        let rel = path
            .strip_prefix(&vault.root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let (fm, body, body_offset) = split_note(&raw);
        let id = fm_str(&fm, "id").unwrap();
        let rev = blake3::hash(raw.as_bytes()).to_hex()[..16].to_string();
        let props = serde_json::json!({ "aliases": fm_list(&fm, "aliases") }).to_string();
        let tags = serde_json::to_string(&fm_list(&fm, "tags")).unwrap();
        vault
            .index
            .conn
            .execute(
                "INSERT INTO notes (id, path, title, type, status, tags, props, updated, rev, children_count) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)",
                rusqlite::params![
                    id,
                    rel,
                    fm_str(&fm, "title"),
                    fm_str(&fm, "type"),
                    fm_str(&fm, "status"),
                    tags,
                    props,
                    "2026-07-03T12:00:00+03:00",
                    rev
                ],
            )
            .unwrap();
        for block in scan_blocks(body, body_offset) {
            vault
                .index
                .conn
                .execute(
                    "INSERT INTO blocks (note_id, anchor, heading_path, text, pos) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        id,
                        block.anchor,
                        serde_json::to_string(&block.heading_path).unwrap(),
                        block.text,
                        block.pos
                    ],
                )
                .unwrap();
        }
        pending.push((id, body.to_string(), fm_rel(&fm)));
    }
    for (src, body, rels) in pending {
        let src_id = NoteId(src);
        for raw in scan_wikilinks(&body) {
            insert_link(vault, &src_id, &raw, "related");
        }
        for (rel_type, raw) in rels {
            insert_link(vault, &src_id, &raw, &rel_type);
        }
    }
}

fn insert_link(vault: &TempVault, src: &NoteId, raw: &str, rel_type: &str) {
    let dst = match resolver::resolve_wikilink(&vault.index, src, raw) {
        Ok(found) => found.map(|id| id.0),
        Err(VaultError::Ambiguous { .. }) => None,
        Err(err) => panic!("резолв {raw}: {err}"),
    };
    vault
        .index
        .conn
        .execute(
            "INSERT INTO links (src_id, dst_id, dst_raw, rel_type) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![src.0, dst, raw, rel_type],
        )
        .unwrap();
}

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if path.is_dir() {
            if !name.starts_with('.') && name != "_assets" {
                collect_md(&path, out);
            }
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }
}

fn split_note(raw: &str) -> (serde_json::Value, &str, usize) {
    let after = raw.strip_prefix("---\n").unwrap();
    let (yaml, body) = after.split_once("\n---\n").unwrap();
    let fm: serde_json::Value = serde_yml::from_str(yaml).unwrap();
    (fm, body, raw.len() - body.len())
}

fn fm_str(fm: &serde_json::Value, key: &str) -> Option<String> {
    fm.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn fm_list(fm: &serde_json::Value, key: &str) -> Vec<String> {
    fm.get(key)
        .and_then(|v| v.as_array())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn fm_rel(fm: &serde_json::Value) -> Vec<(String, String)> {
    let Some(mapping) = fm.get("rel").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (rel_type, values) in mapping {
        let Some(seq) = values.as_array() else { continue };
        for value in seq {
            if let Some(raw) = value.as_str() {
                out.push((rel_type.clone(), raw.to_string()));
            }
        }
    }
    out
}

struct ScannedBlock {
    anchor: Option<String>,
    heading_path: Vec<String>,
    text: String,
    pos: u32,
}

fn scan_blocks(body: &str, body_offset: usize) -> Vec<ScannedBlock> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut blocks = Vec::new();
    let mut offset = body_offset;
    for line in body.split_inclusive('\n') {
        let pos = offset as u32;
        offset += line.len();
        let content = line.trim_end_matches(['\n', '\r']);
        let hashes = content.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) {
            if let Some(text) = content[hashes..].strip_prefix(' ') {
                let text = text.trim().to_string();
                while stack.last().is_some_and(|(level, _)| *level >= hashes) {
                    stack.pop();
                }
                stack.push((hashes, text.clone()));
                blocks.push(ScannedBlock {
                    anchor: None,
                    heading_path: stack.iter().map(|(_, t)| t.clone()).collect(),
                    text,
                    pos,
                });
                continue;
            }
        }
        if let Some((head, tail)) = content.trim_end().rsplit_once(' ') {
            if let Some(bare) = tail.strip_prefix('^') {
                if !bare.is_empty()
                    && bare
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                {
                    blocks.push(ScannedBlock {
                        anchor: Some(bare.to_string()),
                        heading_path: stack.iter().map(|(_, t)| t.clone()).collect(),
                        text: head.trim_end().to_string(),
                        pos,
                    });
                }
            }
        }
    }
    blocks
}

fn scan_wikilinks(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(found) = body[cursor..].find("[[") {
        let start = cursor + found;
        let Some(len) = body[start..].find("]]") else {
            break;
        };
        let end = start + len + 2;
        let from = if start > 0 && bytes[start - 1] == b'!' {
            start - 1
        } else {
            start
        };
        out.push(body[from..end].to_string());
        cursor = end;
    }
    out
}

#[test]
fn normalize_key_applies_nfc_casefold_yo_and_trim() {
    assert_eq!(resolver::normalize_key("  Тёмная Тема  "), "темная тема");
    assert_eq!(resolver::normalize_key("Е\u{0308}ЛКА"), "елка");
    assert_eq!(resolver::normalize_key("ЁЖИК"), "ежик");
    assert_eq!(resolver::normalize_key("Dark-Mode"), "dark-mode");
    assert_eq!(resolver::normalize_key("   "), "");
}

#[test]
fn parse_ref_accepts_canonical_forms_and_rejects_garbage() {
    let parsed = resolver::parse_ref(&NoteRef(format!("id:{}", note_id(3).to_lowercase()))).unwrap();
    assert_eq!(parsed, ParsedRef::Id(nid(3)));
    let parsed =
        resolver::parse_ref(&NoteRef("path:Проекты\\Приложение заметок\\План MVP.md".into()))
            .unwrap();
    assert_eq!(
        parsed,
        ParsedRef::Path("Проекты/Приложение заметок/План MVP.md".into())
    );
    assert!(matches!(
        resolver::parse_ref(&NoteRef("Тёмная тема".into())),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::parse_ref(&NoteRef("id:NOT-A-ULID".into())),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::parse_ref(&NoteRef("id:01TESTI0000000000000000000".into())),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::parse_ref(&NoteRef("path:../секрет.md".into())),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::parse_ref(&NoteRef("path:".into())),
        Err(VaultError::Validation(_))
    ));
}

#[test]
fn parse_wikilink_target_covers_all_forms() {
    let t = resolver::parse_wikilink_target("[[Тёмная тема]]");
    assert_eq!(t.target, "Тёмная тема");
    assert_eq!(t.fragment, None);
    assert_eq!(t.display, None);

    let t = resolver::parse_wikilink_target("[[Тёмная тема#Палитра]]");
    assert_eq!(t.target, "Тёмная тема");
    assert_eq!(t.fragment, Some(Fragment::Section("Палитра".into())));

    let t = resolver::parse_wikilink_target("[[Тёмная тема#^b3k9q]]");
    assert_eq!(t.fragment, Some(Fragment::Anchor(Anchor("b3k9q".into()))));

    let t = resolver::parse_wikilink_target("[[Тёмная тема|как красят тьму]]");
    assert_eq!(t.target, "Тёмная тема");
    assert_eq!(t.display, Some("как красят тьму".into()));

    let t = resolver::parse_wikilink_target("[[Цель с алиасами#Секция вторая|про вторую]]");
    assert_eq!(t.target, "Цель с алиасами");
    assert_eq!(t.fragment, Some(Fragment::Section("Секция вторая".into())));
    assert_eq!(t.display, Some("про вторую".into()));

    let t = resolver::parse_wikilink_target(&format!("[[id:{}|текст]]", note_id(3)));
    assert_eq!(t.target, format!("id:{}", note_id(3)));
    assert_eq!(t.display, Some("текст".into()));

    let t = resolver::parse_wikilink_target("![[Ёжик в тумане]]");
    assert_eq!(t.target, "Ёжик в тумане");

    let t = resolver::parse_wikilink_target(r"[[Ёжик в тумане\|ёж]]");
    assert_eq!(t.target, "Ёжик в тумане");
    assert_eq!(t.display, Some("ёж".into()));

    let t = resolver::parse_wikilink_target("[[#Палитра]]");
    assert_eq!(t.target, "");
    assert_eq!(t.fragment, Some(Fragment::Section("Палитра".into())));

    let t = resolver::parse_wikilink_target("[[Тёмная тема#]]");
    assert_eq!(t.target, "Тёмная тема");
    assert_eq!(t.fragment, None);
}

#[test]
fn resolve_ref_walks_ladder_and_handles_index_folders() {
    let v = build_vault();
    let meta = resolver::resolve(&v.index, &NoteRef(format!("id:{}", note_id(3).to_lowercase())))
        .unwrap();
    assert_eq!(meta.id, nid(3));
    assert_eq!(meta.path, "Проекты/Приложение заметок/Идеи/Тёмная тема.md");
    assert_eq!(meta.title, "Тёмная тема");

    let meta = resolver::resolve(
        &v.index,
        &NoteRef("path:Проекты/Приложение заметок/План MVP.md".into()),
    )
    .unwrap();
    assert_eq!(meta.id, nid(5));

    let meta = resolver::resolve(
        &v.index,
        &NoteRef("path:Проекты/Приложение заметок/План MVP".into()),
    )
    .unwrap();
    assert_eq!(meta.id, nid(5));

    let meta = resolver::resolve(&v.index, &NoteRef("path:Проекты/Приложение заметок".into()))
        .unwrap();
    assert_eq!(meta.id, nid(2));
    assert_eq!(meta.path, "Проекты/Приложение заметок/_index.md");

    let meta = resolver::resolve(&v.index, &NoteRef("path:Проекты".into())).unwrap();
    assert_eq!(meta.id, nid(1));
    assert_eq!(meta.title, "Проекты");

    let meta = resolver::resolve(&v.index, &NoteRef("Тёмная тема".into())).unwrap();
    assert_eq!(meta.id, nid(3));

    let meta = resolver::resolve(&v.index, &NoteRef("поисковый-mvp".into())).unwrap();
    assert_eq!(meta.id, nid(6));

    let meta = resolver::resolve(&v.index, &NoteRef("Цель".into())).unwrap();
    assert_eq!(meta.id, nid(7));

    let meta = resolver::resolve(
        &v.index,
        &NoteRef("Проекты/Приложение заметок/Идеи/Ёжик в тумане".into()),
    )
    .unwrap();
    assert_eq!(meta.id, nid(4));

    assert!(matches!(
        resolver::resolve(&v.index, &NoteRef(format!("id:{}", note_id(99)))),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        resolver::resolve(&v.index, &NoteRef("path:Нет/Такой.md".into())),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        resolver::resolve(&v.index, &NoteRef("Никто не знает".into())),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        resolver::resolve(&v.index, &NoteRef("".into())),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::resolve(&v.index, &NoteRef("Дубль".into())),
        Err(VaultError::Ambiguous { .. })
    ));
}

#[test]
fn resolve_wikilink_covers_all_forms_from_format() {
    let v = build_vault();
    let cases: Vec<(String, Option<u32>)> = vec![
        ("[[Тёмная тема]]".into(), Some(3)),
        ("[[Тёмная тема#Палитра]]".into(), Some(3)),
        ("[[Тёмная тема#^b3k9q]]".into(), Some(3)),
        ("[[Тёмная тема|как красят тьму]]".into(), Some(3)),
        (format!("[[id:{}|та же тема по id]]", note_id(3)), Some(3)),
        (format!("[[id:{}]]", note_id(3).to_lowercase()), Some(3)),
        ("[[поисковый-mvp]]".into(), Some(6)),
        (
            "[[Проекты/Приложение заметок/План MVP|план по пути]]".into(),
            Some(5),
        ),
        (
            "[[Проекты/Приложение заметок/Идеи/Ёжик в тумане.md]]".into(),
            Some(4),
        ),
        ("[[Проекты/Приложение заметок]]".into(), Some(2)),
        ("![[Ёжик в тумане]]".into(), Some(4)),
        (r"[[Ёжик в тумане\|ёж]]".into(), Some(4)),
        ("[[Цель]]".into(), Some(7)),
        ("[[Первый дубль]]".into(), Some(8)),
        ("[[Несуществующая заметка]]".into(), None),
        ("[[Архив/Цель с алиасами]]".into(), None),
        (format!("[[id:{}]]", note_id(99)), None),
        ("[[id:мусор]]".into(), None),
        ("[[]]".into(), None),
    ];
    for (raw, expected) in cases {
        let got = resolver::resolve_wikilink(&v.index, &nid(10), &raw).unwrap();
        assert_eq!(got, expected.map(nid), "цель: {raw}");
    }
    let self_link = resolver::resolve_wikilink(&v.index, &nid(3), "[[#Палитра]]").unwrap();
    assert_eq!(self_link, Some(nid(3)));
}

#[test]
fn yo_e_equivalence_and_unicode_forms_resolve_same_note() {
    let v = build_vault();
    for raw in [
        "[[Ёжик в тумане]]",
        "[[Ежик в тумане]]",
        "[[ЕЖИК В ТУМАНЕ]]",
        "[[Е\u{0308}жик в тумане]]",
        "[[ Ёжик в тумане ]]",
    ] {
        let got = resolver::resolve_wikilink(&v.index, &nid(11), raw).unwrap();
        assert_eq!(got, Some(nid(4)), "цель: {raw}");
    }
    for raw in ["[[ТЁМНАЯ ТЕМА]]", "[[тЁмНаЯ тЕмА|регистр не важен]]", "[[Темная тема]]"] {
        let got = resolver::resolve_wikilink(&v.index, &nid(11), raw).unwrap();
        assert_eq!(got, Some(nid(3)), "цель: {raw}");
    }
    let meta = resolver::resolve(&v.index, &NoteRef("ежик в тумане".into())).unwrap();
    assert_eq!(meta.id, nid(4));
}

#[test]
fn ambiguous_targets_return_candidates_with_ref_path_title() {
    let v = build_vault();
    let err = resolver::resolve_wikilink(&v.index, &nid(10), "[[Дубль]]").unwrap_err();
    match err {
        VaultError::Ambiguous { ref_, candidates } => {
            assert_eq!(ref_, "[[Дубль]]");
            assert_eq!(candidates.len(), 2);
            assert_eq!(candidates[0].path, "Дубли/Второй дубль.md");
            assert_eq!(candidates[1].path, "Дубли/Первый дубль.md");
            assert!(candidates.iter().all(|c| c.title == "Дубль"));
            assert!(candidates.iter().any(|c| c.id == nid(8)));
            assert!(candidates.iter().any(|c| c.id == nid(9)));
        }
        other => panic!("ожидался Ambiguous, получено {other:?}"),
    }
    let err = resolver::resolve_wikilink(&v.index, &nid(10), "[[омоним]]").unwrap_err();
    match err {
        VaultError::Ambiguous { candidates, .. } => assert_eq!(candidates.len(), 2),
        other => panic!("ожидался Ambiguous, получено {other:?}"),
    }
    let unique = resolver::resolve_wikilink(&v.index, &nid(10), "[[цель]]").unwrap();
    assert_eq!(unique, Some(nid(7)));
}

#[test]
fn sections_and_anchors_resolve_inside_note() {
    let v = build_vault();
    let block = resolver::resolve_section(&v.index, &nid(3), "ПАЛИТРА").unwrap();
    assert_eq!(block.heading_path, vec!["Тёмная тема", "Палитра"]);
    assert_eq!(block.text, "Палитра");
    assert_eq!(block.anchor, None);

    let block = resolver::resolve_section(&v.index, &nid(6), "секция вторая").unwrap();
    assert_eq!(block.heading_path, vec!["Цель с алиасами", "Секция вторая"]);

    let block = resolver::resolve_anchor(&v.index, &nid(3), "^b3k9q").unwrap();
    assert_eq!(block.anchor, Some(Anchor("b3k9q".into())));
    assert_eq!(block.text, "Фон почти чёрный, текст тёплый.");
    assert_eq!(block.heading_path, vec!["Тёмная тема", "Палитра"]);
    let same = resolver::resolve_anchor(&v.index, &nid(3), "b3k9q").unwrap();
    assert_eq!(same.pos, block.pos);

    let first = resolver::resolve_anchor(&v.index, &nid(6), "dup").unwrap();
    assert_eq!(first.text, "Первое вхождение дубликата.");

    let parsed = resolver::parse_wikilink_target("[[Тёмная тема#^b3k9q]]");
    let target = resolver::resolve_wikilink(&v.index, &nid(10), "[[Тёмная тема#^b3k9q]]")
        .unwrap()
        .unwrap();
    let via_fragment =
        resolver::resolve_fragment(&v.index, &target, parsed.fragment.as_ref().unwrap()).unwrap();
    assert_eq!(via_fragment.anchor, Some(Anchor("b3k9q".into())));

    assert!(matches!(
        resolver::resolve_section(&v.index, &nid(3), "Нет такой"),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        resolver::resolve_section(&v.index, &nid(3), "   "),
        Err(VaultError::Validation(_))
    ));
    assert!(matches!(
        resolver::resolve_anchor(&v.index, &nid(3), "zzz9"),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        resolver::resolve_anchor(&v.index, &nid(3), "^"),
        Err(VaultError::Validation(_))
    ));
}

#[test]
fn outgoing_and_backlinks_read_links_table() {
    let v = build_vault();
    let out = resolver::outgoing(&v.index, &nid(10)).unwrap();
    assert_eq!(out.len(), 17);
    assert!(out.iter().all(|e| e.src_id == nid(10)));
    assert_eq!(out.iter().filter(|e| e.dst_id.is_none()).count(), 5);
    assert_eq!(out[0].dst_raw, "[[Тёмная тема]]");
    assert!(out
        .iter()
        .any(|e| e.dst_raw == r"[[Ёжик в тумане\|ёж]]" && e.dst_id == Some(nid(4))));

    let back = resolver::backlinks(&v.index, &nid(3)).unwrap();
    assert_eq!(back.len(), 8);
    assert!(back.iter().all(|e| e.dst_id == Some(nid(3))));
    let sources: std::collections::HashSet<String> =
        back.iter().map(|e| e.src_id.0.clone()).collect();
    assert_eq!(
        sources,
        std::collections::HashSet::from([note_id(10), note_id(11)])
    );

    assert_eq!(resolver::backlinks(&v.index, &nid(4)).unwrap().len(), 5);
    assert_eq!(resolver::backlinks(&v.index, &nid(6)).unwrap().len(), 2);
    assert_eq!(resolver::backlinks(&v.index, &nid(5)).unwrap().len(), 1);

    let back2 = resolver::backlinks(&v.index, &nid(2)).unwrap();
    assert_eq!(back2.len(), 2);
    assert!(back2
        .iter()
        .any(|e| e.src_id == nid(5) && e.rel_type == RelType::PartOf));
    assert!(back2
        .iter()
        .any(|e| e.src_id == nid(10) && e.rel_type == RelType::Related));
}

#[test]
fn links_get_filters_direction_and_types_and_skips_broken() {
    let v = build_vault();
    let resp = resolver::links_get(
        &v.index,
        &LinksGetParams {
            r#ref: rid(5),
            direction: None,
            types: None,
        },
    )
    .unwrap();
    assert_eq!(resp.out.len(), 1);
    assert_eq!(resp.out[0].to, rid(2));
    assert_eq!(resp.out[0].r#type, RelType::PartOf);
    assert_eq!(resp.r#in.len(), 1);
    assert_eq!(resp.r#in[0].from, rid(10));

    let resp = resolver::links_get(
        &v.index,
        &LinksGetParams {
            r#ref: rid(5),
            direction: Some(LinkDirection::Out),
            types: None,
        },
    )
    .unwrap();
    assert_eq!(resp.out.len(), 1);
    assert!(resp.r#in.is_empty());

    let resp = resolver::links_get(
        &v.index,
        &LinksGetParams {
            r#ref: rid(2),
            direction: Some(LinkDirection::In),
            types: Some(vec![RelType::PartOf]),
        },
    )
    .unwrap();
    assert!(resp.out.is_empty());
    assert_eq!(resp.r#in.len(), 1);
    assert_eq!(resp.r#in[0].from, rid(5));
    assert_eq!(resp.r#in[0].r#type, RelType::PartOf);

    let resp = resolver::links_get(
        &v.index,
        &LinksGetParams {
            r#ref: NoteRef("path:Связи/Все формы ссылок.md".into()),
            direction: None,
            types: None,
        },
    )
    .unwrap();
    assert_eq!(resp.out.len(), 12);
    assert!(resp.out.iter().all(|o| o.to.0.starts_with("id:")));

    assert!(matches!(
        resolver::links_get(
            &v.index,
            &LinksGetParams {
                r#ref: NoteRef(format!("id:{}", note_id(99))),
                direction: None,
                types: None,
            },
        ),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn broken_links_report_lists_unresolved_with_repair_candidates() {
    let v = build_vault();
    let report = resolver::broken_links(&v.index).unwrap();
    assert_eq!(report.len(), 5);
    assert!(report
        .iter()
        .all(|b| b.edge.dst_id.is_none() && b.src_path == "Связи/Все формы ссылок.md"));
    assert!(report.windows(2).all(|w| {
        (w[0].src_path.as_str(), w[0].edge.dst_raw.as_str())
            <= (w[1].src_path.as_str(), w[1].edge.dst_raw.as_str())
    }));

    let by_raw: HashMap<&str, &resolver::BrokenLink> = report
        .iter()
        .map(|b| (b.edge.dst_raw.as_str(), b))
        .collect();

    let by_title = by_raw["[[Архив/Цель с алиасами]]"];
    assert_eq!(by_title.candidates.len(), 1);
    assert_eq!(by_title.candidates[0].path, "Связи/Цель с алиасами.md");

    let by_alias = by_raw["[[Архив/поисковый-mvp]]"];
    assert_eq!(by_alias.candidates.len(), 1);
    assert_eq!(by_alias.candidates[0].id, nid(6));

    let ambiguous = by_raw["[[Дубль]]"];
    assert_eq!(ambiguous.candidates.len(), 2);
    assert_eq!(ambiguous.candidates[0].path, "Дубли/Второй дубль.md");
    assert_eq!(ambiguous.candidates[1].path, "Дубли/Первый дубль.md");

    assert!(by_raw["[[Несуществующая заметка]]"].candidates.is_empty());
    let broken_id = format!("[[id:{}]]", note_id(99));
    assert!(by_raw[broken_id.as_str()].candidates.is_empty());

    let serialized = serde_json::to_value(&report[0]).unwrap();
    assert!(serialized.get("srcPath").is_some());
    assert!(serialized.get("edge").is_some());
    assert!(serialized.get("candidates").is_some());
}
