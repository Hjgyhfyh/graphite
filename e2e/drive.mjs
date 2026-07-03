// Прогон реального окна Graphite через CDP (WebView2 remote-debugging).
// Каждый клик бьёт в НАСТОЯЩИЙ бэкенд (vault смонтирован). Кладёт скрины в e2e/shots.
// Запуск: приложение стартовано с WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222,
// vite на 1420, затем `node e2e/drive.mjs`.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const shots = join(dir, 'shots');
mkdirSync(shots, { recursive: true });

const results = [];
let shotN = 0;
const consoleErrors = [];

async function shot(page, name) {
  shotN += 1;
  const p = join(shots, `${String(shotN).padStart(2, '0')}-${name}.png`);
  try {
    await page.screenshot({ path: p });
  } catch {}
  return p;
}

async function step(page, name, fn) {
  try {
    await fn();
    await page.waitForTimeout(350);
    results.push(`PASS ${name}`);
    await shot(page, name.replace(/[^\w а-яА-Я-]/g, '_').slice(0, 40));
  } catch (e) {
    results.push(`FAIL ${name} :: ${String(e).split('\n')[0].slice(0, 140)}`);
    await shot(page, 'FAIL-' + name.replace(/[^\w-]/g, '_').slice(0, 30));
  }
}

const main = async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctxs = browser.contexts();
  let page = null;
  for (const ctx of ctxs) {
    for (const p of ctx.pages()) {
      const u = p.url();
      const isApp = u.includes('tauri.localhost') || u.includes('1420');
      if (isApp && !u.includes('window=capture') && !u.includes('window=note')) page = p;
    }
  }
  if (!page) {
    console.log('НЕ НАЙДЕНА главная страница приложения среди CDP-таргетов:');
    for (const ctx of ctxs) for (const p of ctx.pages()) console.log('  target:', p.url());
    process.exit(3);
  }
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 200)));

  await page.bringToFront().catch(() => {});
  await shot(page, 'initial');

  // счётчик узлов дерева
  await step(page, 'tree-visible', async () => {
    const treeText = await page.locator('aside').first().innerText();
    if (!/Заметки|Входящие|Проекты|заметк/i.test(treeText)) throw new Error('дерево пустое: ' + treeText.slice(0, 80));
  });

  // клик по заметке в дереве (по тексту)
  await step(page, 'open-note-Блог', async () => {
    const el = page.getByText('Блог', { exact: false }).first();
    await el.click({ timeout: 4000 });
  });

  await step(page, 'open-note-Индекс', async () => {
    const el = page.getByText('Тёмная тема', { exact: false }).first();
    await el.click({ timeout: 4000 });
  });

  // палитра Ctrl+K
  await step(page, 'palette-open', async () => {
    await page.keyboard.press('Control+K');
    await page.waitForTimeout(300);
    await page.keyboard.type('заметка');
    await page.waitForTimeout(300);
  });
  await step(page, 'palette-close', async () => { await page.keyboard.press('Escape'); });

  // разделы рельсы по aria-label
  for (const label of ['Поиск', 'Задачи', 'Настройки', 'Заметки']) {
    await step(page, 'rail-' + label, async () => {
      await page.getByRole('button', { name: label }).first().click({ timeout: 4000 });
    });
  }

  // поиск: переключиться и ввести
  await step(page, 'search-query', async () => {
    await page.getByRole('button', { name: 'Поиск' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    const inp = page.locator('input[type="text"], input:not([type])').first();
    await inp.fill('блог');
    await page.waitForTimeout(600);
  });

  // настройки + кейбинды
  await step(page, 'settings-open', async () => {
    await page.getByRole('button', { name: 'Настройки' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    const t = await page.locator('body').innerText();
    if (!/клавиш|Внешний вид|MCP|Хранилищ|индекс/i.test(t)) throw new Error('настройки пустые');
  });

  // задачи
  await step(page, 'tasks-open', async () => {
    await page.getByRole('button', { name: 'Задачи' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(500);
  });

  // тумблеры сайдбара/правой панели
  await step(page, 'toggle-sidebar', async () => { await page.keyboard.press('Control+\\'); await page.waitForTimeout(300); await page.keyboard.press('Control+\\'); });
  await step(page, 'toggle-right', async () => { await page.keyboard.press('Alt+\\'); await page.waitForTimeout(300); await page.keyboard.press('Alt+\\'); });

  // быстрый свитчер
  await step(page, 'quickswitcher', async () => { await page.keyboard.press('Control+P'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); });

  // вернуться на дерево и создать заметку через «+»
  await step(page, 'new-note', async () => {
    await page.getByRole('button', { name: 'Заметки' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Новая заметка' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(500);
  });

  await shot(page, 'final');

  console.log('\n==== РЕЗУЛЬТАТЫ КЛИК-ТЕСТА ====');
  results.forEach((r) => console.log(r));
  console.log(`\n==== console errors (${consoleErrors.length}) ====`);
  [...new Set(consoleErrors)].slice(0, 40).forEach((e) => console.log('  ' + e));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nИТОГО: ${results.length - fails}/${results.length} шагов PASS, ${consoleErrors.length} ошибок консоли`);
  await browser.close().catch(() => {});
};

main().catch((e) => { console.error('driver-fatal', e); process.exit(1); });
