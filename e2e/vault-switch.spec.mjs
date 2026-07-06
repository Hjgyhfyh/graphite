// Сценарий #2 — переключение между несколькими хранилищами.
//
// Дегустируем быстрый переключатель в рейле (кнопка-«диск», aria-label
// начинается с «Хранилище»): попап со списком известных хранилищ + действия
// «Открыть папку…» / «Создать хранилище…». Если известных хранилищ ≥2 —
// переключаемся по-настоящему (клик по другому пути), сверяем, что активный
// путь в graphite.vaults и подпись статус-бара сменились, затем возвращаемся на
// исходное. Если хранилище одно — проверяем присутствие переключателя и активной
// отметки, а реальное переключение помечаем SKIP (нужно второе хранилище: в
// настройках «Открыть другую…» — гонять локально/в CI).
//
// Второе хранилище не сидируется программно намеренно: withGlobalTauri выключен,
// а открытие произвольной папки идёт через нативный диалог ОС, недоступный из CDP.
import {
  isDirectRun,
  runStandalone,
  isGateVisible,
  readPersist,
  footerText,
  vaultKey,
  vaultName,
  SoftSkip,
} from './_harness.mjs';

export const prefix = 'switch';

async function waitActivePath(page, targetKey, timeout = 12000) {
  await page.waitForFunction(
    (key) => {
      const raw = window.localStorage.getItem('graphite.vaults');
      if (raw === null) {
        return false;
      }
      try {
        const parsed = JSON.parse(raw);
        const state = parsed !== null && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
        const active = String(state?.activePath ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        return active === key;
      } catch {
        return false;
      }
    },
    targetKey,
    { timeout },
  );
}

async function openSwitcher(page) {
  await page.getByRole('button', { name: /^Хранилище/ }).first().click({ timeout: 4000 });
  await page.getByText(/Открыть папку/).first().waitFor({ timeout: 3000 });
}

export async function run(page, r) {
  if (await isGateVisible(page)) {
    r.note('SKIP: открыт экран выбора хранилища — переключать нечего.');
    return;
  }

  const vaults = await readPersist(page, 'graphite.vaults');
  const known = Array.isArray(vaults?.known) ? vaults.known.filter((v) => typeof v?.path === 'string') : [];
  const activeKey = typeof vaults?.activePath === 'string' ? vaultKey(vaults.activePath) : undefined;

  await r.step('переключатель хранилищ открывается', async () => {
    await openSwitcher(page);
    const hasActions = await page.evaluate(() => /Создать хранилище/.test(document.body.innerText));
    if (!hasActions) {
      throw new Error('в попапе нет действий открыть/создать хранилище');
    }
  });

  if (known.length < 2) {
    await r.step('активное хранилище отмечено в списке', async () => {
      if (known.length === 0) {
        throw new SoftSkip('список известных хранилищ пуст — нечего отмечать');
      }
      const activeName = activeKey !== undefined
        ? (known.find((v) => vaultKey(v.path) === activeKey)?.name ?? vaultName(vaults.activePath))
        : known[0].name;
      const visible = await page.evaluate((name) => document.body.innerText.includes(name), activeName);
      if (!visible) {
        throw new Error(`активное хранилище «${activeName}» не показано в списке`);
      }
    });
    r.note(
      'SKIP реального переключения: известно меньше двух хранилищ. Добавьте второе (Настройки → Хранилище → «Открыть другую…») и повторите — сценарий переключится по-настоящему.',
    );
    await page.keyboard.press('Escape').catch(() => {});
    return;
  }

  const target = known.find((v) => activeKey === undefined || vaultKey(v.path) !== activeKey);
  const original = known.find((v) => activeKey !== undefined && vaultKey(v.path) === activeKey) ?? known[0];

  await r.step(`переключиться на «${target.name}»`, async () => {
    await page.locator('button', { hasText: target.path }).first().click({ timeout: 4000 });
    await waitActivePath(page, vaultKey(target.path));
  });

  await r.step('статус-бар показывает новое хранилище', async () => {
    const foot = await footerText(page);
    if (!foot.toLowerCase().includes(vaultName(target.path).toLowerCase())) {
      throw new Error(`нет «${vaultName(target.path)}» в статус-баре: ${foot.slice(0, 90)}`);
    }
  });

  await r.step(`вернуться на «${original.name}»`, async () => {
    await openSwitcher(page);
    await page.locator('button', { hasText: original.path }).first().click({ timeout: 4000 });
    await waitActivePath(page, vaultKey(original.path));
  });
}

if (isDirectRun(import.meta.url)) {
  void runStandalone(prefix, run);
}
