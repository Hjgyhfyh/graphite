import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
let main=null;
for (const c of b.contexts()) for (const q of c.pages()){const u=q.url();if(u.includes('tauri.localhost')&&!u.includes('window='))main=q;}
if(!main){console.log('no main');process.exit(1);}
// open a detached note window via real invoke
await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('open_note_window', { noteRef: 'path:Проекты/Блог/_index.md' }));
await main.waitForTimeout(2500);
// enumerate targets, find the note window
const targets = [];
for (const c of b.contexts()) for (const q of c.pages()) targets.push(q);
console.log('targets:');
for (const t of targets) console.log('  ', t.url());
const note = targets.find(t => t.url().includes('window=note'));
if(!note){console.log('NOTE WINDOW NOT FOUND as CDP target');process.exit(0);}
const errs=[]; note.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,180));}); note.on('pageerror',e=>errs.push('PE '+String(e).slice(0,180)));
await note.waitForTimeout(500);
const info = await note.evaluate(() => ({
  root: (document.getElementById('root')?.innerHTML||'').length,
  bodyText: (document.body.innerText||'').slice(0,120),
  title: document.title,
  href: location.href,
  search: location.search,
}));
console.log('NOTE WINDOW:', JSON.stringify(info,null,1));
console.log('note console errors:', errs.slice(0,10));
await note.screenshot({path:'e2e/shots/notewin.png'}).catch(()=>{});
await b.close();
