// Сценарий #1 — persist хранилища: после перезапуска открывается то же хранилище.
//
// Что проверяем на живом окне: перезапуск webview (page.reload) заново гоняет
// bootstrapVault(). Активный путь восстанавливается из persist-корзины
// graphite.vaults (activePath), а ядро домонтирует последний vault по своему
// указателю last-vault.json — до первого рендера. После перезапуска: не показан
// экран выбора, активный путь тот же (сверка по каноническому ключу), а имя
// папки видно в статус-баре.
//
// Полный перезапуск ОС-процесса покрыт теми же двумя механизмами
// (localStorage graphite.vaults + ядровой last-vault.json); его можно
// подтвердить вручную/в CI, закрыв и снова открыв собранное приложение.
import { isDirectRun, runStandalone, isGateVisible, readPersist, footerText, vaultKey, vaultName } from './_harness.mjs';

export const prefix = 'persist';

export async function run(page, r) {
  if (await isGateVisible(page)) {
    r.note('SKIP всего сценария: открыт экран выбора хранилища. Откройте папку и повторите.');
    return;
  }

  let before;
  await r.step('снимок активного хранилища до перезапуска', async () => {
    const vaults = await readPersist(page, 'graphite.vaults');
    const activePath = vaults?.activePath;
    if (typeof activePath !== 'string' || activePath.length === 0) {
      r.note('activePath пуст в graphite.vaults — persist сверяем по статус-бару');
    }
    const foot = await footerText(page);
    before = { activePath: activePath ?? null, foot };
  });

  await r.step('перезапуск окна восстанавливает то же хранилище', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const gate = /Выберите её — и поехали/.test(document.body.innerText);
        const foot = document.querySelector('footer');
        return !gate && foot !== null && !/Vault не открыт/.test(foot.innerText) && foot.innerText.trim().length > 0;
      },
      undefined,
      { timeout: 12000 },
    );

    const vaults = await readPersist(page, 'graphite.vaults');
    const after = vaults?.activePath ?? null;
    if (before.activePath !== null) {
      if (after === null) {
        throw new Error('после перезапуска activePath потерян');
      }
      if (vaultKey(after) !== vaultKey(before.activePath)) {
        throw new Error(`activePath изменился: ${before.activePath} -> ${after}`);
      }
    }
  });

  await r.step('статус-бар показывает то же хранилище', async () => {
    const foot = await footerText(page);
    const expected = before.activePath !== null ? vaultName(before.activePath) : before.foot.trim();
    if (expected.length > 0 && !foot.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`в статус-баре нет «${expected}»: ${foot.slice(0, 90)}`);
    }
  });

  await r.step('экран выбора хранилища не показан', async () => {
    if (await isGateVisible(page)) {
      throw new Error('после перезапуска показан экран выбора — хранилище не восстановилось');
    }
  });
}

if (isDirectRun(import.meta.url)) {
  void runStandalone(prefix, run);
}
