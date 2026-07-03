//! Живой смоук MCP-канала: подключается к работающему приложению по
//! `\\.\pipe\graphite-core` и прогоняет все методы реестра против
//! смонтированного тестового vault. Запуск: `cargo run -p rpc --example smoke`.

use rpc::RpcClient;
use serde_json::{json, Value};

async fn call(client: &mut RpcClient, method: &str, params: Value) -> Option<Value> {
    match client.call(method, params).await {
        Ok(env) => {
            if env.ok {
                let data = env.data.clone().unwrap_or(Value::Null);
                let preview = {
                    let s = serde_json::to_string(&data).unwrap_or_default();
                    if s.chars().count() > 220 {
                        format!("{}…", s.chars().take(220).collect::<String>())
                    } else {
                        s
                    }
                };
                println!("OK   {method:<18} {preview}");
                Some(data)
            } else {
                println!("FAIL {method:<18} envelope-error {:?}", env.error);
                None
            }
        }
        Err(err) => {
            println!("ERR  {method:<18} transport {err}");
            None
        }
    }
}

fn rev_of(v: &Option<Value>) -> String {
    v.as_ref()
        .and_then(|x| x.get("rev").or_else(|| x.get("revNew")))
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string()
}

#[tokio::main]
async fn main() {
    let mut c = match RpcClient::connect().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("не удалось подключиться к каналу ядра: {e}\nЗапущено ли приложение с примонтированным vault?");
            std::process::exit(2);
        }
    };
    println!("== рукопожатие ==");
    let _ = c.hello("", "smoke").await.map(|e| println!("hello ok={} {:?}", e.ok, e.data));

    println!("\n== чтение/навигация ==");
    call(&mut c, "vault_info", json!({})).await;
    call(&mut c, "vault_tree", json!({ "depth": 3 })).await;
    call(&mut c, "note_read", json!({ "ref": "path:Входящие/Сырая мысль.md", "include": ["links","backlinks","tasks"] })).await;
    call(&mut c, "search", json!({ "query": "блог" })).await;
    call(&mut c, "search", json!({ "query": "tag:проект" })).await;
    call(&mut c, "search", json!({ "query": "status:inbox" })).await;
    call(&mut c, "links_get", json!({ "ref": "path:Проекты/Блог/План запуска блога.md" })).await;
    call(&mut c, "activity_get", json!({ "since": "-30d" })).await;
    call(&mut c, "context_briefing", json!({})).await;
    call(&mut c, "tasks_query", json!({ "status": "open" })).await;
    call(&mut c, "tasks_query", json!({ "overdue": true })).await;
    call(&mut c, "plan_progress", json!({ "allActive": true })).await;
    call(&mut c, "index_status", json!({})).await;

    println!("\n== мутации/жизненный цикл ==");
    let created = call(&mut c, "note_create", json!({ "parent": "path:Входящие", "title": "Смоук заметка", "content": "тело\n\n- [ ] задача ^t-sm01\n" })).await;
    let cref = created.as_ref().and_then(|v| v.get("ref")).and_then(|r| r.as_str()).unwrap_or("path:Входящие/Смоук заметка.md").to_string();
    let rd = call(&mut c, "note_read", json!({ "ref": cref })).await;
    let rev = rev_of(&rd);
    call(&mut c, "note_edit", json!({ "ref": cref, "rev": rev, "ops": [{ "op": "append_section", "heading": "Риски", "content": "- зависимость от одного канала" }] })).await;
    call(&mut c, "set_status", json!({ "ref": cref, "status": "shaping" })).await;
    call(&mut c, "set_icon", json!({ "ref": cref, "icon": "star", "color": "accent" })).await;
    call(&mut c, "note_pin", json!({ "ref": cref, "pinned": true })).await;
    call(&mut c, "link_add", json!({ "from": cref, "to": "path:Проекты/Блог/_index.md", "type": "related", "context": "смоук" })).await;
    call(&mut c, "link_remove", json!({ "from": cref, "to": "path:Проекты/Блог/_index.md", "type": "related" })).await;
    call(&mut c, "note_rename", json!({ "ref": cref, "newTitle": "Смоук заметка 2" })).await;

    println!("\n== задачи ==");
    call(&mut c, "task_check", json!({ "tasks": [{ "id": "t-a1b2", "done": true }] })).await;
    call(&mut c, "idea_to_tasks", json!({ "text": "1 - собрать требования\n2 - выбрать стек @due(2026-08-01) @p(high)\n3 - прототип" })).await;

    println!("\n== планы ==");
    let plan = call(&mut c, "plan_create", json!({ "title": "Смоук план", "goal": "проверка", "stages": [{ "title": "Фаза 1", "tasks": [{ "text": "шаг раз" }, { "text": "шаг два", "due": "2026-08-10" }] }], "sources": ["path:Входящие/Сырая мысль.md"] })).await;
    let pref = plan.as_ref().and_then(|v| v.get("ref")).and_then(|r| r.as_str()).map(|s| s.to_string());
    if let Some(pr) = &pref {
        let prd = call(&mut c, "note_read", json!({ "ref": pr })).await;
        let prev = rev_of(&prd);
        call(&mut c, "plan_update", json!({ "ref": pr, "rev": prev, "ops": [{ "op": "add_task", "stage": "Фаза 1", "text": "шаг три" }] })).await;
        call(&mut c, "plan_progress", json!({ "ref": pr })).await;
    }

    println!("\n== выжимка/бандлы ==");
    call(&mut c, "distill_context", json!({ "ref": "path:Входящие/Сырая мысль.md" })).await;
    let sm = call(&mut c, "note_read", json!({ "ref": "path:Входящие/Сырая мысль.md" })).await;
    let smrev = rev_of(&sm);
    call(&mut c, "distill_save", json!({ "ref": "path:Входящие/Сырая мысль.md", "rev": smrev, "sections": { "цель": "проверить выжимку", "зачем": "смоук", "критерии_готовности": "методы отвечают" }, "set_status": "shaping" })).await;
    call(&mut c, "bundle_compose", json!({ "ref": "path:Проекты/Блог/_index.md", "includeLinked": true })).await;
    call(&mut c, "bundle_create", json!({ "title": "Смоук бандл", "parent": "path:Проекты", "members": ["path:Проекты/Блог/_index.md"], "instruction": "инструкция бандла" })).await;

    println!("\n== история/undo ==");
    let jl = call(&mut c, "journal_list", json!({ "since": "-1d" })).await;
    let op_id = jl.as_ref().and_then(|v| v.get("events").or(Some(v))).and_then(|e| e.as_array()).and_then(|a| a.first()).and_then(|o| o.get("opId").or_else(|| o.get("op_id"))).and_then(|s| s.as_str()).map(|s| s.to_string());
    if let Some(op) = op_id {
        call(&mut c, "undo_op", json!({ "opId": op })).await;
    } else {
        println!("SKIP undo_op          (нет opId в журнале)");
    }

    println!("\n== удаление/восстановление ==");
    let del = call(&mut c, "note_delete", json!({ "ref": "path:Входящие/Вторая искра.md" })).await;
    let tok = del.as_ref().and_then(|v| v.get("restoreToken")).and_then(|s| s.as_str()).map(|s| s.to_string());
    if let Some(t) = tok {
        call(&mut c, "note_restore", json!({ "restoreToken": t })).await;
    } else {
        call(&mut c, "note_restore", json!({ "ref": "path:.trash/Вторая искра.md" })).await;
    }

    println!("\n== переиндексация ==");
    call(&mut c, "reindex", json!({ "full": true })).await;

    println!("\n== готово ==");
    let _ = c.shutdown().await;
}
