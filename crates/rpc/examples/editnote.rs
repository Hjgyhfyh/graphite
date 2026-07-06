use rpc::RpcClient;
use serde_json::json;

#[tokio::main]
async fn main() {
    let refstr = "path:Входящие/Рецепт блинчиков.md";
    let mut c = match RpcClient::connect().await {
        Ok(c) => c,
        Err(e) => { eprintln!("нет связи с ядром Graphite: {e}"); std::process::exit(2); }
    };
    let env = c.call("note_read", json!({ "ref": refstr })).await.expect("note_read");
    if !env.ok { eprintln!("read fail: {:?}", env.error); std::process::exit(1); }
    let data = env.data.unwrap();
    let content = data["content"].as_str().unwrap_or("");
    let rev = data["rev"].as_str().unwrap_or("").to_string();
    // тело = всё после frontmatter, обрезанное
    let body = if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let fm_end = "---\n".len() + end + "\n---\n".len();
            content[fm_end..].trim().to_string()
        } else { content.trim().to_string() }
    } else { content.trim().to_string() };
    if body.is_empty() { println!("тело уже пустое"); return; }
    let env2 = c.call("note_edit", json!({
        "ref": refstr, "rev": rev,
        "ops": [{ "op": "replace", "oldString": body, "newString": "Привет" }]
    })).await.expect("note_edit");
    if env2.ok { println!("OK: {}", serde_json::to_string(&env2.data).unwrap_or_default()); }
    else { println!("FAIL: {:?}", env2.error); }
    let _ = c.shutdown().await;
}
