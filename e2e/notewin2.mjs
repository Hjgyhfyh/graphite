import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
let main = pages().find(q => q.url().includes('tauri.localhost') && !q.url().includes('window=') && !/__GRAPHITE/.test(q.url()));
main = pages().find(q => { const u=q.url(); return u.includes('tauri.localhost') && !u.includes('window=capture') && !u.includes('window=note'); });
// fire-and-forget invoke (do not await the promise inside evaluate)
await main.evaluate(() => { window.__TAURI_INTERNALS__.invoke('open_note_window', { noteRef: 'path:Проекты/Блог/План запуска блога.md' }); });
// poll for the note window target
let note = null;
for (let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,400)); note = pages().find(q => { try { return q!==main && q.url().includes('tauri.localhost'); } catch { return false; } }); if(note && note!==main) break; }
if(!note || note===main){ console.log('NOTE WINDOW target not found. targets:'); pages().forEach(q=>console.log('  ',q.url())); process.exit(0); }
await new Promise(r=>setTimeout(r,800));
const info = await note.evaluate(() => ({
  rootLen: (document.getElementById('root')?.innerHTML||'').length,
  hasClose: !!document.querySelector('[aria-label="Закрыть окно"]'),
  hasEditor: !!document.querySelector('.cm-editor'),
  title: document.title,
  injected: typeof window.__GRAPHITE_NOTE_REF__,
  bodyStart: (document.body.innerText||'').slice(0,60),
}));
console.log('NOTE WINDOW:', JSON.stringify(info));
await note.screenshot({ path: 'e2e/shots/notewin-ok.png' }).catch(()=>{});
// test the in-window close button
await note.evaluate(() => document.querySelector('[aria-label="Закрыть окно"]')?.click()).catch(()=>{});
await new Promise(r=>setTimeout(r,800));
const stillOpen = pages().some(q => { try { return q.url().includes('tauri.localhost') && q!==main; } catch { return false; } });
console.log('closed via button:', !stillOpen);
process.exit(0);
