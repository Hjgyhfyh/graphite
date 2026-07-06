import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const p = b.contexts().flatMap(c=>c.pages()).find(q=>q.url()==='http://tauri.localhost/');
if(!p){ console.log('приложение не найдено (окно закрыто?)'); process.exit(2); }
const content = `## Ингредиенты
- Молоко — 500 мл
- Яйца — 2 шт.
- Мука — 200 г
- Сахар — 2 ст. л.
- Соль — щепотка
- Растительное масло — 2 ст. л. (в тесто)

## Приготовление
1. Взбить яйца с сахаром и солью.
2. Влить половину молока, всыпать муку и размешать до однородности без комков.
3. Влить остальное молоко и масло — тесто как жидкая сметана.
4. Дать постоять 10–15 минут.
5. Жарить на разогретой сковороде по ~1 минуте с каждой стороны.

## Совет
Первый блин комом — хорошо прогрей сковороду и слегка смажь маслом. Начинка любая: от сгущёнки до творога с изюмом.
`;
const res = await p.evaluate(async (content) => {
  try {
    const r = await Promise.race([
      window.__TAURI_INTERNALS__.invoke('note_create', { params: { parent: 'path:Входящие', title: 'Рецепт блинчиков', content } }),
      new Promise((res)=>setTimeout(()=>res('TIMEOUT'), 8000)),
    ]);
    return r;
  } catch (e) { return 'ERR: ' + JSON.stringify(e); }
}, content);
console.log('note_create →', JSON.stringify(res));
// refresh tree so it shows up
await p.evaluate(()=>{ try{ /* trigger reload via store if available */ }catch{} });
process.exit(0);
