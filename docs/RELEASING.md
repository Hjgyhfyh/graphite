# Релизы и авто-обновление Graphite

Версии — **MAJOR.MINOR.PATCH** ([semver](https://semver.org/lang/ru/)):

| Часть | Когда поднимать | Пример |
|---|---|---|
| MAJOR | несовместимый слом или новое поколение продукта | `1.0.0` → `2.0.0` |
| MINOR | новая возможность, старые данные живы | `1.0.0` → `1.1.0` |
| PATCH | правка без новой фичи | `1.0.0` → `1.0.1` |

Тег и GitHub Release всегда `vMAJOR.MINOR.PATCH` (`v1.0.0`, `v1.2.3`). Сравнивает апдейтер: `1.0.0` новее любого `0.1.x`.

История всех деплоев — [`CHANGELOG.md`](../CHANGELOG.md). Тело очередного GitHub Release — [`RELEASE_NOTES.md`](../RELEASE_NOTES.md) в корне.

Приложение обновляется само через **GitHub Releases** (плагин `tauri-plugin-updater`).
Пользователь видит карточку «Доступно обновление», жмёт «Обновить» — новая версия
скачивается и ставится прямо из приложения, затем перезапуск.

## Как это работает

1. В приложении зашит **публичный ключ** подписи (`tauri.conf.json → plugins.updater.pubkey`).
2. Апдейтер опрашивает эндпоинт:
   `https://github.com/Hjgyhfyh/graphite/releases/latest/download/latest.json`
3. Если версия в `latest.json` выше текущей — показывается карточка обновления.
4. Установщик скачивается, проверяется по подписи и ставится; `relaunch()` перезапускает.

## Ключи подписи (СЕКРЕТ — не в git)

- Приватный ключ: `C:\Users\lesab\.graphite-keys\graphite-updater.key`
- Пароль к нему: `C:\Users\lesab\.graphite-keys\password.txt`
- Публичный ключ: `C:\Users\lesab\.graphite-keys\graphite-updater.key.pub` (он же в конфиге)

Эти же секреты уже заведены в GitHub Actions репозитория `Hjgyhfyh/graphite`:
`TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

> Если приватный ключ потерять — выпускать подписанные обновления для уже
> установленных копий станет нельзя (только переустановка с новым ключом).
> Сделайте резервную копию папки `.graphite-keys` в надёжное место.

## Выпустить новую версию

1. Поднимите версию **везде одинаково**: `Cargo.toml` (`[workspace.package] version`), `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json`. Workspace-крейты берут её сами. Обновите `RELEASE_NOTES.md` (тело релиза) и `CHANGELOG.md`.
2. Закоммитьте и запушьте в `Hjgyhfyh/graphite`.
3. Поставьте тег и запушьте его:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. GitHub Actions (`.github/workflows/release.yml`) соберёт Windows-установщик,
   подпишет его, создаст Release и приложит `latest.json` + `*-setup.exe` + `*.sig`.
5. У всех установленных копий при следующем запуске появится карточка обновления.

Ручная проверка обновлений — в приложении: **Настройки → Обновления → Проверить**.
