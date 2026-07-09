import { commands, isGraphiteError } from '@graphite/bindings';
import type { BriefNoteFile, BriefSnapshot } from '../../stores/briefStore';

/** Потолок на одну опорную заметку — защита от заметок-гигантов. */
export const NOTE_MAX_CHARS = 24_000;

export interface ComposedBrief {
  text: string;
  chars: number;
  notesIncluded: number;
  truncatedTitles: string[];
}

const INTRO =
  'Ниже — бриф задачи, собранный из моей базы знаний. Структура: цель, описание, ' +
  'опорные материалы (содержимое заметок уже включено, внешние файлы даны путями) и мои направления. ' +
  'Прочитай всё как одно задание и выполни его по существу.';

const EXTERNAL_NOTE =
  'Внешние файлы в состав брифа не включены — прочитай их с диска по путям из списка выше перед началом работы.';

const HOW_TO =
  '## Как выполнять\n\n' +
  'Ты — агент, получивший этот бриф как задание. Порядок работы:\n' +
  '1. Изучи цель и описание; содержимое заметок дано выше в <context>, внешние файлы прочитай с диска сам.\n' +
  '2. Держись раздела «Направления от меня» — это рамки решения, их не нарушать.\n' +
  '3. Составь короткий план, затем выполни задачу по существу. Если критичных данных не хватает — сначала задай вопросы, не выдумывай.';

const TRUNCATED_MARK = '_(содержимое обрезано по лимиту)_';

interface NoteSection {
  text: string;
  truncated: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function stampNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isUnavailable(error: unknown): boolean {
  return isGraphiteError(error) && error.code === 'UNAVAILABLE';
}

function noteReadError(title: string, error: unknown): Error {
  const detail = isGraphiteError(error)
    ? error.code === 'UNAVAILABLE'
      ? 'Ядро ещё не подключено'
      : error.message
    : 'не удалось прочитать содержимое';
  return new Error(`Не удалось прочитать «${title}»: ${detail}`);
}

/** Секция заметки в формате CopyPageButton.renderSection — фоллбек без ядра бандлов. */
function renderNoteFallback(path: string, title: string, content: string): string {
  return `## ${title}\n\n> Источник: ${path}\n\n${content.trim()}`;
}

function noteFilesOf(draft: BriefSnapshot): BriefNoteFile[] {
  return draft.files.filter((file): file is BriefNoteFile => file.kind === 'note');
}

function fileLine(kindLabel: string, path: string, why: string): string {
  const trimmedWhy = why.trim();
  return `- ${kindLabel}: \`${path}\`${trimmedWhy.length > 0 ? ` — ${trimmedWhy}` : ''}`;
}

/** Многострочное направление остаётся одним пунктом списка: продолжения с отступом. */
function directionItem(text: string, index: number): string {
  return `${index}. ${text.split('\n').join('\n   ')}`;
}

function renderBrief(draft: BriefSnapshot, noteSections: string[]): string {
  const idea = draft.idea.trim();
  const description = draft.description.trim();
  const noteFiles = noteFilesOf(draft);
  const externalFiles = draft.files.filter((file) => file.kind === 'external');
  const directions = draft.directions.map((d) => d.text.trim()).filter((text) => text.length > 0);

  const blocks: string[] = [
    `# Задание: ${idea}`,
    `> Бриф собран в Graphite · ${stampNow()}`,
    INTRO,
    `## Цель\n\n${idea}`,
  ];

  if (description.length > 0) {
    blocks.push(`## Описание\n\n${description}`);
  }

  if (draft.files.length > 0) {
    const lines = [
      ...noteFiles.map((file) => fileLine('Заметка', file.path, file.why)),
      ...externalFiles.map((file) => fileLine('Файл', file.path, file.why)),
    ];
    blocks.push(`## Опорные материалы\n\n${lines.join('\n')}`);
    if (noteSections.length > 0) {
      blocks.push(
        `### Содержимое заметок из хранилища\n\n<context>\n${noteSections.join('\n\n---\n\n')}\n</context>`,
      );
    }
    if (externalFiles.length > 0) {
      blocks.push(EXTERNAL_NOTE);
    }
  }

  if (directions.length > 0) {
    blocks.push(
      `## Направления от меня\n\n${directions.map((text, i) => directionItem(text, i + 1)).join('\n')}`,
    );
  }

  blocks.push(HOW_TO);
  return `${blocks.join('\n\n')}\n`;
}

async function readNoteSection(file: Pick<BriefNoteFile, 'ref' | 'title' | 'path'>): Promise<NoteSection> {
  try {
    const response = await commands.bundleCompose({
      ref: file.ref,
      includeLinked: false,
      maxChars: NOTE_MAX_CHARS,
    });
    return { text: response.text.trim(), truncated: response.truncated === true };
  } catch (error) {
    if (!isUnavailable(error)) {
      throw noteReadError(file.title, error);
    }
    try {
      const doc = await commands.noteRead({ ref: file.ref, maxChars: NOTE_MAX_CHARS });
      return {
        text: renderNoteFallback(file.path, doc.frontmatter.title ?? file.title, doc.content),
        truncated: doc.truncated === true,
      };
    } catch (fallbackError) {
      throw noteReadError(file.title, fallbackError);
    }
  }
}

/** Размер содержимого заметки для живого счётчика (тот же путь чтения, что и сборка). */
export async function readNoteChars(file: Pick<BriefNoteFile, 'ref' | 'title' | 'path'>): Promise<number> {
  const section = await readNoteSection(file);
  return section.text.length;
}

/**
 * Полная сборка брифа: содержимое опорных заметок читается через ядро бандлов
 * (bundle_compose, как «Copy Page»), при недоступности — noteRead-фоллбек.
 * Ошибка чтения любой заметки прерывает сборку целиком — частичный бриф не отдаём.
 */
export async function composeBrief(draft: BriefSnapshot): Promise<ComposedBrief> {
  const noteFiles = noteFilesOf(draft);
  const sections: string[] = [];
  const truncatedTitles: string[] = [];
  for (const file of noteFiles) {
    const section = await readNoteSection(file);
    sections.push(section.truncated ? `${section.text}\n\n${TRUNCATED_MARK}` : section.text);
    if (section.truncated) {
      truncatedTitles.push(file.title);
    }
  }
  const text = renderBrief(draft, sections);
  return { text, chars: text.length, notesIncluded: noteFiles.length, truncatedTitles };
}

/**
 * Синхронная оценка размера брифа для счётчика: каркас шаблона с пустыми
 * секциями плюс закешированные размеры заметок. Без IPC, честно помечается «≈».
 */
export function estimateBriefChars(draft: BriefSnapshot): number {
  const noteFiles = noteFilesOf(draft);
  const skeleton = renderBrief(
    draft,
    noteFiles.map(() => ''),
  );
  let total = skeleton.length;
  for (const file of noteFiles) {
    total += file.chars ?? 0;
  }
  return total;
}

/** Название заметки-плана: без запрещённых в именах файлов символов, до 80 знаков. */
export function briefNoteTitle(idea: string): string {
  const cleaned = `Бриф: ${idea}`.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...cleaned];
  if (chars.length <= 80) {
    return cleaned;
  }
  return `${chars.slice(0, 79).join('').trimEnd()}…`;
}

export function formatChars(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const format = (value: number, unit: string): string =>
    `${value.toFixed(1).replace('.', ',').replace(/,0$/, '')} ${unit}`;
  if (n < 1_000_000) {
    return format(n / 1000, 'тыс.');
  }
  return format(n / 1_000_000, 'млн');
}

export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}
