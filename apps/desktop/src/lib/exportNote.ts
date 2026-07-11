import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { collectImageTargets, parseBlocks, renderBodyHtml, splitFrontmatter } from '@graphite/editor';
import type { MdBlock, MdInline } from '@graphite/editor';
import { useEditorViewsStore } from '../stores/editorViewsStore';
import { titleFromRef } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';

/* ------------------------------------------------------------------ */
/* Экспорт заметки: автономный HTML, копия markdown и системная печать. */
/* Документ берётся из живого буфера редактора (включая несохранённые   */
/* правки); с диска — только когда заметка нигде не открыта.            */
/* ------------------------------------------------------------------ */

function describeError(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

function pushError(error: unknown, fallback: string): void {
  useUiStore.getState().pushToast({ kind: 'error', text: describeError(error, fallback) });
}

/** Текст заметки: живой буфер открытого редактора, иначе чтение с диска. */
async function docFor(noteRef: NoteRef): Promise<string> {
  const live = Object.values(useEditorViewsStore.getState().views).find((entry) => entry.noteRef === noteRef);
  if (live !== undefined) {
    return live.view.state.sliceDoc();
  }
  const note = await commands.noteRead({ ref: noteRef });
  return note.content;
}

/** Заголовок документа: title из frontmatter, иначе имя файла. */
function noteTitle(doc: string, noteRef: NoteRef): string {
  const entries = splitFrontmatter(doc)?.frontmatter.entries;
  const title = entries?.find((entry) => entry.key === 'title')?.value.trim();
  return title !== undefined && title.length > 0 ? title : titleFromRef(noteRef);
}

/** Зеркало `writer::sanitize_file_name`: имя без запрещённых под Windows символов. */
function fileStem(title: string): string {
  let stem = '';
  for (const ch of title) {
    stem += '\\/:*?"<>|'.includes(ch) || ch.charCodeAt(0) < 0x20 ? '—' : ch;
  }
  stem = stem.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  return stem.length > 0 ? stem : 'Заметка';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Плоский текст инлайн-узлов — для сравнения первого заголовка с title. */
function inlineText(nodes: readonly MdInline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'tag':
        out += `#${node.value}`;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out += inlineText(node.children);
        break;
      case 'wikilink':
        out += node.label;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Дублирует ли тело собственный заголовок: первый H1 совпадает с title. */
function bodyRepeatsTitle(blocks: readonly MdBlock[], title: string): boolean {
  const first = blocks.find((block) => block.kind === 'heading');
  return (
    first !== undefined &&
    first.kind === 'heading' &&
    first.level === 1 &&
    inlineText(first.content).trim().toLowerCase() === title.trim().toLowerCase()
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('не удалось прочитать картинку'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Читает вложения-картинки документа и возвращает карту «путь → data-URI»,
 * чтобы экспорт оставался одним автономным файлом. Ошибка отдельной картинки
 * не валит экспорт — в HTML остаётся исходный путь.
 */
async function inlineImages(blocks: readonly MdBlock[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const targets = collectImageTargets(blocks);
  if (targets.length === 0) {
    return map;
  }
  let root: string;
  try {
    root = (await commands.vaultInfo()).root;
  } catch {
    return map;
  }
  const base = root.replace(/[\\/]+$/, '');
  await Promise.all(
    targets.map(async (target) => {
      try {
        const rel = target.replace(/^\.\//, '');
        const abs = /^[A-Za-z]:[\\/]/.test(rel) ? rel : `${base}/${rel}`;
        const response = await fetch(convertFileSrc(abs));
        if (!response.ok) {
          return;
        }
        map[target] = await blobToDataUrl(await response.blob());
      } catch {
        // картинка не прочиталась — оставляем исходный путь
      }
    }),
  );
  return map;
}

/** Светлая палитра и типографика режима чтения — документ живёт вне приложения. */
const EXPORT_STYLE = `
:root { color-scheme: light; }
body {
  margin: 0;
  background: #ffffff;
  color: #1f2430;
  font-family: "Source Serif 4", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
}
main { max-width: 72ch; margin: 0 auto; padding: 48px 24px; font-size: 17px; line-height: 28px; }
h1, h2, h3, h4, h5, h6 { color: #14161d; line-height: 1.25; letter-spacing: -0.01em; }
h1 { font-size: 28px; margin: 40px 0 16px; }
h2 { font-size: 22px; margin: 36px 0 12px; }
h3 { font-size: 18px; margin: 28px 0 8px; }
h4, h5, h6 { font-size: 16px; margin: 24px 0 8px; }
main > :first-child { margin-top: 0; }
p { margin: 0 0 16px; }
a { color: #4f46e5; text-decoration: underline; text-decoration-color: rgba(79, 70, 229, 0.4); text-underline-offset: 2px; }
.wikilink { color: #4f46e5; border-bottom: 1px dashed rgba(79, 70, 229, 0.5); }
.tag { color: #4f46e5; background: rgba(79, 70, 229, 0.08); border-radius: 999px; padding: 1px 7px; }
blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 2px solid #e5e7eb; color: #565d6b; font-style: italic; }
blockquote > :last-child { margin-bottom: 0; }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; font-size: 0.88em; background: #f4f4f6; border-radius: 4px; padding: 1px 5px; }
pre { margin: 0 0 16px; padding: 14px 16px; background: #f4f4f6; border: 1px solid #e5e7eb; border-radius: 8px; overflow-x: auto; }
pre code { display: block; padding: 0; background: none; font-size: 13px; line-height: 20px; }
hr { margin: 28px 0; border: 0; border-top: 1px solid #e5e7eb; }
img { max-width: 100%; border-radius: 8px; }
ul.list { list-style: none; margin: 0 0 16px; padding: 0; }
ul.list li { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 6px; }
ul.list li > span:last-child { flex: 1; }
ul.list .bullet { flex: none; width: 6px; height: 6px; margin-top: 11px; border-radius: 999px; background: #9aa1ad; }
ul.list .num { flex: none; min-width: 1.4em; margin-top: 2px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #6b7280; }
li.task input { flex: none; width: 15px; height: 15px; margin: 6px 0 0; accent-color: #4f46e5; }
li.task.done > span { color: #6b7280; text-decoration: line-through; }
@media print {
  main { max-width: none; padding: 0; }
}
`;

/** Оборачивает тело в полный автономный документ; withTitle — добавить шапку-`<h1>`. */
function buildHtmlDocument(title: string, bodyHtml: string, withTitle: boolean): string {
  const safeTitle = escapeHtml(title);
  const heading = withTitle ? `<h1>${safeTitle}</h1>\n` : '';
  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${safeTitle}</title>`,
    `<style>${EXPORT_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `${heading}${bodyHtml}`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Полный HTML заметки: frontmatter в тело не попадает, картинки — data-URI. */
async function renderNoteHtml(doc: string, noteRef: NoteRef): Promise<string> {
  const split = splitFrontmatter(doc);
  const blocks = split !== null ? parseBlocks(split.body) : parseBlocks(doc);
  const images = await inlineImages(blocks);
  const body = renderBodyHtml(blocks, { resolveImageSrc: (target) => images[target] });
  const title = noteTitle(doc, noteRef);
  return buildHtmlDocument(title, body, !bodyRepeatsTitle(blocks, title));
}

interface SaveTarget {
  dialogTitle: string;
  defaultPath: string;
  filterName: string;
  extensions: string[];
}

/** Системный диалог сохранения; null — пользователь передумал. */
async function pickDestination(target: SaveTarget): Promise<string | null> {
  const dest = await invoke<string | null>('plugin:dialog|save', {
    options: {
      title: target.dialogTitle,
      defaultPath: target.defaultPath,
      filters: [{ name: target.filterName, extensions: target.extensions }],
    },
  });
  return typeof dest === 'string' ? dest : null;
}

/** Тост об успехе с переходом к готовому файлу в проводнике. */
function toastSaved(dest: string): void {
  const name = dest.split(/[\\/]/).pop() ?? dest;
  useUiStore.getState().pushToast({
    kind: 'success',
    text: `Экспортировано: ${name}`,
    action: {
      label: 'Показать в папке',
      run: () => {
        invoke('plugin:opener|reveal_item_in_dir', { paths: [dest] }).catch(() => {
          /* показ в проводнике — по возможности */
        });
      },
    },
  });
}

/** Экспорт в автономный HTML: светлая тема, стили и картинки внутри файла. */
export async function exportNoteHtml(noteRef: NoteRef): Promise<void> {
  try {
    const doc = await docFor(noteRef);
    const html = await renderNoteHtml(doc, noteRef);
    const dest = await pickDestination({
      dialogTitle: 'Экспорт в HTML',
      defaultPath: `${fileStem(noteTitle(doc, noteRef))}.html`,
      filterName: 'HTML',
      extensions: ['html'],
    });
    if (dest === null) {
      return;
    }
    await commands.exportWrite({ destPath: dest, contents: html });
    toastSaved(dest);
  } catch (error) {
    pushError(error, 'Не удалось экспортировать в HTML');
  }
}

/** Копия исходного markdown байт-в-байт, включая frontmatter. */
export async function exportNoteMarkdown(noteRef: NoteRef): Promise<void> {
  try {
    const doc = await docFor(noteRef);
    const dest = await pickDestination({
      dialogTitle: 'Копия Markdown',
      defaultPath: `${fileStem(noteTitle(doc, noteRef))}.md`,
      filterName: 'Markdown',
      extensions: ['md'],
    });
    if (dest === null) {
      return;
    }
    await commands.exportWrite({ destPath: dest, contents: doc });
    toastSaved(dest);
  } catch (error) {
    pushError(error, 'Не удалось сохранить копию');
  }
}

const PRINT_FRAME_LIFETIME_MS = 60_000;

/** Скрытый iframe с готовым HTML: печатается только заметка, не интерфейс. */
function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  let done = false;
  const cleanup = (): void => {
    if (!done) {
      done = true;
      frame.remove();
    }
  };
  frame.onload = () => {
    const win = frame.contentWindow;
    if (win === null) {
      cleanup();
      return;
    }
    win.addEventListener('afterprint', cleanup);
    win.focus();
    win.print();
  };
  frame.srcdoc = html;
  document.body.appendChild(frame);
  // страховка: не всякий webview шлёт afterprint — кадр уберётся в любом случае
  window.setTimeout(cleanup, PRINT_FRAME_LIFETIME_MS);
}

/** Печать или сохранение в PDF через системное окно печати. */
export async function printNote(noteRef: NoteRef): Promise<void> {
  try {
    const doc = await docFor(noteRef);
    printHtml(await renderNoteHtml(doc, noteRef));
  } catch (error) {
    pushError(error, 'Не удалось подготовить печать');
  }
}
