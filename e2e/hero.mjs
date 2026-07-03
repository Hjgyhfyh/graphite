import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
let p=null;
for (const c of b.contexts()) for (const q of c.pages()){const u=q.url();if((u.includes('tauri.localhost')||u.includes('1420'))&&!u.includes('window='))p=q;}
await p.getByRole('button',{name:'Заметки'}).first().click().catch(()=>{});
await p.waitForTimeout(400);
await p.getByRole('treeitem',{name:/Блог/}).first().click().catch(()=>{});
await p.waitForTimeout(500);
await p.getByRole('button',{name:'Свойства'}).first().click().catch(()=>{});
await p.waitForTimeout(400);
await p.screenshot({path:'e2e/shots/hero.png'});
console.log('hero saved');
await b.close();
