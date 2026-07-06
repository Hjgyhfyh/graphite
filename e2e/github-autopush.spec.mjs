// Сценарий #5 — наличие и переключение тумблера авто-заливки на GitHub.
//
// Настройки → Копии (секция id="backup", BackupSection). Тумблер «Авто-отправка
// на GitHub» (autoPush в persist graphite.git) показывается только при
// подключённом удалённом репозитории. Всегда проверяем присутствие секции и путь
// к тумблеру (поле удалённого репозитория / кнопка подключения / подсказка про
// Git). Если строка авто-отправки уже видна — переключаем тумблер, сверяем, что
// aria-checked и persist autoPush сменились, и возвращаем в исходное состояние.
//
// Если репозиторий не подключён, реальное переключение помечаем SKIP (тумблера
// нет). Чтобы прогнать переключение в такой среде, задайте
// GRAPHITE_E2E_ALLOW_REMOTE=1 — тест подключит канонический remote Graphite,
// чтобы тумблер появился (меняет git-конфиг хранилища; по умолчанию выключено).
import {
  isDirectRun,
  runStandalone,
  readPersist,
  gotoSettings,
  scrollToSection,
  SoftSkip,
} from './_harness.mjs';

export const prefix = 'autopush';

const autoPushSwitch = (page) =>
  page
    .locator('div')
    .filter({ hasText: 'Авто-отправка на GitHub' })
    .filter({ has: page.locator('[role="switch"]') })
    .last()
    .locator('[role="switch"]');

async function waitAutoPush(page, expected, timeout = 5000) {
  await page.waitForFunction(
    (want) => {
      const raw = window.localStorage.getItem('graphite.git');
      if (raw === null) {
        return false;
      }
      try {
        const parsed = JSON.parse(raw);
        const state = parsed !== null && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
        return Boolean(state?.autoPush) === want;
      } catch {
        return false;
      }
    },
    expected,
    { timeout },
  );
}

async function backupText(page) {
  return page.evaluate(() => document.getElementById('backup')?.innerText ?? '');
}

export async function run(page, r) {
  await r.step('открыть Настройки → Копии', async () => {
    await gotoSettings(page);
    await scrollToSection(page, 'backup');
    await page.getByText('Резервные копии и история').first().waitFor({ timeout: 5000 });
  });

  await r.step('секция резервных копий присутствует', async () => {
    const text = await backupText(page);
    if (!/Резервные копии|История версий|Удалённый репозиторий|Git/.test(text)) {
      throw new Error(`секция backup пуста: ${text.slice(0, 90)}`);
    }
  });

  let hasRow = /Авто-отправка на GitHub/.test(await backupText(page));

  if (!hasRow && process.env.GRAPHITE_E2E_ALLOW_REMOTE === '1') {
    await r.step('подключить remote, чтобы показать тумблер', async () => {
      const connect = page.getByRole('button', { name: /Подключить репозиторий/ }).first();
      if ((await connect.count()) === 0 || !(await connect.isVisible().catch(() => false))) {
        throw new SoftSkip('нет кнопки подключения репозитория (нет истории версий/Git)');
      }
      await connect.click({ timeout: 5000 });
      await page.getByText('Авто-отправка на GitHub').first().waitFor({ timeout: 8000 });
      hasRow = true;
    });
  }

  if (!hasRow) {
    await r.step('доступен путь к авто-отправке (поле remote / подключение)', async () => {
      const text = await backupText(page);
      if (!/Удалённый репозиторий|Подключить репозиторий|История версий выключена|Git не установлен/.test(text)) {
        throw new Error('нет ни поля удалённого репозитория, ни подсказки про репозиторий');
      }
    });
    r.note(
      'SKIP переключения: тумблер «Авто-отправка на GitHub» появляется только при подключённом remote. Подключите репозиторий в «Копиях» (или задайте GRAPHITE_E2E_ALLOW_REMOTE=1) и повторите.',
    );
    return;
  }

  let original;
  await r.step('прочитать исходное состояние авто-отправки', async () => {
    const git = await readPersist(page, 'graphite.git');
    original = Boolean(git?.autoPush);
  });

  await r.step('переключить тумблер авто-отправки', async () => {
    const sw = autoPushSwitch(page);
    const before = (await sw.getAttribute('aria-checked')) === 'true';
    await sw.click({ timeout: 4000 });
    await waitAutoPush(page, !before);
    const after = (await sw.getAttribute('aria-checked')) === 'true';
    if (after === before) {
      throw new Error('aria-checked тумблера не изменился');
    }
  });

  await r.step('вернуть тумблер в исходное состояние', async () => {
    const sw = autoPushSwitch(page);
    await sw.click({ timeout: 4000 });
    await waitAutoPush(page, original);
  });
}

if (isDirectRun(import.meta.url)) {
  void runStandalone(prefix, run);
}
