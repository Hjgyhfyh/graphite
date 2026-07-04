import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
const before = pages();
console.log('targets before:', before.length);
for (const q of before) console.log('  ', q.url());
const main = before.find(q => { const u=q.url(); return u.includes('tauri.localhost') && !u.includes('window=capture'); });
await main.evaluate(() => { window.__TAURI_INTERNALS__.invoke('open_note_window', { noteRef: 'path:Проекты/Блог/План запуска блога.md' }); });
await new Promise(r=>setTimeout(r,3000));
const after = pages();
console.log('targets after:', after.length);
// identify note window: the one with __GRAPHITE_NOTE_REF__ string
let note=null;
for (const q of after){
  try { const v = await q.evaluate(() => window.__GRAPHITE_NOTE_REF__); if (typeof v==='string' && v.length>0){ note=q; console.log('note window ref =', v, 'url=', q.url()); } } catch {}
}
if(!note){ console.log('NO note window found (invoke may have failed)'); for(const q of after) console.log('  ',q.url()); process.exit(0); }
await new Promise(r=>setTimeout(r,700));
const info = await note.evaluate(() => ({ rootLen:(document.getElementById('root')?.innerHTML||'').length, hasClose:!!document.querySelector('[aria-label="Закрыть окно"]'), hasEditor:!!document.querySelector('.cm-editor'), title:document.title }));
console.log('NOTE:', JSON.stringify(info));
await note.screenshot({path:'e2e/shots/notewin-ok.png'}).catch(()=>{});
await note.evaluate(() => document.querySelector('[aria-label="Закрыть окно"]')?.click()).catch(()=>{});
await new Promise(r=>setTimeout(r,900));
console.log('targets after close:', pages().length);
process.exit(0);
