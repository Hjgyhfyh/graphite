use std::collections::BTreeMap;

use serde_json::json;
use vault_core::*;

#[test]
fn newtypes_serialize_transparent() {
    let id = NoteId("01JAAAAAAAAAAAAAAAAAAAAAAA".to_string());
    assert_eq!(
        serde_json::to_string(&id).unwrap(),
        "\"01JAAAAAAAAAAAAAAAAAAAAAAA\""
    );
    let rev: Rev = serde_json::from_str("\"0123456789abcdef\"").unwrap();
    assert_eq!(rev, Rev("0123456789abcdef".to_string()));
    let note_ref: NoteRef = serde_json::from_str("\"path:Проекты/Блог.md\"").unwrap();
    assert_eq!(note_ref.0, "path:Проекты/Блог.md");
    assert_eq!(
        serde_json::to_string(&Anchor("b3k9q".to_string())).unwrap(),
        "\"b3k9q\""
    );
}

#[test]
fn status_enums_serialize_lowercase() {
    assert_eq!(serde_json::to_value(Status::Inbox).unwrap(), json!("inbox"));
    assert_eq!(serde_json::to_value(TaskStatus::Doing).unwrap(), json!("doing"));
    assert_eq!(serde_json::to_value(NoteType::Journal).unwrap(), json!("journal"));
    assert_eq!(serde_json::to_value(Priority::Urgent).unwrap(), json!("urgent"));
    assert_eq!(serde_json::to_value(Actor::Assistant).unwrap(), json!("assistant"));
    assert_eq!(serde_json::to_value(IndexState::Scanning).unwrap(), json!("scanning"));
    assert_eq!(serde_json::to_value(SearchMode::Hybrid).unwrap(), json!("hybrid"));
    assert_eq!(serde_json::to_value(LinkDirection::Both).unwrap(), json!("both"));
    assert_eq!(serde_json::to_value(ActorFilter::All).unwrap(), json!("all"));
    assert_eq!(serde_json::to_value(TaskStatusFilter::Open).unwrap(), json!("open"));
    assert_eq!(serde_json::to_value(NoteReadInclude::Backlinks).unwrap(), json!("backlinks"));
    assert_eq!(serde_json::to_value(BundleRole::Neighbor).unwrap(), json!("neighbor"));
    assert_eq!(serde_json::to_value(DistillTargetStatus::Shaping).unwrap(), json!("shaping"));
}

#[test]
fn status_dictionaries_round_trip() {
    for s in Status::ALL {
        assert_eq!(s.as_str().parse::<Status>().unwrap(), s);
        assert_eq!(serde_json::to_value(s).unwrap(), json!(s.as_str()));
    }
    for s in TaskStatus::ALL {
        assert_eq!(s.as_str().parse::<TaskStatus>().unwrap(), s);
    }
    for s in NoteType::ALL {
        assert_eq!(s.as_str().parse::<NoteType>().unwrap(), s);
    }
    for s in Priority::ALL {
        assert_eq!(s.as_str().parse::<Priority>().unwrap(), s);
    }
    for s in Actor::ALL {
        assert_eq!(s.as_str().parse::<Actor>().unwrap(), s);
    }
    assert!("garbage".parse::<Status>().is_err());
}

#[test]
fn rel_type_snake_case_and_custom() {
    assert_eq!(
        serde_json::to_value(RelType::DistilledFrom).unwrap(),
        json!("distilled_from")
    );
    assert_eq!(
        serde_json::from_value::<RelType>(json!("blocks")).unwrap(),
        RelType::Blocks
    );
    assert_eq!(
        serde_json::from_value::<RelType>(json!("x-foo")).unwrap(),
        RelType::Custom("x-foo".to_string())
    );
    assert_eq!(
        serde_json::to_value(RelType::Custom("x-foo".to_string())).unwrap(),
        json!("x-foo")
    );
    assert_eq!("part_of".parse::<RelType>().unwrap(), RelType::PartOf);
    assert_eq!(
        "x-my-rel".parse::<RelType>().unwrap(),
        RelType::Custom("x-my-rel".to_string())
    );
    assert!("custom-without-prefix".parse::<RelType>().is_err());
}

#[test]
fn error_codes_serialize_screaming_snake_case() {
    assert_eq!(
        serde_json::to_value(GraphiteErrorCode::NotFound).unwrap(),
        json!("NOT_FOUND")
    );
    assert_eq!(
        serde_json::to_value(GraphiteErrorCode::Unavailable).unwrap(),
        json!("UNAVAILABLE")
    );
}

