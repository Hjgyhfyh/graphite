# Graphite

Локальный заметочник для Windows: markdown-файлы в вашей папке, живой редактор, дерево, канбан, граф связей, дневник, MCP для Claude Code. Без облака и аккаунтов.

## Запуск с этой машины

Нужны Node 22, pnpm 10 и Rust (MSVC Build Tools). Системный Windows SDK на этой машине неполный — перед любой командой `cargo` / `tauri` выставьте окружение из [`BUILD-ENV.md`](BUILD-ENV.md).

```powershell
cd C:\Users\lesab\graphite-work
pnpm install

# фронт
pnpm --filter desktop typecheck
pnpm --filter @graphite/editor test

# приложение (склейте env из BUILD-ENV.md в тот же вызов)
pnpm --filter desktop tauri dev
```

Первый `tauri dev` компилирует весь стек Tauri — это 10–20 минут, не убивать раньше.

Сборка установщика: `pnpm --filter desktop tauri build` (тот же env). Релизы и автообновление — [`docs/RELEASING.md`](docs/RELEASING.md).

## Что внутри

| Путь | Зачем |
|---|---|
| `apps/desktop` | Tauri 2 + React UI |
| `crates/vault-core` | парсер, индекс, единственный писатель vault |
| `crates/graphite-mcp` | MCP stdio → named pipe ядра |
| `packages/editor` | CodeMirror 6 live-preview |
| `docs/SPEC.md` | продукт и формат |

Формат хранилища заморожен в [`docs/vault-format.md`](docs/vault-format.md).
