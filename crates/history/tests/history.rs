use std::path::{Path, PathBuf};

use history::journal::{activity, list};
use history::{
    append_op, labeled_hash, mark_undone, new_op_id, now_ts, read_op, read_ops, snapshot,
    undo_plan, undo_session_plan, Actor, FileChange, JournalFilter, JournalOp,
};
use rpc::types::{ActivityGetParams, ActorFilter, NoteRef};

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("graphite-history-{tag}-{}", new_op_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn make_op(
    op_id: &str,
    ts: &str,
    actor: Actor,
    session: Option<&str>,
    files: &[(&str, Option<&str>, Option<&str>)],
) -> JournalOp {
    JournalOp {
        op_id: op_id.to_string(),
        ts: ts.to_string(),
        actor,
        session: session.map(str::to_string),
        tool: Some("note_edit".to_string()),
        summary: format!("op {op_id}"),
        files: files
            .iter()
            .map(|(path, before, after)| FileChange {
                path: (*path).to_string(),
                before: before.map(str::to_string),
                after: after.map(str::to_string),
            })
            .collect(),
        undone: false,
    }
}

fn ids(ops: &[JournalOp]) -> Vec<&str> {
    ops.iter().map(|op| op.op_id.as_str()).collect()
}

fn seed_journal(journal_dir: &Path) {
    let ops = [
        make_op(
            "OP-A",
            "2026-06-10T10:00:00+03:00",
            Actor::User,
            None,
            &[("Проекты/A.md", None, Some("blake3:aa"))],
        ),
        make_op(
            "OP-B",
            "2026-07-01T09:00:00+03:00",
            Actor::Assistant,
            Some("mcp-S1"),
            &[
                ("Проекты/A.md", Some("blake3:aa"), Some("blake3:bb")),
                ("Заметки/B.md", None, Some("blake3:cc")),
            ],
        ),
        make_op(
            "OP-C",
            "2026-07-02T12:00:00Z",
            Actor::External,
            None,
            &[("Проекты2/C.md", Some("blake3:dd"), Some("blake3:ee"))],
        ),
        make_op(
            "OP-D",
            "2026-07-03T08:00:00+03:00",
            Actor::Assistant,
            Some("mcp-S1"),
            &[("Заметки/B.md", Some("blake3:cc"), Some("blake3:ff"))],
        ),
    ];
    for op in &ops {
        append_op(journal_dir, op).unwrap();
    }
}

#[test]
fn journal_append_and_filtered_reads() {
    let tmp = TempDir::new("journal");
    let journal_dir = tmp.path().join("journal");
    seed_journal(&journal_dir);

    assert!(journal_dir.join("2026-06.jsonl").is_file());
    assert!(journal_dir.join("2026-07.jsonl").is_file());

    let all = read_ops(&journal_dir, &JournalFilter::default()).unwrap();
    assert_eq!(ids(&all), ["OP-D", "OP-C", "OP-B", "OP-A"]);

    let since = read_ops(
        &journal_dir,
        &JournalFilter {
            since: Some("2026-07-01T00:00:00Z".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&since), ["OP-D", "OP-C", "OP-B"]);

    let offset_aware = read_ops(
        &journal_dir,
        &JournalFilter {
            since: Some("2026-07-03T06:00:00Z".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(ids(&offset_aware).is_empty());

    let offset_aware = read_ops(
        &journal_dir,
        &JournalFilter {
            since: Some("2026-07-03T04:00:00Z".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&offset_aware), ["OP-D"]);

    let scoped = read_ops(
        &journal_dir,
        &JournalFilter {
            scope: Some("Проекты".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&scoped), ["OP-B", "OP-A"]);

    let scoped_file = read_ops(
        &journal_dir,
        &JournalFilter {
            scope: Some("path:Заметки/B.md".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&scoped_file), ["OP-D", "OP-B"]);

    let by_actor = read_ops(
        &journal_dir,
        &JournalFilter {
            actor: Some(Actor::Assistant),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&by_actor), ["OP-D", "OP-B"]);

    let combined = read_ops(
        &journal_dir,
        &JournalFilter {
            scope: Some("Проекты".into()),
            actor: Some(Actor::User),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&combined), ["OP-A"]);

    let limited = read_ops(
        &journal_dir,
        &JournalFilter {
            limit: Some(2),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&limited), ["OP-D", "OP-C"]);

    assert!(matches!(
        read_ops(
            &journal_dir,
            &JournalFilter {
                since: Some("никогда".into()),
                ..Default::default()
            }
        ),
        Err(history::HistoryError::Invalid(_))
    ));
}

#[test]
fn journal_reads_from_end_across_chunks_and_skips_garbage() {
    let tmp = TempDir::new("bulk");
    let journal_dir = tmp.path().join("journal");
    std::fs::create_dir_all(&journal_dir).unwrap();

    let filler = "х".repeat(90);
    let mut content = String::new();
    for i in 0..1500u32 {
        let op = make_op(
            &format!("BULK-{i:04}"),
            &format!(
                "2026-05-01T{:02}:{:02}:{:02}Z",
                i / 3600,
                (i / 60) % 60,
                i % 60
            ),
            Actor::User,
            None,
            &[(format!("Проекты/{filler}.md").as_str(), None, Some("blake3:aa"))],
        );
        content.push_str(&serde_json::to_string(&op).unwrap());
        content.push('\n');
    }
    content.push_str("{ оборванная запись\n");
    content.push('\n');
    let last = make_op(
        "BULK-LAST",
        "2026-05-01T23:00:00Z",
        Actor::User,
        None,
        &[("Проекты/last.md", None, Some("blake3:aa"))],
    );
    content.push_str(&serde_json::to_string(&last).unwrap());
    std::fs::write(journal_dir.join("2026-05.jsonl"), content).unwrap();

    let top = read_ops(
        &journal_dir,
        &JournalFilter {
            limit: Some(3),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&top), ["BULK-LAST", "BULK-1499", "BULK-1498"]);

    let all = read_ops(
        &journal_dir,
        &JournalFilter {
            limit: Some(5000),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(all.len(), 1501);
    assert_eq!(all.first().unwrap().op_id, "BULK-LAST");
    assert_eq!(all.last().unwrap().op_id, "BULK-0000");
}

#[test]
fn journal_relative_since_and_undone_flag() {
    let tmp = TempDir::new("undone");
    let journal_dir = tmp.path().join("journal");
    let old = make_op(
        "OP-OLD",
        "2020-01-01T00:00:00Z",
        Actor::User,
        None,
        &[("Старое.md", None, Some("blake3:aa"))],
    );
    let fresh = make_op(
        "OP-FRESH",
        &now_ts(),
        Actor::Assistant,
        Some("mcp-S2"),
        &[("Свежее.md", None, Some("blake3:bb"))],
    );
    append_op(&journal_dir, &old).unwrap();
    append_op(&journal_dir, &fresh).unwrap();

    let recent = read_ops(
        &journal_dir,
        &JournalFilter {
            since: Some("-7d".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&recent), ["OP-FRESH"]);

    let marked = mark_undone(&journal_dir, "OP-OLD", true).unwrap();
    assert!(marked.undone);
    assert!(read_op(&journal_dir, "OP-OLD").unwrap().undone);
    let again = mark_undone(&journal_dir, "OP-OLD", true).unwrap();
    assert!(again.undone);

    let month = std::fs::read_to_string(journal_dir.join("2020-01.jsonl")).unwrap();
    let lines: Vec<&str> = month.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 1);
    let reread: JournalOp = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(reread.op_id, "OP-OLD");
    assert!(reread.undone);

    let reverted = mark_undone(&journal_dir, "OP-OLD", false).unwrap();
    assert!(!reverted.undone);
    assert!(matches!(
        mark_undone(&journal_dir, "OP-NONE", true),
        Err(history::HistoryError::NotFound(_))
    ));

    let all = read_ops(&journal_dir, &JournalFilter::default()).unwrap();
    assert_eq!(ids(&all), ["OP-FRESH", "OP-OLD"]);
}

#[test]
fn snapshot_round_trip_dedup_and_integrity() {
    let tmp = TempDir::new("snapshot");
    let objects = tmp.path().join("objects");

    let c1 = "# Заметка\nтело заметки\n".repeat(50).into_bytes();
    let h1 = snapshot::put(&objects, &c1).unwrap();
    assert_eq!(h1, snapshot::hash_hex(&c1));
    assert_eq!(labeled_hash(&c1), format!("blake3:{h1}"));

    let object_file = objects.join(&h1[0..2]).join(&h1);
    assert!(object_file.is_file());
    let on_disk = std::fs::read(&object_file).unwrap();
    assert_ne!(on_disk, c1);
    assert!(on_disk.len() < c1.len());

    assert_eq!(snapshot::get(&objects, &h1).unwrap(), c1);
    assert_eq!(
        snapshot::get(&objects, &format!("blake3:{h1}")).unwrap(),
        c1
    );

    let h1_again = snapshot::put(&objects, &c1).unwrap();
    assert_eq!(h1_again, h1);
    assert_eq!(std::fs::read_dir(objects.join(&h1[0..2])).unwrap().count(), 1);

    let c2 = "другое содержимое".as_bytes().to_vec();
    let h2 = snapshot::put(&objects, &c2).unwrap();
    assert_ne!(h2, h1);
    assert_eq!(snapshot::get(&objects, &h2).unwrap(), c2);

    assert!(snapshot::exists(&objects, &h1).unwrap());
    let absent = snapshot::hash_hex(b"absent");
    assert!(!snapshot::exists(&objects, &absent).unwrap());
    assert!(matches!(
        snapshot::get(&objects, &absent),
        Err(history::HistoryError::NotFound(_))
    ));
    assert!(matches!(
        snapshot::get(&objects, "xyz"),
        Err(history::HistoryError::Invalid(_))
    ));

    let alien = zstd::encode_all(&c2[..], 3).unwrap();
    std::fs::write(&object_file, alien).unwrap();
    assert!(matches!(
        snapshot::get(&objects, &h1),
        Err(history::HistoryError::Corrupt(_))
    ));
    std::fs::write(&object_file, b"not zstd at all").unwrap();
    assert!(matches!(
        snapshot::get(&objects, &h1),
        Err(history::HistoryError::Corrupt(_))
    ));
}

#[test]
fn undo_plan_marks_conflicts() {
    let tmp = TempDir::new("undo");
    let journal_dir = tmp.path().join("journal");
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(vault.join("N")).unwrap();

    let created = b"created content".to_vec();
    let v1 = b"version one".to_vec();
    let v2 = b"version two".to_vec();
    let v3 = b"version three, edited later".to_vec();

    std::fs::write(vault.join("N/new.md"), &created).unwrap();
    std::fs::write(vault.join("N/doc.md"), &v2).unwrap();
    std::fs::write(vault.join("N/doc2.md"), &v3).unwrap();
    std::fs::write(vault.join("N/gone2.md"), &v1).unwrap();

    let op = make_op(
        "OP-MIX",
        "2026-07-03T10:00:00Z",
        Actor::Assistant,
        Some("mcp-S3"),
        &[
            ("N/new.md", None, Some(labeled_hash(&created).as_str())),
            (
                "N/doc.md",
                Some(labeled_hash(&v1).as_str()),
                Some(labeled_hash(&v2).as_str()),
            ),
            (
                "N/doc2.md",
                Some(labeled_hash(&v1).as_str()),
                Some(labeled_hash(&v2).as_str()),
            ),
            ("N/gone.md", Some(labeled_hash(&v1).as_str()), None),
            ("N/gone2.md", Some(labeled_hash(&v1).as_str()), None),
            (
                "N/missing.md",
                Some(labeled_hash(&v1).as_str()),
                Some(labeled_hash(&v2).as_str()),
            ),
        ],
    );
    append_op(&journal_dir, &op).unwrap();

    let plan = undo_plan(&journal_dir, &vault, "OP-MIX").unwrap();
    assert_eq!(plan.op_id, "OP-MIX");
    assert_eq!(plan.restores.len(), 6);

    let by_path = |p: &str| plan.restores.iter().find(|r| r.path == p).unwrap();

    let created_restore = by_path("N/new.md");
    assert_eq!(created_restore.restore_to, None);
    assert!(!created_restore.needs_merge);

    let clean_edit = by_path("N/doc.md");
    assert_eq!(clean_edit.restore_to, Some(labeled_hash(&v1)));
    assert!(!clean_edit.needs_merge);

    assert!(by_path("N/doc2.md").needs_merge);

    let clean_delete = by_path("N/gone.md");
    assert_eq!(clean_delete.restore_to, Some(labeled_hash(&v1)));
    assert!(!clean_delete.needs_merge);

    assert!(by_path("N/gone2.md").needs_merge);
    assert!(by_path("N/missing.md").needs_merge);

    assert!(matches!(
        undo_plan(&journal_dir, &vault, "OP-NONE"),
        Err(history::HistoryError::NotFound(_))
    ));
}

#[test]
fn undo_session_plans_in_reverse_order() {
    let tmp = TempDir::new("session");
    let journal_dir = tmp.path().join("journal");
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();

    let mut s3 = make_op(
        "OP-S3",
        "2026-07-03T12:00:00Z",
        Actor::Assistant,
        Some("mcp-S9"),
        &[("c.md", Some("blake3:aa"), None)],
    );
    s3.undone = true;
    let ops = [
        make_op(
            "OP-S1",
            "2026-07-03T10:00:00Z",
            Actor::Assistant,
            Some("mcp-S9"),
            &[("a.md", None, None)],
        ),
        make_op(
            "OP-S2",
            "2026-07-03T11:00:00Z",
            Actor::Assistant,
            Some("mcp-S9"),
            &[("b.md", Some("blake3:aa"), None)],
        ),
        s3,
        make_op(
            "OP-X",
            "2026-07-03T11:30:00Z",
            Actor::Assistant,
            Some("mcp-OTHER"),
            &[("d.md", None, None)],
        ),
    ];
    for op in &ops {
        append_op(&journal_dir, op).unwrap();
    }

    let plans = undo_session_plan(&journal_dir, &vault, "mcp-S9").unwrap();
    let plan_ids: Vec<&str> = plans.iter().map(|p| p.op_id.as_str()).collect();
    assert_eq!(plan_ids, ["OP-S2", "OP-S1"]);
    assert_eq!(plans[0].restores[0].path, "b.md");

    assert!(matches!(
        undo_session_plan(&journal_dir, &vault, "mcp-UNKNOWN"),
        Err(history::HistoryError::NotFound(_))
    ));
}

#[test]
fn activity_and_list_map_params() {
    let tmp = TempDir::new("activity");
    let journal_dir = tmp.path().join("journal");
    seed_journal(&journal_dir);

    let params = ActivityGetParams {
        since: "2020-01-01T00:00:00Z".into(),
        scope: Some(NoteRef("path:Проекты".into())),
        actor: Some(ActorFilter::Assistant),
        limit: None,
    };
    let response = activity(&journal_dir, &params).unwrap();
    assert_eq!(response.events.len(), 1);
    let event = &response.events[0];
    assert_eq!(event.ts, "2026-07-01T09:00:00+03:00");
    assert_eq!(event.actor, Actor::Assistant);
    assert_eq!(event.tool.as_deref(), Some("note_edit"));
    assert_eq!(event.summary, "op OP-B");
    assert_eq!(
        event.refs,
        [
            NoteRef("path:Проекты/A.md".into()),
            NoteRef("path:Заметки/B.md".into())
        ]
    );

    let listed = list(&journal_dir, &params).unwrap();
    assert_eq!(ids(&listed), ["OP-B"]);

    let all_actors = ActivityGetParams {
        since: "2020-01-01T00:00:00Z".into(),
        scope: None,
        actor: Some(ActorFilter::All),
        limit: Some(2),
    };
    let response = activity(&journal_dir, &all_actors).unwrap();
    assert_eq!(response.events.len(), 2);

    let id_scope = ActivityGetParams {
        since: "2020-01-01T00:00:00Z".into(),
        scope: Some(NoteRef("id:01KWKK9PHRG3EBGPKXNQ3M2EP2".into())),
        actor: None,
        limit: None,
    };
    assert!(matches!(
        activity(&journal_dir, &id_scope),
        Err(history::HistoryError::Invalid(_))
    ));
}
