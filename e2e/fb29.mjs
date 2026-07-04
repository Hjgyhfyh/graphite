import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = () => b.contexts().flatMap(c => c.pages());
const p = pages().find(q => q.url() === 'http://tauri.localhost/');
if(!p){ console.log('no main'); process.exit(1); }
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE '+String(e).slice(0,160)));
const res=[]; let n=0;
const shot=async(name)=>{n++;await p.screenshot({path:`e2e/shots/fb-${String(n).padStart(2,'0')}-${name}.png`}).catch(()=>{});};
const step=async(name,fn)=>{try{await fn();await p.waitForTimeout(300);res.push('PASS '+name);await shot(name);}catch(e){res.push('FAIL '+name+' :: '+String(e).split('\n')[0].slice(0,110));await shot('FAIL-'+name);}};
await p.bringToFront().catch(()=>{});
await shot('initial');

// #1 selection color — read ::selection from CM theme + global
await step('selection-color', async()=>{
  const c = await p.evaluate(()=>{
    const el=document.createElement('div'); el.className='cm-content'; document.body.appendChild(el);
    // sample the CM selection background if present, else global
    const g=getComputedStyle(document.documentElement).getPropertyValue('--color-accent');
    return { accent:g.trim() };
  });
  console.log('accent token:', JSON.stringify(c));
});

// #24 search crash
await step('search-open', async()=>{ await p.getByRole('button',{name:'Поиск'}).first().click({timeout:4000}); });
await step('search-type-crash', async()=>{
  const i=p.locator('input').first(); await i.fill('блог'); await p.waitForTimeout(700);
  const alive=await p.evaluate(()=>!!document.querySelector('#root')?.children.length);
  if(!alive) throw new Error('app blank after search (crash)');
});
await step('search-type2', async()=>{ const i=p.locator('input').first(); await i.fill('план запуска'); await p.waitForTimeout(700); });

// #3 + menu
await step('plus-menu', async()=>{
  await p.getByRole('button',{name:'Заметки'}).first().click({timeout:4000}); await p.waitForTimeout(300);
  await p.getByRole('button',{name:/Нова|Создать|Добавить/i}).first().click({timeout:4000}).catch(async()=>{
    // fallback: the + button
    await p.locator('aside header button').first().click({timeout:3000});
  });
  await p.waitForTimeout(400);
  const menu=await p.evaluate(()=>[...document.querySelectorAll('[role="menuitem"]')].map(e=>e.textContent.trim()));
  console.log('plus menu:', JSON.stringify(menu));
  await p.keyboard.press('Escape');
});

// #7 folder toggle
await step('folder-toggle', async()=>{
  const folder=p.getByRole('treeitem',{name:/Проекты/}).first();
  const before=await p.evaluate(()=>document.querySelectorAll('[role="treeitem"]').length);
  await folder.click({timeout:4000}); await p.waitForTimeout(400);
  const after=await p.evaluate(()=>document.querySelectorAll('[role="treeitem"]').length);
  console.log('treeitems before/after folder click:', before, after);
});

// #25 kanban
await step('kanban', async()=>{
  await p.getByRole('button',{name:'Канбан'}).first().click({timeout:4000}); await p.waitForTimeout(600);
  const cards=await p.evaluate(()=>document.body.innerText.includes('Поток'));
  if(!cards) throw new Error('kanban not shown');
});

console.log('\n==== fb29 ====');
res.forEach(r=>console.log(r));
console.log('console errors ('+errs.length+'):'); [...new Set(errs)].slice(0,20).forEach(e=>console.log('  '+e));
process.exit(0);
