use rpc::RpcClient;
use serde_json::json;

#[tokio::main]
async fn main() {
    let content = "## Ингредиенты\n\
- Молоко — 500 мл\n\
- Яйца — 2 шт.\n\
- Мука — 200 г\n\
- Сахар — 2 ст. л.\n\
- Соль — щепотка\n\
- Растительное масло — 2 ст. л. (в тесто)\n\n\
## Приготовление\n\
1. Взбить яйца с сахаром и солью.\n\
2. Влить половину молока, всыпать муку и размешать до однородности без комков.\n\
3. Влить остальное молоко и масло — тесто как жидкая сметана.\n\
4. Дать постоять 10–15 минут.\n\
5. Жарить на разогретой сковороде по ~1 минуте с каждой стороны.\n\n\
## Совет\n\
Первый блин комом — хорошо прогрей сковороду и слегка смажь маслом. Начинка любая: от сгущёнки до творога с изюмом.\n";
    let mut c = match RpcClient::connect().await {
        Ok(c) => c,
        Err(e) => { eprintln!("нет связи с ядром Graphite (окно закрыто?): {e}"); std::process::exit(2); }
    };
    match c.call("note_create", json!({"parent":"path:Входящие","title":"Рецепт блинчиков","content":content})).await {
        Ok(env) if env.ok => println!("OK: {}", serde_json::to_string(&env.data).unwrap_or_default()),
        Ok(env) => println!("FAIL: {:?}", env.error),
        Err(e) => println!("ERR: {e}"),
    }
    let _ = c.shutdown().await;
}
