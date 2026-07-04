import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const p = b.contexts().flatMap(c=>c.pages()).find(q=>q.url()==='http://tauri.localhost/');
await p.waitForTimeout(1500);
const st = await p.evaluate(()=>({
  gate: document.body.innerText.includes('Vault не открыт') || document.body.innerText.includes('Создать хранилище'),
  statusbar: [...document.querySelectorAll('*')].find(e=>e.children.length===0 && /не открыт|Мозгов|Входящие|заметк/i.test(e.textContent||''))?.textContent?.slice(0,40),
  treeitems: document.querySelectorAll('[role="treeitem"]').length,
  body: document.body.innerText.slice(0,80),
}));
console.log(JSON.stringify(st,null,1));
process.exit(0);
