import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
const main = pages().find(q => q.url() === 'http://tauri.localhost/');
// ensure notes view
await main.getByRole('button',{name:'Заметки'}).first().click().catch(()=>{});
await main.waitForTimeout(400);
// right-click a treeitem
const item = main.getByRole('treeitem').first();
await item.click({ button:'right' }).catch(async()=>{ await item.click({button:'right',force:true}); });
await main.waitForTimeout(500);
const items = await main.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(e=>e.textContent.trim()));
console.log('context menu items:', JSON.stringify(items));
console.log('has reveal:', items.some(t=>t.includes('проводник')));
console.log('has copy path:', items.some(t=>t.includes('Скопировать путь')));
await main.keyboard.press('Escape');
process.exit(0);
