import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
let p=null;
for (const c of b.contexts()) for (const q of c.pages()){const u=q.url();if((u.includes('tauri.localhost')||u.includes('1420'))&&!u.includes('window='))p=q;}
// switch to another view then back to notes, measure immediately (flash test)
await p.getByRole('button',{name:'Настройки'}).first().click().catch(()=>{});
await p.waitForTimeout(300);
await p.getByRole('button',{name:'Заметки'}).first().click().catch(()=>{});
await p.waitForTimeout(120); // minimal wait — if flash existed, tree empty here
const rowsFast = await p.evaluate(()=>document.querySelectorAll('aside [role="treeitem"], aside [data-index]').length);
await p.screenshot({path:'e2e/shots/tree-fresh.png'});
console.log('rows 120ms after switch-back:', rowsFast);
await b.close();
