import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages=()=>b.contexts().flatMap(c=>c.pages());
const p=pages().find(q=>q.url()==='http://tauri.localhost/');
let n=0; const shot=async(name)=>{n++;await p.screenshot({path:`e2e/shots/v-${String(n).padStart(2,'0')}-${name}.png`}).catch(()=>{});console.log('shot',name);};
await p.getByRole('button',{name:'Заметки'}).first().click().catch(()=>{});
await p.waitForTimeout(400);
// open first real note
await p.getByRole('treeitem').nth(1).click().catch(()=>{});
await p.waitForTimeout(700);
await shot('editor-note');
// select all text → selection color
await p.locator('.cm-content').first().click().catch(()=>{});
await p.keyboard.press('Control+a');
await p.waitForTimeout(300);
await shot('selection');
// reading mode
await p.keyboard.press('Control+e'); await p.waitForTimeout(500); await shot('reading'); await p.keyboard.press('Control+e'); await p.waitForTimeout(300);
// right-click a note → icon picker
await p.getByRole('treeitem').nth(1).click({button:'right'}).catch(()=>{});
await p.waitForTimeout(400);
const items=await p.evaluate(()=>[...document.querySelectorAll('[role="menuitem"]')].map(e=>e.textContent.trim()));
console.log('note ctx menu:', JSON.stringify(items));
const iconItem=p.getByRole('menuitem',{name:/Иконк/}).first();
await iconItem.click().catch(()=>{});
await p.waitForTimeout(500);
await shot('icon-picker');
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
// folder toggle on Входящие
await p.getByRole('treeitem',{name:/Входящие/}).first().click().catch(()=>{});
await p.waitForTimeout(400); await shot('folder-toggled');
// onboarding: reset flag + reload
await p.evaluate(()=>{ try{ const s=JSON.parse(localStorage.getItem('graphite.ui')||'{}'); if(s.state){ s.state.onboardingDone=false; s.state.firstRun=true; } localStorage.setItem('graphite.ui', JSON.stringify(s)); }catch{} });
await p.reload(); await p.waitForTimeout(1500); await shot('onboarding');
process.exit(0);
