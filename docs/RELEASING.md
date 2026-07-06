# Релизы и авто-обновление Graphite

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

1. Поднимите версию в `apps/desktop/src-tauri/tauri.conf.json` (`"version"`).
2. Закоммитьте и запушьте в `Hjgyhfyh/graphite`.
3. Поставьте тег и запушьте его:
   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. GitHub Actions (`.github/workflows/release.yml`) соберёт Windows-установщик,
   подпишет его, создаст Release и приложит `latest.json` + `*-setup.exe` + `*.sig`.
5. У всех установленных копий при следующем запуске появится карточка обновления.

Ручная проверка обновлений — в приложении: **Настройки → Обновления → Проверить**.
