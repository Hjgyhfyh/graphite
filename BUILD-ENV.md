# Сборка на этой машине (Windows 11, без admin)

Node 22 / pnpm 10 / Rust 1.95 (MSVC BuildTools) стоят. Системный Windows SDK НЕПОЛНЫЙ (нет um-libs/ucrt), прав admin нет — Rust собирается только с портативным SDK (xwin). Фронт (pnpm/tsc/vite) собирается без всего этого.

## Обязательное окружение для ЛЮБОЙ команды cargo / tauri

```powershell
$VCT = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
$XW  = "C:\Users\lesab\.xwin"
$env:INCLUDE = "$VCT\include;$XW\sdk\include\ucrt;$XW\sdk\include\um;$XW\sdk\include\shared"
$env:LIB     = "$VCT\lib\x64;$XW\sdk\lib\um\x86_64;$XW\sdk\lib\ucrt\x86_64"
$env:RC      = "$XW\rcbin\rc.exe"
$env:PATH    = "$VCT\bin\Hostx64\x64;$XW\rcbin;$env:PATH"
```

## Правила (нарушение = потерянные часы)

1. **Переменные окружения НЕ живут между вызовами PowerShell-тула.** Блок env выше и команду cargo склеивай в ОДИН вызов (через `;`).
2. Только PowerShell. Никаких .bat/.cmd — ломаются на кириллице пути «Рабочий стол».
3. Путь репозитория содержит пробелы и кириллицу — всегда в кавычках.
4. cargo НЕ прогонять через pipe (`| tail`, `| Select -Last`) — теряется exit code. Запускать как есть.
5. Никаких долгоживущих процессов (`pnpm tauri dev`, `vite dev`) — только check/build/test.
6. Первый `cargo check` тянет и компилит весь стек tauri — это 10–20 минут, не убивать по таймауту раньше 600000 мс.
