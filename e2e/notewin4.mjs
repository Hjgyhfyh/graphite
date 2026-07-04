import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
const main = pages().find(q => q.url() === 'http://tauri.localhost/');
const note = pages().find(q => q.url().includes('window=note'));
console.log('main?', !!main, 'note?', !!note);
// before
const b4 = await note.evaluate(() => ({ hasEditor:!!document.querySelector('.cm-editor'), body:(document.body.innerText||'').slice(0,50) }));
console.log('note BEFORE invoke:', JSON.stringify(b4));
// invoke open_note_window
await main.evaluate(() => { window.__TAURI_INTERNALS__.invoke('open_note_window', { noteRef: 'path:Проекты/Блог/План запуска блога.md' }); });
await new Promise(r=>setTimeout(r,1500));
const after = await note.evaluate(() => ({ hasEditor:!!document.querySelector('.cm-editor'), hasClose:!!document.querySelector('[aria-label="Закрыть окно"]'), title:document.title, body:(document.body.innerText||'').slice(0,80) }));
console.log('note AFTER invoke:', JSON.stringify(after));
await note.screenshot({ path:'e2e/shots/notewin-final.png' }).catch(()=>{});
process.exit(0);