#[test]
fn vault_error_maps_to_codes() {
    assert_eq!(
        VaultError::NotFound("id:x".to_string()).code(),
        GraphiteErrorCode::NotFound
    );
    assert_eq!(
        VaultError::Index("fts".to_string()).code(),
        GraphiteErrorCode::Unavailable
    );
    let conflict = VaultError::Conflict {
        path: "Проекты/Блог.md".to_string(),
        current_rev: Rev("0123456789abcdef".to_string()),
        diff: Some("+1 -1".to_string()),
    };
    let err: GraphiteError = conflict.into();
    assert_eq!(err.code, GraphiteErrorCode::Conflict);
    let data = err.data.unwrap();
    assert_eq!(data["currentRev"], "0123456789abcdef");
    let ambiguous = VaultError::Ambiguous {
        ref_: "path:Блог".to_string(),
        candidates: vec![],
    };
    let err: GraphiteError = ambiguous.into();
    assert_eq!(err.code, GraphiteErrorCode::Ambiguous);
    assert!(err.data.unwrap()["candidates"].is_array());
    let io = VaultError::Io(std::io::Error::other("C:\\secret\\path"));
    let err: GraphiteError = io.into();
    assert_eq!(err.code, GraphiteErrorCode::Unavailable);
    assert!(!err.message.contains("secret"));
}

#[test]
fn envelope_keeps_invariant_and_skips_none() {
    let ok = Envelope::ok(VaultCounts {
        notes: 1,
        plans: 0,
        tasks_open: 2,
        inbox: 3,
    });
    let v = serde_json::to_value(&ok).unwrap();
    assert_eq!(v["v"], "1.0");
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["tasksOpen"], 2);
    assert!(v.get("error").is_none());
    assert!(v.get("schemaVersion").is_none());

    let err: Envelope<VaultCounts> = Envelope::err(GraphiteError {
        code: GraphiteErrorCode::Forbidden,
        message: "vault is read-only".to_string(),
        hint: None,
        data: None,
    });
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["ok"], false);
    assert!(v.get("data").is_none());
    assert_eq!(v["error"]["code"], "FORBIDDEN");
    assert!(v["error"].get("hint").is_none());
}

#[test]
fn frontmatter_serde_policy() {
    let empty = Frontmatter::default();
    assert_eq!(serde_json::to_value(&empty).unwrap(), json!({}));

    let mut fm = Frontmatter::default();
    fm.id = Some(NoteId("01JAAAAAAAAAAAAAAAAAAAAAAA".to_string()));
    fm.r#type = Some(NoteType::Plan);
    fm.title = Some("Блог".to_string());
    fm.tags = vec!["идея".to_string()];
    fm.target_date = Some("2026-08-01".to_string());
    fm.rel.insert(
        "part_of".to_string(),
        vec!["[[Проекты]]".to_string()],
    );
    fm.extra.insert(
        "x-mood".to_string(),
        serde_yml::Value::String("ok".to_string()),
    );

    let v = serde_json::to_value(&fm).unwrap();
    assert_eq!(v["type"], "plan");
    assert_eq!(v["targetDate"], "2026-08-01");
    assert_eq!(v["rel"]["part_of"][0], "[[Проекты]]");
    assert_eq!(v["x-mood"], "ok");
    assert!(v.get("status").is_none());
    assert!(v.get("aliases").is_none());

    let back: Frontmatter = serde_json::from_value(v).unwrap();
    assert_eq!(back, fm);
}

