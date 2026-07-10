# Graphite Sync

Лёгкий HTTP-сервис синхронизации заметок Graphite. Реализует **протокол синхронизации v1**
(тот же, что реализует клиент в приложении). Python 3.12, FastAPI + uvicorn, зависимости —
только `fastapi` и `uvicorn`. Один файл — `main.py`.

## Что это делает

Хранит «хранилища» заметок, идентифицируемые по коду доступа. Клиент шлёт код в заголовке
`Authorization: Bearer <код>`; сервер identifies хранилище как `sha256(код)` — **сам код нигде
не сохраняется**. Каждое хранилище — это набор файлов (с томбстоунами удалений) и монотонный
счётчик изменений `rev`.

### Код доступа
Формат `GRPH-XXXXX-XXXXX-XXXXX-XXXXX`, где `X` — символ алфавита Крокфорда (`0-9 A-Z` без
`I L O U`), 20 значащих символов = 100 бит энтропии. Неверный формат → `401`.

### Эндпоинты (база `https://telepasta.ru/graphite-sync`)
| Метод | Путь | Назначение |
|------|------|-----------|
| GET | `/health` | `{"ok":true,"service":"graphite-sync","v":1}`, без auth |
| POST | `/v1/vault` | создать/получить хранилище (идемпотентно) → `{vaultId, rev}` |
| GET | `/v1/manifest` | полный список файлов + томбстоуны → `{rev, files[]}` |
| GET | `/v1/changes?since=<int>` | только записи с `rev > since` |
| GET | `/v1/file?path=…` | сырые байты файла \| `404` |
| PUT | `/v1/file?path=…` | загрузить файл; опц. `X-If-Hash` (предусловие) → `409` при конфликте |
| DELETE | `/v1/file?path=…` | томбстоун; опц. `X-If-Hash` |

`X-If-Hash: <sha256 hex | "absent">` — предусловие на текущее серверное состояние файла;
несовпадение → `409 {"error":"conflict","hash":<актуальный|null>}`.

Пути: относительные, разделитель `/`, UTF-8. Запрещены `..`, `.`, пустые сегменты, ведущий `/`,
обратный слэш, `\0` → `400`. Лимиты: файл ≤ 20 МБ (`413`), хранилище ≤ 2 ГБ (`507`).

## Как задеплоено (прод-сервер 195.209.218.57, Ubuntu 24.04)

- **Код:** `/opt/graphite-sync/main.py`, владелец `root`.
- **venv:** `/opt/graphite-sync/venv` (`python3 -m venv`), в нём `fastapi` + `uvicorn`.
- **Данные:** `/var/lib/graphite-sync/<sha256(код)>/` — файлы в `data/` (вложенные каталоги по
  path), метаданные (`rev, hash, size, mtime, deleted`) в SQLite `index.db` (WAL).
  Владелец каталога данных — `www-data`.
- **Процесс:** systemd-юнит `graphite-sync.service` — `uvicorn main:app` на `127.0.0.1:8130`,
  один воркер, `User=www-data`, `Restart=always`, `MemoryMax=300M`. В автозагрузке (`enable`).
- **nginx:** в server-блок `telepasta.ru` (`listen 443 ssl`) добавлен
  `location /graphite-sync/ { … proxy_pass http://127.0.0.1:8130/; client_max_body_size 25m; }`
  (см. `nginx-location.conf`). Порт — **8130** (был свободен). Если порт меняли — он согласован
  в `graphite-sync.service`, `nginx-location.conf` и nginx-конфиге.

Файлы этого каталога:
- `main.py` — сам сервис.
- `graphite-sync.service` — systemd-юнит (копия установленного в `/etc/systemd/system/`).
- `nginx-location.conf` — блок для вставки в server `telepasta.ru:443`.
- `README.md` — этот файл.

## Эксплуатация

```bash
# статус / логи
sudo systemctl status graphite-sync
sudo journalctl -u graphite-sync -n 100 --no-pager

# перезапуск / после правки main.py
sudo systemctl restart graphite-sync

# после правки юнита
sudo systemctl daemon-reload && sudo systemctl restart graphite-sync

# проверка здоровья
curl -s https://telepasta.ru/graphite-sync/health
```

### Обновление кода
```bash
# скопировать новый main.py в /opt/graphite-sync/main.py, затем:
sudo systemctl restart graphite-sync
```

### nginx
Перед правкой конфига делается копия с таймстампом; после — `sudo nginx -t`, и только при успехе
`sudo systemctl reload nginx`. Если `nginx -t` падает — откатить копию.

## Локальный запуск (для разработки)
```bash
python3 -m venv venv && . venv/bin/activate
pip install fastapi uvicorn
GRAPHITE_SYNC_DATA=./_data python main.py   # слушает 127.0.0.1:8130
```
