import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) { const u=p.url(); if((u.includes('tauri.localhost')||u.includes('1420'))&&!u.includes('window=')) page=p; }
const info = await page.evaluate(() => {
  const aside = document.querySelector('aside[aria-label="Дерево заметок"]');
  if (!aside) return {err:'no aside'};
  const rects = [];
  let el = aside;
  for (let i=0;i<6 && el;i++){ const r=el.getBoundingClientRect(); rects.push(`${el.tagName}.${(el.className||'').toString().slice(0,30)} h=${Math.round(r.height)} w=${Math.round(r.width)}`); el=el.parentElement; }
  // find the arborist list container (last flex-1 div inside aside)
  const divs=[...aside.querySelectorAll('div')];
  const listLike = divs.filter(d=>d.className.includes('flex-1')).map(d=>{const r=d.getBoundingClientRect();return `flex-1 h=${Math.round(r.height)}`});
  const rows = aside.querySelectorAll('[role="treeitem"], [data-index]').length;
  const treeRole = !!aside.querySelector('[role="tree"]');
  return { asideChain: rects, listFlex: listLike.slice(-4), arboristRows: rows, hasTreeRole: treeRole, asideText: aside.innerText.slice(0,120) };
});
console.log(JSON.stringify(info,null,1));
await b.close();
