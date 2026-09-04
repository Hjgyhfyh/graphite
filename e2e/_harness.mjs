// Общий каркас для spec-прогонов Graphite через CDP (WebView2 remote-debugging).
// Каждый spec бьёт по НАСТОЯЩЕМУ бэкенду живого окна и проверяет реальное
// поведение (persist localStorage, data-theme, история навигации, тумблеры).
//
// Приложение поднимать с WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
// Одиночный прогон:  node e2e/vault-persist.spec.mjs
// Все сразу:         node e2e/run-specs.mjs
// Адрес CDP можно переопределить переменной окружения GRAPHITE_CDP.
//
// Коды выхода: 0 — все проверки прошли; 1 — есть падение; 2 — живое окно не
// найдено (сценарий пропущен, гонять локально/в CI на собранном приложении).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const CDP = process.env.GRAPHITE_CDP ?? 'http://127.0.0.1:9222';
const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(here, 'shots');
mkdirSync(SHOTS, { recursive: true });

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_SKIP = 2;

/** Признак того, что предусловие сценария не выполнено — это не падение. */
export class SoftSkip extends Error {}

const isMainUrl = (u) => (u.includes('tauri.localhost') || u.includes('1420')) && !u.includes('window=');

/** Подключается к живому окну; при отсутствии приложения возвращает { skip:true }. */
export async function connectMain() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP);
  } catch {
    return { skip: true };
  }
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const candidate of ctx.pages()) {
      if (isMainUrl(candidate.url())) {
        page = candidate;
      }
    }
  }
  if (page === null) {
    await browser.close().catch(() => {});
    return { skip: true };
  }
  await page.bringToFront().catch(() => {});
  return { browser, page };
}

/**
 * Читает persist-корзину zustand из localStorage. По умолчанию форма
 * { state, version } — возвращаем именно slot state.
 */
export function readPersist(page, name) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
    } catch {
      return null;
    }
  }, name);
}

/**
 * Канонический ключ пути — как vaultKey в приложении: слэши к обратным, без
 * хвостового разделителя, в нижнем регистре. Нужен для сверки путей хранилищ
 * без ложных расхождений по регистру буквы диска или виду разделителя.
 */
export function vaultKey(path) {
  return String(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Последний сегмент пути — так же, как статус-бар подписывает хранилище. */
export function vaultName(path) {
  const segments = String(path).split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? String(path);
}

/** Виден ли экран выбора хранилища (по уникальной подписи приветствия). */
export function isGateVisible(page) {
  return page.evaluate(() => /Выберите её — и поехали/.test(document.body.innerText));
}

/** Текст статус-бара приложения (footer). */
export async function footerText(page) {
  return page.locator('footer').first().innerText();
}

/** Заголовок активной вкладки — прокси «какая заметка открыта сейчас». */
export function activeTabTitle(page) {
  return page.evaluate(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (tab === null) {
      return null;
    }
    const label = tab.querySelector('.truncate');
    return (label?.textContent ?? tab.textContent ?? '').trim();
  });
}

/** Переводит боковой раздел в «Заметки» и раскрывает панель дерева. */
export async function ensureNotesView(page) {
  await page.getByRole('button', { name: 'Заметки', exact: true }).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(250);
}

/** Открывает экран настроек и ждёт заголовок. */
export async function gotoSettings(page) {
  await page.getByRole('button', { name: 'Настройки' }).first().click({ timeout: 4000 });
  await page.getByRole('heading', { name: 'Настройки' }).first().waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
}

/** Прокручивает секцию настроек по её id в зону видимости. */
export async function scrollToSection(page, id) {
  await page.evaluate((sectionId) => {
    document.getElementById(sectionId)?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, id);
  await page.waitForTimeout(250);
}

/** Сборщик шагов: PASS/FAIL/SKIP, скрины в e2e/shots, сводка и код выхода. */
export function makeRunner(page, prefix) {
  const results = [];
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === 'error') {
      errors.push(message.text().slice(0, 200));
    }
  };
  const onPageError = (error) => {
    errors.push('PAGEERROR ' + String(error).slice(0, 200));
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  let shotN = 0;
  const safe = (name) => name.replace(/[^\w а-яА-Я-]/g, '_').slice(0, 48);
  const shot = async (name) => {
    shotN += 1;
    try {
      await page.screenshot({ path: join(SHOTS, `${prefix}-${String(shotN).padStart(2, '0')}-${safe(name)}.png`) });
    } catch {
      /* окно могло перерисоваться — скрин не критичен */
    }
  };

  const step = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
      await shot(name);
    } catch (error) {
      if (error instanceof SoftSkip) {
        results.push(`SKIP ${name} :: ${error.message}`);
        await shot('SKIP-' + name);
      } else {
        results.push(`FAIL ${name} :: ${String(error).split('\n')[0].slice(0, 140)}`);
        await shot('FAIL-' + name);
      }
    }
  };

  const note = (text) => {
    results.push(`NOTE ${text}`);
  };

  const finish = () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    const passes = results.filter((r) => r.startsWith('PASS')).length;
    const fails = results.filter((r) => r.startsWith('FAIL')).length;
    const skips = results.filter((r) => r.startsWith('SKIP')).length;
    console.log(`\n==== ${prefix} ====`);
    results.forEach((r) => console.log('  ' + r));
    if (errors.length > 0) {
      console.log(`  console errors (${errors.length}):`);
      [...new Set(errors)].slice(0, 12).forEach((e) => console.log('    ' + e));
    }
    console.log(`ИТОГО ${prefix}: ${passes} PASS, ${fails} FAIL, ${skips} SKIP`);
    return fails === 0 ? EXIT_PASS : EXIT_FAIL;
  };

  return { step, shot, note, results, errors, finish };
}

function skipExit(prefix) {
  console.log(`SKIP ${prefix}: живое окно Graphite не найдено на ${CDP}.`);
  console.log('  Поднимите приложение с --remote-debugging-port=9222 и повторите (локально/в CI на собранном приложении).');
  process.exit(EXIT_SKIP);
}

/** Одиночный прогон одного сценария: подключиться, выполнить, вывести код выхода. */
export async function runStandalone(prefix, run) {
  const conn = await connectMain();
  if (conn.skip === true) {
    skipExit(prefix);
    return;
  }
  const { browser, page } = conn;
  const runner = makeRunner(page, prefix);
  try {
    await run(page, runner);
  } catch (error) {
    runner.results.push('FAIL fatal :: ' + String(error).split('\n')[0].slice(0, 140));
  }
  const code = runner.finish();
  await browser.close().catch(() => {});
  process.exit(code);
}

/** true, если файл запущен напрямую (node e2e/x.spec.mjs), а не импортирован. */
export function isDirectRun(metaUrl) {
  return typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === metaUrl;
}