#[test]
fn core_structs_use_camel_case_and_skip_none() {
    let meta = NoteMeta {
        id: NoteId("01JAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
        path: "Проекты/Блог.md".to_string(),
        title: "Блог".to_string(),
        r#type: NoteType::Project,
        status: None,
        tags: vec![],
        updated: "2026-07-03T12:00:00Z".to_string(),
        rev: Rev("0123456789abcdef".to_string()),
        children_count: 4,
    };
    let v = serde_json::to_value(&meta).unwrap();
    assert_eq!(v["childrenCount"], 4);
    assert!(v.get("status").is_none());

    let task = TaskItem {
        id: "t-8f2k".to_string(),
        note_id: NoteId("01JAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
        anchor: Anchor("t-8f2k".to_string()),
        text: "написать черновик".to_string(),
        done: false,
        status: TaskStatus::Todo,
        due: Some("2026-07-10".to_string()),
        priority: None,
        every: None,
        line: 12,
        plan: Some(NoteRef("id:01JBBBBBBBBBBBBBBBBBBBBBBB".to_string())),
        stage: Some("Черновик".to_string()),
    };
    let v = serde_json::to_value(&task).unwrap();
    assert_eq!(v["noteId"], "01JAAAAAAAAAAAAAAAAAAAAAAA");
    assert!(v.get("priority").is_none());
    assert!(v.get("every").is_none());

    let op = JournalOp {
        op_id: "01JCCCCCCCCCCCCCCCCCCCCCCC".to_string(),
        ts: "2026-07-03T12:00:00Z".to_string(),
        actor: Actor::Assistant,
        session: Some("mcp-01J".to_string()),
        tool: Some("note_edit".to_string()),
        summary: "правка заметки".to_string(),
        files: vec![FileChange {
            path: "Проекты/Блог.md".to_string(),
            before: None,
            after: Some(format!("blake3:{}", "a".repeat(64))),
        }],
        undone: false,
    };
    let v = serde_json::to_value(&op).unwrap();
    assert_eq!(v["opId"], "01JCCCCCCCCCCCCCCCCCCCCCCC");
    assert!(v["files"][0].get("before").is_none());

    let edge = LinkEdge {
        src_id: NoteId("01JAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
        dst_id: None,
        dst_raw: "[[Нет такой]]".to_string(),
        rel_type: RelType::Related,
        block: None,
        context: None,
    };
    let v = serde_json::to_value(&edge).unwrap();
    assert_eq!(v["dstRaw"], "[[Нет такой]]");
    assert!(v.get("dstId").is_none());
}

#[test]
fn note_read_response_skips_unrequested_includes() {
    let resp = NoteReadResponse {
        frontmatter: Frontmatter::default(),
        content: "текст".to_string(),
        rev: Rev("0123456789abcdef".to_string()),
        truncated: None,
        links: None,
        backlinks: None,
        children: None,
        tasks: None,
    };
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["content"], "текст");
    assert!(v.get("truncated").is_none());
    assert!(v.get("links").is_none());
    assert!(v.get("backlinks").is_none());
    assert!(v.get("children").is_none());
    assert!(v.get("tasks").is_none());
}

#[test]
fn params_deserialize_with_missing_optionals() {
    let params: VaultTreeParams = serde_json::from_value(json!({})).unwrap();
    assert_eq!(params.root, None);
    assert_eq!(params.limit, None);

    let params: SearchParams = serde_json::from_value(json!({ "query": "блог tag:идея" })).unwrap();
    assert_eq!(params.query, "блог tag:идея");
    assert_eq!(params.mode, None);
    assert_eq!(params.filters, None);

    let params: NoteReadParams =
        serde_json::from_value(json!({ "ref": "id:01JAAAAAAAAAAAAAAAAAAAAAAA" })).unwrap();
    assert_eq!(params.r#ref.0, "id:01JAAAAAAAAAAAAAAAAAAAAAAA");
    assert_eq!(params.include, None);

    let params: PlanProgressParams = serde_json::from_value(json!({ "allActive": true })).unwrap();
    assert_eq!(params.all_active, Some(true));
    assert_eq!(params.stalled_days, None);
}

#[test]
fn note_edit_ops_are_snake_case_tagged_with_camel_case_fields() {
    let op = NoteEditOp::Replace {
        old_string: "a".to_string(),
        new_string: "b".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        json!({ "op": "replace", "oldString": "a", "newString": "b" })
    );

    let op: NoteEditOp = serde_json::from_value(json!({
        "op": "append_section",
        "heading": "Риски",
        "content": "текст"
    }))
    .unwrap();
    assert_eq!(
        op,
        NoteEditOp::AppendSection {
            heading: "Риски".to_string(),
            content: "текст".to_string(),
        }
    );

    let op = NoteEditOp::SetFrontmatter {
        key: "status".to_string(),
        value: json!("active"),
    };
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        json!({ "op": "set_frontmatter", "key": "status", "value": "active" })
    );
}

#[test]
fn plan_update_ops_are_snake_case_tagged_with_camel_case_fields() {
    let op = PlanUpdateOp::EditTask {
        task_id: "t-8f2k".to_string(),
        text: None,
        due: Some("2026-07-10".to_string()),
    };
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        json!({ "op": "edit_task", "taskId": "t-8f2k", "due": "2026-07-10" })
    );

    let op: PlanUpdateOp = serde_json::from_value(json!({
        "op": "add_stage",
        "title": "Финал"
    }))
    .unwrap();
    assert_eq!(
        op,
        PlanUpdateOp::AddStage {
            title: "Финал".to_string(),
            after: None,
        }
    );

    let op: PlanUpdateOp =
        serde_json::from_value(json!({ "op": "reorder", "order": ["a", "b"] })).unwrap();
    assert_eq!(
        op,
        PlanUpdateOp::Reorder {
            order: vec!["a".to_string(), "b".to_string()],
        }
    );
}

#[test]
fn distill_sections_use_russian_keys() {
    let sections = DistillSections {
        goal: "запустить блог".to_string(),
        why: "делиться заметками".to_string(),
        done_criteria: "первый пост опубликован".to_string(),
        plan: None,
        risks: Some("не хватит времени".to_string()),
        assumptions: None,
        blind_spots: None,
    };
    let v = serde_json::to_value(&sections).unwrap();
    assert_eq!(v["цель"], "запустить блог");
    assert_eq!(v["зачем"], "делиться заметками");
    assert_eq!(v["критерии_готовности"], "первый пост опубликован");
    assert_eq!(v["риски"], "не хватит времени");
    assert!(v.get("план").is_none());
    assert!(v.get("не_думал").is_none());

    let back: DistillSections = serde_json::from_value(v).unwrap();
    assert_eq!(back, sections);
}

#[test]
fn composite_responses_construct_and_serialize() {
    let info = VaultInfoResponse {
        schema_version: SCHEMA_VERSION.to_string(),
        vault_format: VAULT_FORMAT.to_string(),
        root: "D:/Vault".to_string(),
        counts: VaultCounts {
            notes: 10,
            plans: 2,
            tasks_open: 5,
            inbox: 1,
        },
        capabilities: vec![],
        limits: VaultLimits::CANON,
        conventions_digest: "digest".to_string(),
    };
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(v["schemaVersion"], "1.0");
    assert_eq!(v["vaultFormat"], "1");
    assert_eq!(v["limits"]["maxResponseBytes"], 51200);
    assert_eq!(v["limits"]["mutationsRps"], 5);

    let progress = PlanProgress {
        r#ref: NoteRef("id:01JBBBBBBBBBBBBBBBBBBBBBBB".to_string()),
        title: "Блог".to_string(),
        percent: 0.5,
        done: 3,
        total: 6,
        by_stage: vec![StageProgress {
            title: "Черновик".to_string(),
            done: 3,
            total: 3,
        }],
        overdue: vec![],
        stalled: vec![],
        next_tasks: vec![],
    };
    let briefing = ContextBriefingResponse {
        inbox_count: 1,
        next_steps: vec![],
        stalled: vec![StalledNote {
            r#ref: NoteRef("id:01JAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
            days: 9,
        }],
        overdue: vec![],
        recent: vec![],
        suggest_distill: vec![],
    };
    let v = serde_json::to_value(&briefing).unwrap();
    assert_eq!(v["inboxCount"], 1);
    assert_eq!(v["stalled"][0]["days"], 9);
    let v = serde_json::to_value(&PlanProgressResponse {
        plans: vec![progress],
    })
    .unwrap();
    assert_eq!(v["plans"][0]["byStage"][0]["total"], 3);
    assert_eq!(v["plans"][0]["nextTasks"], json!([]));

    let links = LinksGetResponse {
        out: vec![LinkOut {
            to: NoteRef("id:01JBBBBBBBBBBBBBBBBBBBBBBB".to_string()),
            r#type: RelType::DependsOn,
            context: None,
        }],
        r#in: vec![],
    };
    let v = serde_json::to_value(&links).unwrap();
    assert_eq!(v["out"][0]["type"], "depends_on");
    assert_eq!(v["in"], json!([]));

    let restore: NoteRestoreParams = serde_json::from_value(json!({})).unwrap();
    assert!(restore.restore_token.is_none() && restore.r#ref.is_none());

    let buffer = BufferSaveParams {
        r#ref: NoteRef("path:Входящие/Идея.md".to_string()),
        base_rev: Rev("0123456789abcdef".to_string()),
        content: "текст".to_string(),
    };
    let v = serde_json::to_value(&buffer).unwrap();
    assert_eq!(v["baseRev"], "0123456789abcdef");

    let status = IndexStatus {
        state: IndexState::Idle,
        done: 10,
        total: 10,
    };
    assert_eq!(serde_json::to_value(&status).unwrap()["state"], "idle");

    let event = McpSessionEvent {
        active: true,
        session: None,
    };
    let v = serde_json::to_value(&event).unwrap();
    assert_eq!(v["active"], true);
    assert!(v.get("session").is_none());
}

#[test]
fn frontmatter_rel_keys_match_rel_type_dictionary() {
    let mut rel: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for rel_type in RelType::KNOWN {
        rel.insert(rel_type.as_str().to_string(), vec!["[[Другая]]".to_string()]);
    }
    assert!(rel.contains_key("distilled_from"));
    assert!(rel.contains_key("collected_in"));
    for key in rel.keys() {
        assert!(key.parse::<RelType>().is_ok());
    }
}
