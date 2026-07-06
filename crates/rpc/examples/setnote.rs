use rpc::RpcClient;
use serde_json::json;

#[tokio::main]
async fn main() {
    let refstr = "path:Входящие/Рецепт блинчиков.md";
    let mut c = match RpcClient::connect().await {
        Ok(c) => c,
        Err(e) => { eprintln!("нет связи с ядром Graphite (окно закрыто?): {e}"); std::process::exit(2); }
    };
    let env = c.call("note_read", json!({ "ref": refstr })).await.expect("note_read");
    if !env.ok { eprintln!("read fail: {:?}", env.error); std::process::exit(1); }
    let data = env.data.unwrap();
    let content = data["content"].as_str().unwrap_or("");
    let rev = data["rev"].as_str().unwrap_or("").to_string();
    // сохранить frontmatter (---\n…\n---\n), тело заменить на «Привет»
    let new = if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let fm_end = "---\n".len() + end + "\n---\n".len();
            format!("{}\nПривет\n", &content[..fm_end])
        } else { "Привет\n".to_string() }
    } else { "Привет\n".to_string() };
    let env2 = c.call("buffer_save", json!({ "ref": refstr, "baseRev": rev, "content": new })).await.expect("buffer_save");
    if env2.ok { println!("OK: {}", serde_json::to_string(&env2.data).unwrap_or_default()); }
    else { println!("FAIL: {:?}", env2.error); }
    let _ = c.shutdown().await;
}
