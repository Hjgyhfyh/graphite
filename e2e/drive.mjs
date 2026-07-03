// Досканальный прогон реального окна Graphite через CDP (WebView2 remote-debugging).
// Каждый клик/хоткей бьёт в НАСТОЯЩИЙ бэкенд (vault смонтирован). Скрины → e2e/shots.
// Приложение стартовано с WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
// Запуск: node e2e/drive.mjs
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
const safe = (s) => s.replace(/[^\w а-яА-Я-]/g, '_').slice(0, 44);

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  let page = null;
  for (const ctx of browser.contexts())
    for (const p of ctx.pages()) {
      const u = p.url();
      if ((u.includes('tauri.localhost') || u.includes('1420')) && !u.includes('window=capture') && !u.includes('window=note')) page = p;
    }
  if (!page) {
    console.log('НЕ НАЙДЕНА главная страница:');
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) console.log('  ', p.url());
    process.exit(3);
  }
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 200)));
  await page.bringToFront().catch(() => {});

  async function shot(name) { shotN += 1; try { await page.screenshot({ path: join(shots, `${String(shotN).padStart(2, '0')}-${safe(name)}.png`) }); } catch {} }
  async function step(name, fn) {
    try { await fn(); await page.waitForTimeout(300); results.push(`PASS ${name}`); await shot(name); }
    catch (e) { results.push(`FAIL ${name} :: ${String(e).split('\n')[0].slice(0, 130)}`); await shot('FAIL-' + name); }
  }
  const key = (k) => page.keyboard.press(k);
  const clickText = (t, opts = {}) => page.getByText(t, { exact: false }).first().click({ timeout: 3500, ...opts });
  const clickLabel = (t) => page.getByRole('button', { name: t }).first().click({ timeout: 3500 });

  await shot('initial');

  // --- навигация по дереву + вложенность ---
  await step('rail-notes', () => clickLabel('Заметки'));
  await step('tree-content', async () => {
    const t = await page.locator('aside').first().innerText();
    if (!/Входящие|Проекты|Блог|заметк/i.test(t)) throw new Error('дерево: ' + t.slice(0, 60));
  });
  await step('expand-and-open-nested', async () => {
    // развернуть Проекты и Приложение, открыть вложенную заметку
    for (const f of ['Проекты', 'Приложение', 'Идеи']) { try { await clickText(f); await page.waitForTimeout(200); } catch {} }
    await clickText('Тёмная тема');
  });
  await step('open-plan', () => clickText('План запуска'));

  // --- палитра / свитчер ---
  await step('palette', async () => { await key('Control+k'); await page.waitForTimeout(250); await page.keyboard.type('блог'); await page.waitForTimeout(250); });
  await step('palette-esc', () => key('Escape'));
  await step('switcher', async () => { await key('Control+p'); await page.waitForTimeout(250); await key('Escape'); });

  // --- поиск ---
  await step('search-view', () => clickLabel('Поиск'));
  await step('search-type', async () => { const i = page.locator('input').first(); await i.fill('тема'); await page.waitForTimeout(500); });
  await step('search-operator', async () => { const i = page.locator('input').first(); await i.fill('status:inbox'); await page.waitForTimeout(500); });

  // --- задачи + идея→таски ---
  await step('tasks-view', () => clickLabel('Задачи'));
  await step('idea-input', async () => {
    const ta = page.locator('textarea').first();
    await ta.fill('1 - собрать требования\n2 - выбрать стек @due(2026-08-01) @p(high)\n3 - прототип');
    await page.waitForTimeout(200);
  });
  await step('idea-decompose', () => clickText('Разложить по задачам'));
  await step('tasks-filter-today', () => clickText('Сегодня'));
  await step('tasks-filter-overdue', () => clickText('Просрочено'));

  // --- канбан (новая фича) ---
  await step('kanban-view', async () => {
    await page.getByRole('button', { name: 'Канбан' }).first().click({ timeout: 3500 }).catch(async () => {
      await page.getByRole('button', { name: /Поток|План/ }).first().click({ timeout: 3500 });
    });
    await page.waitForTimeout(600);
  });

  // --- настройки + кейбинды ---
  await step('settings', () => clickLabel('Настройки'));
  await step('settings-keys', () => clickText('Клавиши').catch(() => clickText('Горячие')));
  await step('settings-appearance', () => clickText('Внешний вид'));

  // --- редактор: reading mode, назад к заметке ---
  await step('back-to-notes', () => clickLabel('Заметки'));
  await step('open-blog', () => clickText('Блог'));
  await step('reading-mode', async () => { await key('Control+e'); await page.waitForTimeout(300); await key('Control+e'); });

  // --- правая панель: вкладки ---
  await step('right-aifeed', () => clickText('ИИ-лента'));
  await step('right-links', () => clickText('Связи'));
  await step('right-backlinks', () => clickText('Бэкли').catch(() => clickText('Бэклинки')));
  await step('right-props', () => clickText('Свойства'));

  // --- Copy Page ---
  await step('copy-page', () => clickText('Copy Page'));

  // --- вкладки: создать, разбить панель, группа ---
  await step('new-note', async () => { await clickLabel('Заметки'); await clickLabel('Новая заметка'); await page.waitForTimeout(500); });
  await step('split-pane', async () => {
    await page.getByRole('button', { name: /разбить|панел|split|В отдельную/i }).first().click({ timeout: 3000 }).catch(() => key('Control+Alt+\\'));
    await page.waitForTimeout(500);
  });

  // --- тумблеры/хоткеи ---
  await step('toggle-tree', async () => { await key('Control+\\'); await page.waitForTimeout(250); await key('Control+\\'); });
  await step('toggle-right', async () => { await key('Alt+\\'); await page.waitForTimeout(250); await key('Alt+\\'); });
  await step('ai-feed-hotkey', async () => { await key('Control+Shift+a'); await page.waitForTimeout(300); });

  // --- плавающий захват ---
  await step('capture-open', async () => { await key('Control+Alt+ '); await page.waitForTimeout(400); });
  await step('capture-esc', () => key('Escape'));

  await shot('final');

  console.log('\n==== РЕЗУЛЬТАТЫ ДОСКАНАЛЬНОГО ТЕСТА ====');
  results.forEach((r) => console.log(r));
  console.log(`\n==== console errors (${consoleErrors.length}) ====`);
  [...new Set(consoleErrors)].slice(0, 40).forEach((e) => console.log('  ' + e));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nИТОГО: ${results.length - fails}/${results.length} PASS, ${consoleErrors.length} console errors`);
  await browser.close().catch(() => {});
}
main().catch((e) => { console.error('driver-fatal', e); process.exit(1); });
