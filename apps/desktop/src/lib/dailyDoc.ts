import type { NoteRef } from '@graphite/bindings';

/** Папка записей дневника в хранилище. */
export const DAILY_FOLDER = 'Дневник';

/** Пользовательский шаблон записи дня; поддерживает {{date}}, {{title}} и {{time}}. */
export const DAILY_TEMPLATE_REF: NoteRef = 'path:Шаблоны/Дневник.md';

/** Ссылка на файл записи дня по дате `ГГГГ-ММ-ДД`. */
export function dailyRef(date: string): NoteRef {
  return `path:${DAILY_FOLDER}/${date}.md`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Локальная дата `ГГГГ-ММ-ДД` без UTC-сдвига. */
export function todayYmd(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isoNowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(): string {
  const chars = new Array<string>(26);
  let time = Date.now();
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = ULID_ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  for (let i = 0; i < 16; i += 1) {
    chars[10 + i] = ULID_ALPHABET[random[i] % 32];
  }
  return chars.join('');
}

/** Тело записи дня: пользовательский шаблон с подстановками либо встроенный каркас. */
function dailyBody(date: string, templateBody?: string): string {
  if (templateBody === undefined) {
    return `# ${date}\n\n## Заметки дня\n\n## Задачи\n`;
  }
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return templateBody.replaceAll('{{date}}', date).replaceAll('{{title}}', date).replaceAll('{{time}}', time);
}

/**
 * Виртуальный документ записи дня — то, что ляжет на диск при первом вводе.
 * Формат зеркалит `ensure_daily_note`: frontmatter типа journal плюс тело
 * шаблона, чтобы файл, созданный из черновика, был неотличим от серверного.
 */
export function buildDailyDoc(date: string, templateBody?: string): string {
  const now = isoNowUtc();
  const frontmatter = [
    '---',
    `id: ${ulid()}`,
    'type: journal',
    `title: ${yamlQuote(date)}`,
    'status: inbox',
    `created: ${now}`,
    `updated: ${now}`,
    '---',
    '',
    '',
  ].join('\n');
  return frontmatter + dailyBody(date, templateBody);
}
