// Сценарий #3 — тема Dracula: выбор применяет data-theme на <html> и сохраняется.
//
// Настройки → Внешний вид → сегмент-контрол «Тема оформления». Клик по «Dracula»:
// на <html> появляется data-theme="dracula", кнопка получает aria-pressed=true,
// выбор пишется в persist graphite.ui (theme). Перезапуск окна (page.reload)
// подтверждает сохранение — main.tsx применяет тему из persist до первого рендера.
// В конце возвращаем тему «Графит» (data-theme снимается), чтобы не оставлять
// приложение перекрашенным.
import { isDirectRun, runStandalone, readPersist, gotoSettings, scrollToSection } from './_harness.mjs';

export const prefix = 'theme';

const htmlTheme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

export async function run(page, r) {
  await r.step('открыть Настройки → Внешний вид', async () => {
    await gotoSettings(page);
    await scrollToSection(page, 'appearance');
    await page.locator('[aria-label="Тема оформления"]').first().waitFor({ timeout: 5000 });
  });

  await r.step('выбор темы Dracula применяет data-theme', async () => {
    await page.getByRole('button', { name: 'Dracula' }).first().click({ timeout: 4000 });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dracula', undefined, {
      timeout: 4000,
    });
    const pressed = await page.getByRole('button', { name: 'Dracula' }).first().getAttribute('aria-pressed');
    if (pressed !== 'true') {
      throw new Error('кнопка Dracula не помечена aria-pressed=true');
    }
  });

  await r.step('тема сохранена в graphite.ui', async () => {
    const ui = await readPersist(page, 'graphite.ui');
    if (ui?.theme !== 'dracula') {
      throw new Error(`persist theme=${String(ui?.theme)} (ожидали dracula)`);
    }
  });

  await r.step('тема переживает перезапуск окна', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dracula', undefined, {
      timeout: 8000,
    });
  });

  await r.step('вернуть тему Графит (очистка)', async () => {
    await gotoSettings(page);
    await scrollToSection(page, 'appearance');
    await page.getByRole('button', { name: 'Графит' }).first().click({ timeout: 5000 });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === null, undefined, {
      timeout: 4000,
    });
    const ui = await readPersist(page, 'graphite.ui');
    if (ui?.theme !== 'default') {
      throw new Error(`persist theme после сброса=${String(ui?.theme)} (ожидали default)`);
    }
    if ((await htmlTheme(page)) !== null) {
      throw new Error('data-theme не снят после возврата к Графиту');
    }
  });
}

if (isDirectRun(import.meta.url)) {
  void runStandalone(prefix, run);
}
