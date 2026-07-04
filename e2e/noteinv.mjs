import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
const main = pages().find(q => { const u=q.url(); return u.includes('tauri.localhost') && !u.includes('window=capture'); });
const res = await main.evaluate(async () => {
  try {
    const r = await Promise.race([
      window.__TAURI_INTERNALS__.invoke('open_note_window', { noteRef: 'path:Проекты/Блог/План запуска блога.md' }).then(()=>'OK'),
      new Promise(res => setTimeout(()=>res('TIMEOUT'), 6000)),
    ]);
    return String(r);
  } catch (e) { return 'ERR: ' + JSON.stringify(e); }
});
console.log('invoke result:', res);
process.exit(0);
