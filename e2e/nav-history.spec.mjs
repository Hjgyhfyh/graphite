// Сценарий #4 — навигация назад/вперёд по истории заметок.
//
// В статус-баре живут кнопки истории (aria-label «Назад к прошлой заметке» /
// «Вперёд к следующей заметке»), доступные при открытом хранилище. Открываем две
// РАЗНЫЕ заметки из дерева, затем: «Назад» возвращает к первой (кнопка активна),
// «Вперёд» снова открывает вторую. «Какая заметка открыта» читаем по заголовку
// активной вкладки — это ровно то, что делает navStore.back/forward через
// openNote. Если в дереве меньше двух заметок (только папки) — SKIP.
import { isDirectRun, runStandalone, isGateVisible, ensureNotesView, activeTabTitle, SoftSkip } from './_harness.mjs';

export const prefix = 'nav';

const backBtn = (page) => page.getByRole('button', { name: 'Назад к прошлой заметке' }).first();
const fwdBtn = (page) => page.getByRole('button', { name: 'Вперёд к следующей заметке' }).first();

async function waitTabTitle(page, title, timeout = 5000) {
  await page.waitForFunction(
    (expected) => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      if (tab === null) {
        return false;
      }
      const label = tab.querySelector('.truncate');
      return (label?.textContent ?? tab.textContent ?? '').trim() === expected;
    },
    title,
    { timeout },
  );
}

export async function run(page, r) {
  if (await isGateVisible(page)) {
    r.note('SKIP: открыт экран выбора хранилища — истории заметок нет.');
    return;
  }

  await r.step('перейти к заметкам', async () => {
    await ensureNotesView(page);
    await page.getByRole('treeitem').first().waitFor({ timeout: 5000 });
  });

  let first;
  let second;
  await r.step('открыть две разные заметки', async () => {
    const items = page.getByRole('treeitem');
    const total = await items.count();
    if (total < 2) {
      throw new SoftSkip('в дереве меньше двух элементов');
    }
    const titles = [];
    const attempts = Math.min(total, 16);
    for (let i = 0; i < attempts && titles.length < 2; i += 1) {
      await items.nth(i).click({ timeout: 3500 }).catch(() => {});
      await page.waitForTimeout(220);
      const title = await activeTabTitle(page);
      if (typeof title === 'string' && title.length > 0 && !titles.includes(title)) {
        titles.push(title);
      }
    }
    if (titles.length < 2) {
      throw new SoftSkip('не удалось открыть две разные заметки (возможно, в дереве только папки)');
    }
    [first, second] = titles;
  });

  await r.step('кнопка «Назад» активна после навигации', async () => {
    if (first === undefined) {
      throw new SoftSkip('нет пары заметок для истории');
    }
    if (await backBtn(page).isDisabled()) {
      throw new Error('«Назад» неактивна, хотя история навигации есть');
    }
  });

  await r.step('«Назад» открывает предыдущую заметку', async () => {
    if (first === undefined) {
      throw new SoftSkip('нет пары заметок для истории');
    }
    await backBtn(page).click({ timeout: 4000 });
    await waitTabTitle(page, first);
  });

  await r.step('«Вперёд» возвращает к следующей заметке', async () => {
    if (second === undefined) {
      throw new SoftSkip('нет пары заметок для истории');
    }
    if (await fwdBtn(page).isDisabled()) {
      throw new Error('«Вперёд» неактивна после «Назад»');
    }
    await fwdBtn(page).click({ timeout: 4000 });
    await waitTabTitle(page, second);
  });
}

if (isDirectRun(import.meta.url)) {
  void runStandalone(prefix, run);
}
