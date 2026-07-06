// Прогон всех новых spec-сценариев Graphite по одному живому окну (через CDP).
// Запуск: node e2e/run-specs.mjs
// Требуется поднятое приложение с --remote-debugging-port=9222 (см. _harness.mjs).
//
// Коды выхода: 0 — все прошли; 1 — хотя бы одно падение; 2 — окно не найдено.
import { connectMain, makeRunner, EXIT_PASS, EXIT_FAIL, EXIT_SKIP } from './_harness.mjs';
import * as persist from './vault-persist.spec.mjs';
import * as vaultSwitch from './vault-switch.spec.mjs';
import * as theme from './theme-dracula.spec.mjs';
import * as nav from './nav-history.spec.mjs';
import * as autopush from './github-autopush.spec.mjs';

const SPECS = [persist, vaultSwitch, theme, nav, autopush];

async function main() {
  const conn = await connectMain();
  if (conn.skip === true) {
    console.log('SKIP всех сценариев: живое окно Graphite не найдено на CDP.');
    console.log('  Поднимите приложение с --remote-debugging-port=9222 и повторите.');
    process.exit(EXIT_SKIP);
    return;
  }
  const { browser, page } = conn;
  let failed = false;
  for (const spec of SPECS) {
    const runner = makeRunner(page, spec.prefix);
    try {
      await spec.run(page, runner);
    } catch (error) {
      runner.results.push('FAIL fatal :: ' + String(error).split('\n')[0].slice(0, 140));
    }
    if (runner.finish() !== EXIT_PASS) {
      failed = true;
    }
  }
  await browser.close().catch(() => {});
  console.log(`\n==== СВОДКА: ${failed ? 'есть падения' : 'все сценарии зелёные'} ====`);
  process.exit(failed ? EXIT_FAIL : EXIT_PASS);
}

void main();
