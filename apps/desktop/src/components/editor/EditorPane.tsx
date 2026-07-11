import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ElementType, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Bold,
  BookOpen,
  CalendarDays,
  Check,
  Clock3,
  Code,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  ListChecks,
  PencilLine,
  Pilcrow,
  Scissors,
  Strikethrough,
} from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import {
  attachmentInsertPos,
  attachmentMarkdown,
  beginAttachmentUpload,
  createEditor,
  finishAttachmentUpload,
  headingLevelAt,
  inlineFormatState,
  openWikiLinkPicker,
  parseBlocks,
  setHeadingLevel,
  splitFrontmatter,
  sweepDoneTasks,
  sweepLinesDone,
  toggleCode,
  toggleInlineFormat,
  toggleTaskOnLine,
} from '@graphite/editor';
import type {
  EditorHandle,
  FrontmatterEntry,
  HeadingLevel,
  InlineMarker,
  MdBlock,
  MdInline,
  WikiLinkItem,
} from '@graphite/editor';
import { GRAPHITE_EVENT, commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteChangedEvent, NoteRef } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { convertFileSrc } from '@tauri-apps/api/core';
import { StatusPill, Tooltip, cx, easePoints } from '@graphite/ui';
import type { NoteStatus } from '@graphite/ui';
import { useEditorViewsStore } from '../../stores/editorViewsStore';
import { titleFromRef, useTabsStore } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Presence, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useActionHandler } from '../../app/Keymap';
import { NoteIcon, resolveIconColor } from '../tree/NoteIcon';
import { CopyPageButton } from '../bundle/CopyPageButton';
import { ExportMenu } from './ExportMenu';

export const WELCOME_NOTE_REF: NoteRef = 'path:Добро пожаловать.md';

const WELCOME_DOC = `# Добро пожаловать в Graphite

Это ваш локальный кабинет для заметок и планов. Всё хранится обычными
markdown-файлами в вашей папке — без облака и подписок.

## С чего начать

- Нажмите \`Ctrl+K\` — командная палитра
- Кнопка «+» над деревом — новая заметка
- Связывайте мысли двойными скобками: [[Моя первая заметка]]

## Задачи

- [ ] Создать первую заметку
- [ ] Открыть командную палитру
- [x] Установить Graphite

> Заметка становится знанием, когда она связана с другими.
`;

const SAVE_DEBOUNCE_MS = 600;
const READING_FONT =
  '"Source Serif 4 Variable", "Source Serif 4", "Iowan Old Style", "Palatino Linotype", Georgia, serif';

const pendingSaves = new Map<NoteRef, Promise<void>>();
const liveEditorFlushes = new Set<() => void>();

/**
 * Форсирует автосейв всех открытых «грязных» редакторов и дожидается уже
 * начатых записей. Нужен перед сменой хранилища: отложенный bufferSave
 * резолвит ref через текущий корень и после переключения записал бы заметку
 * уже в новый vault.
 */
export async function flushPendingSaves(): Promise<void> {
  for (const flush of [...liveEditorFlushes]) {
    flush();
  }
  await Promise.allSettled([...pendingSaves.values()]);
}

function describeError(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

/**
 * Фаззи-скоринг заголовка для пикера связей: все символы запроса встречаются
 * по порядку; слитные совпадения и старты слов ценнее, разрывы штрафуются.
 * `null` — заголовок не подходит.
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  let score = 0;
  let at = 0;
  let streak = 0;
  for (const ch of needle) {
    if (ch === ' ') {
      streak = 0;
      continue;
    }
    const found = haystack.indexOf(ch, at);
    if (found === -1) {
      return null;
    }
    const prev = found > 0 ? haystack[found - 1] : ' ';
    const wordStart = prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.';
    streak = found === at ? streak + 1 : 1;
    score += 1 + streak * 2 + (wordStart ? 6 : 0) - Math.min(found - at, 8) * 0.5;
    at = found + 1;
  }
  return score;
}

function openExternal(href: string): void {
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
  } catch {
    /* opening external links is best-effort outside the desktop shell */
  }
}

/* ------------------------------------------------------------------ */
/* Вложения (#29): сохранение, кэш превью и резолв ссылок на картинки  */
/* ------------------------------------------------------------------ */

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?|ico)$/i;
const EXTERNAL_SRC_RE = /^(?:https?:|data:|blob:|asset:|file:)/i;

/** Живые blob-URL вложений, вставленных в этой сессии: превью без чтения диска. */
const assetObjectUrls = new Map<string, string>();

let vaultRootPromise: Promise<string | undefined> | null = null;

function vaultRootPath(): Promise<string | undefined> {
  vaultRootPromise ??= commands
    .vaultInfo()
    .then((info) => info.root)
    .catch(() => {
      vaultRootPromise = null;
      return undefined;
    });
  return vaultRootPromise;
}

/** Сбрасывает кэш корня vault — вызывается при смене хранилища, иначе
 * относительные пути картинок продолжат резолвиться от прежнего корня. */
export function invalidateVaultRootCache(): void {
  vaultRootPromise = null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('не удалось прочитать изображение из буфера'));
    reader.readAsDataURL(blob);
  });
}

async function saveAttachmentBlob(blob: Blob, ext: string): Promise<string> {
  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(blob);
  } catch {
    throw new Error('Не удалось прочитать изображение из буфера');
  }
  try {
    const res = await commands.saveAttachment({ dataBase64: dataUrl, ext });
    const prior = assetObjectUrls.get(res.relPath);
    if (prior !== undefined) {
      URL.revokeObjectURL(prior);
    }
    assetObjectUrls.set(res.relPath, URL.createObjectURL(blob));
    return res.relPath;
  } catch (error) {
    throw new Error(describeError(error, 'Не удалось сохранить изображение'));
  }
}

function resolveImageSrc(target: string): string | Promise<string | undefined> | undefined {
  if (EXTERNAL_SRC_RE.test(target)) {
    return target;
  }
  const cached = assetObjectUrls.get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (!isTauriAvailable()) {
    return undefined;
  }
  return vaultRootPath().then((root) => {
    if (root === undefined) {
      return undefined;
    }
    const rel = target.replace(/^\.\//, '');
    const abs = /^[A-Za-z]:[\\/]/.test(rel) ? rel : `${root.replace(/[\\/]+$/, '')}/${rel}`;
    return convertFileSrc(abs);
  });
}

function openAttachment(target: string): void {
  if (isExternalHref(target)) {
    openExternal(target);
    return;
  }
  commands.revealInExplorer(`path:${target}`).catch(() => {
    useUiStore.getState().pushToast({ kind: 'info', text: 'Файл вложения не найден на диске' });
  });
}

/* ------------------------------------------------------------------ */
/* Режим чтения (#5, #6)                                                */
/* ------------------------------------------------------------------ */

const HEADING_TAG: Record<1 | 2 | 3 | 4 | 5 | 6, ElementType> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
};

const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'mb-4 mt-7 text-[28px] font-[650] leading-[34px] tracking-[-0.01em] text-text-0 first:mt-0',
  2: 'mb-3 mt-7 text-[22px] font-[600] leading-[30px] tracking-[-0.01em] text-text-0 first:mt-0',
  3: 'mb-2 mt-6 text-[18px] font-[600] leading-[26px] text-text-0 first:mt-0',
  4: 'mb-2 mt-5 text-[16px] font-[600] leading-[24px] text-text-1 first:mt-0',
  5: 'mb-2 mt-4 text-[15px] font-[600] text-text-2 first:mt-0',
  6: 'mb-2 mt-4 text-[15px] font-[600] text-text-2 first:mt-0',
};

interface InlineContext {
  onOpenLink: (target: string) => void;
  reduced: boolean;
}

function markerNumber(marker: string): string {
  const digits = marker.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : '1';
}

function changedRange(before: string, after: string): { from: number; to: number } | null {
  if (before === after) {
    return null;
  }
  const min = Math.min(before.length, after.length);
  let start = 0;
  while (start < min && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: Math.max(start, endAfter) };
}

function renderInline(nodes: readonly MdInline[], keyPrefix: string, ctx: InlineContext): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>;
      case 'strong':
        return (
          <strong key={key} className="font-[650] text-text-0">
            {renderInline(node.children, key, ctx)}
          </strong>
        );
      case 'em':
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key, ctx)}
          </em>
        );
      case 'del':
        return (
          <del key={key} className="text-text-2 line-through decoration-text-3">
            {renderInline(node.children, key, ctx)}
          </del>
        );
      case 'code':
        return (
          <code
            key={key}
            className="rounded-xs bg-bg-2 px-1 py-0.5 font-mono text-[0.88em] text-text-0"
          >
            {node.value}
          </code>
        );
      case 'tag':
        return (
          <span key={key} className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.92em] text-accent">
            #{node.value}
          </span>
        );
      case 'wikilink':
        return (
          <button
            key={key}
            type="button"
            onClick={() => ctx.onOpenLink(node.target)}
            className="rounded-xs text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {node.label}
          </button>
        );
      case 'link': {
        const external = isExternalHref(node.href);
        return (
          <a
            key={key}
            href={node.href}
            title={node.href}
            {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
            onClick={(event) => {
              event.preventDefault();
              if (external) {
                openExternal(node.href);
              } else {
                ctx.onOpenLink(node.href.replace(/\.md$/i, ''));
              }
            }}
            className="cursor-pointer rounded-xs text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {renderInline(node.children, key, ctx)}
          </a>
        );
      }
      default:
        return null;
    }
  });
}

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

const COPY_RESET_MS = 1600;

interface ReadingCodeBlockProps {
  block: Extract<MdBlock, { kind: 'code' }>;
  reduced: boolean;
}

function ReadingCodeBlock({ block, reduced }: ReadingCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetRef.current), []);

  const copy = () => {
    void navigator.clipboard
      .writeText(block.value)
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
      })
      .catch(() => {
        useUiStore.getState().pushToast({ kind: 'error', text: 'Буфер обмена недоступен' });
      });
  };

  return (
    <div className="group relative mb-4">
      <pre className="overflow-x-auto rounded-m border border-stroke-0 bg-bg-2 p-4">
        <code className="font-mono text-[13.5px] leading-[22px] text-text-1">{block.value}</code>
      </pre>
      <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
        {block.lang !== undefined ? (
          <span className="pointer-events-none rounded-full bg-bg-3/80 px-2 py-0.5 font-mono text-micro uppercase tracking-[0.06em] text-text-2 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100">
            {block.lang}
          </span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          aria-label="Скопировать код"
          title="Скопировать код"
          className={cx(
            'inline-flex h-7 w-7 items-center justify-center rounded-s border transition-all duration-[140ms]',
            copied
              ? 'border-ok/45 bg-bg-3 text-ok opacity-100'
              : 'border-stroke-1 bg-bg-3 text-text-1 opacity-0 hover:bg-bg-4 hover:text-text-0 focus-visible:opacity-100 active:scale-95 group-hover:opacity-100',
          )}
        >
          <motion.span
            key={copied ? 'done' : 'idle'}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reduced ? { duration: 0.08 } : springSnappy}
            className="inline-flex"
          >
            {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={1.75} />}
          </motion.span>
        </button>
      </div>
    </div>
  );
}

interface ReadingItemProps {
  block: Extract<MdBlock, { kind: 'list' }>['items'][number];
  keyPrefix: string;
  ctx: InlineContext;
  onToggleTask: (line: number) => void;
}

function ReadingListItem({ block, keyPrefix, ctx, onToggleTask }: ReadingItemProps) {
  const indent = { paddingLeft: block.indent * 20 };
  if (block.task !== undefined) {
    const { checked, line } = block.task;
    return (
      <div className="flex items-start gap-2.5" style={indent}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          onClick={() => onToggleTask(line)}
          className={cx(
            'mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs border transition-colors duration-[120ms]',
            checked ? 'border-accent bg-accent text-bg-0' : 'border-stroke-1 text-transparent hover:border-accent',
          )}
        >
          <Check size={12} strokeWidth={3} />
        </button>
        <span
          className={cx(
            'text-[16px] leading-[26px]',
            checked ? 'text-text-2 line-through decoration-text-3' : 'text-text-0',
          )}
        >
          {renderInline(block.content, keyPrefix, ctx)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 text-[16px] leading-[26px] text-text-0" style={indent}>
      {block.ordered ? (
        <span className="mt-[1px] min-w-[1.4em] shrink-0 font-mono text-caption text-text-2">
          {markerNumber(block.marker)}.
        </span>
      ) : (
        <span aria-hidden className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-text-3" />
      )}
      <span>{renderInline(block.content, keyPrefix, ctx)}</span>
    </div>
  );
}

function renderBlock(block: MdBlock, key: string, ctx: InlineContext, onToggleTask: (line: number) => void): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAG[block.level];
      return (
        <Tag className={HEADING_CLASS[block.level]}>{renderInline(block.content, key, ctx)}</Tag>
      );
    }
    case 'paragraph':
      return <p className="mb-4 text-[17px] leading-[28px] text-text-0">{renderInline(block.content, key, ctx)}</p>;
    case 'blockquote':
      return (
        <blockquote className="mb-4 border-l-2 border-stroke-1 pl-4 text-text-1 italic">
          {block.children.map((child, index) => (
            <Fragment key={`${key}.${index}`}>{renderBlock(child, `${key}.${index}`, ctx, onToggleTask)}</Fragment>
          ))}
        </blockquote>
      );
    case 'code':
      return <ReadingCodeBlock block={block} reduced={ctx.reduced} />;
    case 'list':
      return (
        <div className="mb-4 flex flex-col gap-1.5">
          {block.items.map((item, index) => (
            <ReadingListItem
              key={`${key}.${index}`}
              block={item}
              keyPrefix={`${key}.${index}`}
              ctx={ctx}
              onToggleTask={onToggleTask}
            />
          ))}
        </div>
      );
    case 'hr':
      return <hr className="my-7 border-t border-stroke-1" />;
    default:
      return null;
  }
}

const STATUS_PILL: Readonly<Record<string, NoteStatus>> = {
  inbox: 'inbox',
  shaping: 'shaping',
  planned: 'plan',
  active: 'doing',
  done: 'done',
  iced: 'ice',
};

const PRIORITY_CHIP: Readonly<Record<string, { label: string; className: string }>> = {
  urgent: { label: 'Срочно', className: 'bg-danger/15 text-danger' },
  high: { label: 'Важно', className: 'bg-warn/15 text-warn' },
  normal: { label: 'Обычный', className: 'bg-accent/15 text-accent' },
  low: { label: 'Низкий', className: 'bg-bg-3 text-text-2' },
};

function fmValue(entries: readonly FrontmatterEntry[], key: string): string | undefined {
  const hit = entries.find((entry) => entry.key === key);
  return hit !== undefined && hit.value.length > 0 ? hit.value : undefined;
}

function fmItems(entries: readonly FrontmatterEntry[], key: string): string[] {
  const hit = entries.find((entry) => entry.key === key);
  if (hit === undefined) {
    return [];
  }
  if (hit.items.length > 0) {
    return [...hit.items];
  }
  return hit.value.length > 0 ? [hit.value] : [];
}

function formatRuDate(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (date.getFullYear() !== new Date().getFullYear()) {
    options.year = 'numeric';
  }
  return new Intl.DateTimeFormat('ru-RU', options).format(date);
}

interface ReadingHeaderProps {
  entries: readonly FrontmatterEntry[];
  fallbackTitle: string;
  hideTitle: boolean;
  reduced: boolean;
}

/**
 * Аккуратная шапка режима чтения (#6): вместо сырого YAML — заголовок из
 * frontmatter, статус, даты и чипы тегов/алиасов. Технические поля скрыты.
 */
function ReadingHeader({ entries, fallbackTitle, hideTitle, reduced }: ReadingHeaderProps) {
  const title = fmValue(entries, 'title') ?? fallbackTitle;
  const icon = fmValue(entries, 'icon');
  const iconColor = fmValue(entries, 'icon_color') ?? fmValue(entries, 'iconColor');
  const status = fmValue(entries, 'status');
  const pill = status !== undefined ? STATUS_PILL[status] : undefined;
  const priority = fmValue(entries, 'priority');
  const priorityChip = priority !== undefined ? PRIORITY_CHIP[priority] : undefined;
  const updated = fmValue(entries, 'updated');
  const updatedLabel = updated !== undefined ? formatRuDate(updated) : undefined;
  const due = fmValue(entries, 'due');
  const dueLabel = due !== undefined ? formatRuDate(due) : undefined;
  const tags = fmItems(entries, 'tags');
  const aliases = fmItems(entries, 'aliases');

  const showTitle = !hideTitle && title.length > 0;
  const hasMeta = pill !== undefined || priorityChip !== undefined || updatedLabel !== undefined || dueLabel !== undefined;
  const hasChips = tags.length > 0 || aliases.length > 0;

  if (!showTitle && !hasMeta && !hasChips) {
    return null;
  }

  return (
    <motion.header
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0.08 : 0.22, ease: easePoints.out }}
      className="mb-7"
    >
      {showTitle ? (
        <div className="flex items-start gap-3">
          {icon !== undefined ? (
            <NoteIcon icon={icon} color={iconColor} size={26} className="mt-[7px] shrink-0" />
          ) : null}
          <h1 className="text-[30px] font-[650] leading-[40px] tracking-[-0.01em] text-text-0">{title}</h1>
        </div>
      ) : null}
      {hasMeta ? (
        <div
          className={cx('flex flex-wrap items-center gap-2', showTitle && 'mt-3')}
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          {pill !== undefined ? <StatusPill status={pill} /> : null}
          {priorityChip !== undefined ? (
            <span
              className={cx(
                'inline-flex h-[22px] items-center rounded-full px-2.5 text-caption font-medium',
                priorityChip.className,
              )}
            >
              {priorityChip.label}
            </span>
          ) : null}
          {dueLabel !== undefined ? (
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-stroke-1 bg-bg-2 px-2.5 text-caption text-text-1">
              <CalendarDays size={12} strokeWidth={1.75} className="text-text-2" />
              срок {dueLabel}
            </span>
          ) : null}
          {updatedLabel !== undefined ? (
            <span className="inline-flex items-center gap-1.5 text-caption text-text-2">
              <Clock3 size={12} strokeWidth={1.75} />
              обновлено {updatedLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasChips ? (
        <div
          className={cx('flex flex-wrap items-center gap-1.5', (showTitle || hasMeta) && 'mt-3')}
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          {tags.map((tag) => (
            <span
              key={`t.${tag}`}
              className="inline-flex h-[22px] items-center rounded-full bg-accent/10 px-2.5 text-caption text-accent"
            >
              #{tag}
            </span>
          ))}
          {aliases.map((alias) => (
            <span
              key={`a.${alias}`}
              className="inline-flex h-[22px] items-center rounded-full border border-stroke-1 bg-bg-2 px-2.5 text-caption italic text-text-2"
            >
              {alias}
            </span>
          ))}
        </div>
      ) : null}
      <div aria-hidden className="mt-7 h-px bg-stroke-0" />
    </motion.header>
  );
}

interface ReadingViewProps {
  doc: string;
  noteRef: NoteRef;
  reduced: boolean;
  onToggleTask: (line: number) => void;
  onOpenLink: (target: string) => void;
}

function ReadingView({ doc, noteRef, reduced, onToggleTask, onOpenLink }: ReadingViewProps) {
  const split = useMemo(() => splitFrontmatter(doc), [doc]);
  const blocks = useMemo(
    () => (split !== null ? parseBlocks(split.body, split.bodyLine) : parseBlocks(doc)),
    [split, doc],
  );
  const entries = split?.frontmatter.entries;
  const hideTitle = useMemo(() => {
    if (entries === undefined) {
      return false;
    }
    const title = fmValue(entries, 'title');
    if (title === undefined) {
      return false;
    }
    const first = blocks.find((block) => block.kind === 'heading');
    return (
      first !== undefined &&
      first.kind === 'heading' &&
      first.level === 1 &&
      inlineText(first.content).trim().toLowerCase() === title.trim().toLowerCase()
    );
  }, [entries, blocks]);

  const ctx: InlineContext = { onOpenLink, reduced };
  return (
    <motion.div
      key="reading"
      className="absolute inset-0 z-10 overflow-y-auto bg-bg-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.08 : 0.16, ease: easePoints.out }}
    >
      <div className="mx-auto max-w-[calc(72ch+48px)] px-6 py-12 text-[17px] leading-[28px]" style={{ fontFamily: READING_FONT }}>
        {entries !== undefined ? (
          <ReadingHeader
            entries={entries}
            fallbackTitle={titleFromRef(noteRef)}
            hideTitle={hideTitle}
            reduced={reduced}
          />
        ) : null}
        {blocks.length === 0 ? (
          <p className="text-ui text-text-2">Пустая заметка — переключитесь в режим правки, чтобы начать.</p>
        ) : (
          blocks.map((block, index) => (
            <motion.div
              key={index}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduced ? 0.08 : 0.2,
                ease: easePoints.out,
                delay: reduced ? 0 : Math.min(index, 6) * 0.022,
              }}
            >
              {renderBlock(block, `b${index}`, ctx, onToggleTask)}
            </motion.div>
          ))
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Контекст-меню форматирования по выделению (#11)                      */
/* ------------------------------------------------------------------ */

interface SelectionMenuState {
  x: number;
  y: number;
}

interface SelectionMenuProps {
  at: SelectionMenuState;
  view: EditorView;
  reduced: boolean;
  onClose: () => void;
  onSweepDone: () => void;
}

interface InlineAction {
  icon: typeof Bold;
  label: string;
  kbd: string;
  marker: InlineMarker;
  active: boolean;
}

interface HeadingAction {
  icon: typeof Heading1;
  label: string;
  level: HeadingLevel;
}

const HEADING_ACTIONS: readonly HeadingAction[] = [
  { icon: Heading1, label: 'Заголовок 1', level: 1 },
  { icon: Heading2, label: 'Заголовок 2', level: 2 },
  { icon: Heading3, label: 'Заголовок 3', level: 3 },
  { icon: Pilcrow, label: 'Обычный текст', level: 0 },
];

const MENU_ROW =
  'flex w-full select-none items-center gap-2.5 rounded-s px-2.5 py-1.5 text-ui transition-colors duration-[120ms]';

function SelectionMenu({ at, view, reduced, onClose, onSweepDone }: SelectionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  const formats = inlineFormatState(view.state);
  const heading = headingLevelAt(view.state);

  const inlineActions: readonly InlineAction[] = [
    { icon: Bold, label: 'Жирный', kbd: 'Ctrl+B', marker: '**', active: formats.strong },
    { icon: Italic, label: 'Курсив', kbd: 'Ctrl+I', marker: '*', active: formats.em },
    { icon: Strikethrough, label: 'Зачёркнутый', kbd: 'Ctrl+Shift+X', marker: '~~', active: formats.strike },
    { icon: Code, label: 'Код', kbd: 'Ctrl+Shift+E', marker: '`', active: formats.code },
  ];

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el === null) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(at.x, window.innerWidth - rect.width - pad)),
      y: Math.max(pad, Math.min(at.y, window.innerHeight - rect.height - pad)),
    });
  }, [at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const close = useCallback(() => {
    onClose();
    view.focus();
  }, [onClose, view]);

  const runInline = (marker: InlineMarker) => {
    if (marker === '`') {
      toggleCode(view);
    } else {
      toggleInlineFormat(view, marker);
    }
    close();
  };

  const runLink = () => {
    close();
    openWikiLinkPicker(view);
  };

  const runSweepDone = () => {
    onSweepDone();
    close();
  };

  const runHeading = (level: HeadingLevel) => {
    setHeadingLevel(view, level);
    close();
  };

  const runClipboard = (cut: boolean) => {
    const range = view.state.selection.main;
    const text = view.state.sliceDoc(range.from, range.to);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (cut) {
          view.dispatch({ changes: { from: range.from, to: range.to }, userEvent: 'delete.cut' });
        }
      })
      .catch(() => {
        useUiStore.getState().pushToast({ kind: 'error', text: 'Буфер обмена недоступен' });
      });
    close();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onPointerDown={close}
        onContextMenu={(event) => {
          event.preventDefault();
          close();
        }}
      />
      <motion.div
        ref={menuRef}
        role="menu"
        aria-label="Форматирование выделения"
        className="fixed z-50 min-w-[236px] rounded-m border border-stroke-1 bg-bg-2 p-1.5 shadow-3"
        style={{ left: pos.x, top: pos.y, transformOrigin: 'top left' }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -4 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, transition: springSnappy }}
        exit={{ opacity: 0, transition: { duration: 0.1, ease: easePoints.in } }}
      >
        {inlineActions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            onClick={() => runInline(action.marker)}
            className={cx(
              MENU_ROW,
              action.active ? 'bg-accent/10 text-accent' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
            )}
          >
            <action.icon size={15} strokeWidth={1.75} className="shrink-0" />
            <span className="flex-1 text-left">{action.label}</span>
            <span className="font-mono text-micro text-text-3">{action.kbd}</span>
          </button>
        ))}
        <div aria-hidden className="mx-1.5 my-1 h-px bg-stroke-0" />
        <button
          type="button"
          role="menuitem"
          onClick={runSweepDone}
          className={cx(MENU_ROW, 'text-text-1 hover:bg-bg-3 hover:text-text-0')}
        >
          <ListChecks size={15} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 text-left">Убрать в «Готово»</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={runLink}
          className={cx(MENU_ROW, 'text-text-1 hover:bg-bg-3 hover:text-text-0')}
        >
          <Link2 size={15} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 text-left">Связать заметку</span>
          <span className="font-mono text-micro text-text-3">Ctrl+L</span>
        </button>
        <div aria-hidden className="mx-1.5 my-1 h-px bg-stroke-0" />
        <p className="px-2.5 pb-1 pt-1.5 text-micro font-medium uppercase tracking-[0.08em] text-text-3">
          Размер текста
        </p>
        {HEADING_ACTIONS.map((action) => {
          const active = action.level === heading;
          return (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => runHeading(action.level)}
              className={cx(
                MENU_ROW,
                active ? 'bg-accent/10 text-accent' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
              )}
            >
              <action.icon size={15} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 text-left">{action.label}</span>
              {active ? <Check size={13} strokeWidth={2} className="text-accent" /> : null}
            </button>
          );
        })}
        <div aria-hidden className="mx-1.5 my-1 h-px bg-stroke-0" />
        <button
          type="button"
          role="menuitem"
          onClick={() => runClipboard(false)}
          className={cx(MENU_ROW, 'text-text-1 hover:bg-bg-3 hover:text-text-0')}
        >
          <Copy size={15} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 text-left">Копировать</span>
          <span className="font-mono text-micro text-text-3">Ctrl+C</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => runClipboard(true)}
          className={cx(MENU_ROW, 'text-text-1 hover:bg-bg-3 hover:text-text-0')}
        >
          <Scissors size={15} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 text-left">Вырезать</span>
          <span className="font-mono text-micro text-text-3">Ctrl+X</span>
        </button>
      </motion.div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Панель редактора                                                     */
/* ------------------------------------------------------------------ */

export interface EditorPaneProps {
  tabId: string;
  noteRef: NoteRef;
  /** Черновик ещё не существующего файла: редактор стартует с него без чтения
   * диска, а на диск документ ложится штатным автосейвом при первом вводе. */
  initialDoc?: string;
}

export function EditorPane({ tabId, noteRef, initialDoc }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const baseRevRef = useRef('');
  const docRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const dragPathsRef = useRef<string[]>([]);

  const setDirty = useTabsStore((s) => s.setDirty);
  const readingMode = useUiStore((s) => s.readingMode);
  const toggleReadingMode = useUiStore((s) => s.toggleReadingMode);
  const showPropsInText = useUiStore((s) => s.showPropsInText);
  const reduced = usePrefersReducedMotion();

  // Цвет выделения текста повторяет цвет иконки файла (#1): переопределяем
  // --selection/--selection-dim на корне панели — каскад уходит и в CodeMirror
  // (.cm-selectionBackground), и в нативный ::selection режима чтения. Нет
  // цвета у файла — переменные не трогаем, работает глобальный ирис.
  const iconColor = useVaultStore((s) => s.iconByRef[noteRef]?.color);
  const selectionStyle = useMemo<CSSProperties | undefined>(() => {
    const tint = resolveIconColor(iconColor);
    if (tint === undefined) {
      return undefined;
    }
    return {
      '--selection': tint,
      '--selection-dim': `color-mix(in srgb, ${tint} 40%, transparent)`,
    } as unknown as CSSProperties;
  }, [iconColor]);

  const [docText, setDocText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState<SelectionMenuState | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const isWelcome = noteRef === WELCOME_NOTE_REF;

  const applyDisk = useCallback(
    (content: string, rev: string, highlight: boolean) => {
      const handle = editorRef.current;
      const previous = docRef.current;
      baseRevRef.current = rev;
      docRef.current = content;
      dirtyRef.current = false;
      pendingSaveRef.current = false;
      setDocText(content);
      setDirty(tabId, false);
      if (handle !== null) {
        handle.setDoc(content);
        if (highlight) {
          const range = changedRange(previous, content);
          if (range !== null) {
            handle.markAi(range.from, range.to);
          }
        }
        useEditorViewsStore.getState().bumpDocVersion();
      }
    },
    [noteRef, tabId, setDirty],
  );

  const reconcileConflict = useCallback(async () => {
    try {
      const res = await commands.noteRead({ ref: noteRef });
      baseRevRef.current = res.rev;
      if (res.content === docRef.current) {
        dirtyRef.current = false;
        setDirty(tabId, false);
        return;
      }
      useUiStore.getState().pushToast({
        kind: 'error',
        text: `«${titleFromRef(noteRef)}» изменена извне — ваши правки пока не сохранены`,
        action: {
          label: 'Загрузить с диска',
          run: () => {
            applyDisk(res.content, res.rev, true);
          },
        },
      });
    } catch {
      /* leave the buffer dirty; the next edit or flush retries with the rebased rev */
    }
  }, [noteRef, tabId, setDirty, applyDisk]);

  const persist = useCallback(async (): Promise<void> => {
    if (isWelcome) {
      return;
    }
    if (savingRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    savingRef.current = true;
    const run = (async () => {
      try {
        do {
          pendingSaveRef.current = false;
          const content = docRef.current;
          try {
            const res = await commands.bufferSave({ ref: noteRef, baseRev: baseRevRef.current, content });
            baseRevRef.current = res.revNew;
            if (docRef.current === content) {
              dirtyRef.current = false;
              setDirty(tabId, false);
            }
          } catch (error) {
            pendingSaveRef.current = false;
            if (isGraphiteError(error) && error.code === 'CONFLICT') {
              await reconcileConflict();
            } else {
              useUiStore.getState().pushToast({
                kind: 'error',
                text: describeError(error, 'Не удалось сохранить заметку'),
              });
            }
            return;
          }
        } while (pendingSaveRef.current);
      } finally {
        savingRef.current = false;
      }
    })();
    pendingSaves.set(noteRef, run);
    void run.finally(() => {
      if (pendingSaves.get(noteRef) === run) {
        pendingSaves.delete(noteRef);
      }
    });
    await run;
  }, [isWelcome, noteRef, tabId, setDirty, reconcileConflict]);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void persist();
    }, SAVE_DEBOUNCE_MS);
  }, [persist]);

  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    if (!isWelcome && dirtyRef.current) {
      void persist();
    }
  }, [isWelcome, persist]);

  useEffect(() => {
    liveEditorFlushes.add(flushSave);
    return () => {
      liveEditorFlushes.delete(flushSave);
    };
  }, [flushSave]);

  const linkSource = useCallback((query: string): WikiLinkItem[] => {
    const nodes = useVaultStore.getState().tree;
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const scored: { item: WikiLinkItem; score: number }[] = [];
    for (const node of nodes) {
      const title = node.title.trim();
      if (title.length === 0) {
        continue;
      }
      const lower = title.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }
      const score = needle.length === 0 ? 0 : fuzzyScore(needle, lower);
      if (score === null) {
        continue;
      }
      seen.add(lower);
      const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : undefined;
      scored.push({ item: { label: title, detail: dir }, score });
      if (needle.length === 0 && scored.length >= 40) {
        break;
      }
    }
    if (needle.length > 0) {
      scored.sort((a, b) => b.score - a.score);
    }
    return scored.slice(0, 40).map((entry) => entry.item);
  }, []);

  const openLink = useCallback((target: string) => {
    const wanted = target.trim().toLowerCase();
    const nodes = useVaultStore.getState().tree;
    const hit =
      nodes.find((node) => node.title.trim().toLowerCase() === wanted) ??
      nodes.find((node) => node.path.toLowerCase().replace(/\.md$/, '').endsWith(wanted));
    if (hit !== undefined) {
      useVaultStore.getState().openNote(hit.ref);
    } else {
      useUiStore.getState().pushToast({ kind: 'info', text: `Заметка «${target}» пока не найдена` });
    }
  }, []);

  // «Связать заметку» из палитры и глобального хоткея: фокусируем редактор и
  // открываем пикер; внутри самого редактора Ctrl+L обрабатывает CodeMirror.
  useActionHandler('editor.linkNote', () => {
    const handle = editorRef.current;
    if (handle === null || handle.view.state.readOnly || useUiStore.getState().readingMode) {
      return;
    }
    handle.focus();
    openWikiLinkPicker(handle.view);
  });

  // «Убрать сделанное в „Готово“»: выполненные пункты переезжают в конец
  // заметки под ## Готово (история сохраняется), рабочий план остаётся чистым.
  const handleSweepDone = useCallback(() => {
    const handle = editorRef.current;
    if (isWelcome || handle === null || handle.view.state.readOnly || useUiStore.getState().readingMode) {
      return;
    }
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const result = sweepDoneTasks(docRef.current, today);
    if (result === null) {
      useUiStore.getState().pushToast({ kind: 'info', text: 'Выполненных пунктов нет' });
      return;
    }
    docRef.current = result.text;
    setDocText(result.text);
    handle.setDoc(result.text);
    useEditorViewsStore.getState().bumpDocVersion();
    dirtyRef.current = true;
    setDirty(tabId, true);
    scheduleSave();
    useUiStore.getState().pushToast({
      kind: 'success',
      text: result.moved === 1 ? 'Пункт убран в «Готово»' : `В «Готово»: ${result.moved}`,
    });
  }, [isWelcome, tabId, setDirty, scheduleSave]);

  useActionHandler('task.sweepDone', handleSweepDone);

  // «Убрать в „Готово“» для произвольного выделения: план, записанный обычным
  // текстом, уезжает под капсулу целиком — без превращения в чекбоксы.
  const handleSweepSelection = useCallback(() => {
    const handle = editorRef.current;
    if (isWelcome || handle === null || handle.view.state.readOnly || useUiStore.getState().readingMode) {
      return;
    }
    const { doc, selection } = handle.view.state;
    const fromLine = doc.lineAt(selection.main.from).number - 1;
    const toLine = doc.lineAt(selection.main.to).number - 1;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const result = sweepLinesDone(docRef.current, fromLine, toLine, today);
    if (result === null) {
      useUiStore.getState().pushToast({ kind: 'info', text: 'В выделении нечего убирать' });
      return;
    }
    docRef.current = result.text;
    setDocText(result.text);
    handle.setDoc(result.text);
    useEditorViewsStore.getState().bumpDocVersion();
    dirtyRef.current = true;
    setDirty(tabId, true);
    scheduleSave();
    useUiStore.getState().pushToast({
      kind: 'success',
      text: result.moved === 1 ? 'Строка убрана в «Готово»' : `Убрано в «Готово»: ${result.moved}`,
    });
  }, [isWelcome, tabId, setDirty, scheduleSave]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    let disposed = false;

    const mount = (content: string, readOnly = false) => {
      if (disposed) {
        return;
      }
      docRef.current = content;
      dirtyRef.current = false;
      setDocText(content);
      const handle = createEditor(host, {
        initialDoc: content,
        readOnly,
        // Снимок через getState: живое переключение идёт реконфигурацией ниже,
        // без пересоздания редактора (иначе терялись бы undo и позиция).
        hideFrontmatter: !useUiStore.getState().showPropsInText,
        linkSource,
        attachments: readOnly
          ? undefined
          : {
              save: saveAttachmentBlob,
              onError: (message) => {
                useUiStore.getState().pushToast({ kind: 'error', text: message });
              },
            },
        images: { resolveSrc: resolveImageSrc, onOpen: openAttachment },
        onChange: (next) => {
          if (isWelcome) {
            return;
          }
          docRef.current = next;
          if (!dirtyRef.current) {
            dirtyRef.current = true;
            setDirty(tabId, true);
          }
          scheduleSave();
          useEditorViewsStore.getState().bumpDocVersion();
        },
      });
      editorRef.current = handle;
      useEditorViewsStore.getState().register(tabId, noteRef, handle.view);
      if (!useUiStore.getState().readingMode) {
        handle.focus();
      }
    };

    if (isWelcome) {
      baseRevRef.current = '';
      setLoaded(true);
      mount(WELCOME_DOC, true);
    } else if (initialDoc !== undefined) {
      // Виргинальный буфер: файла на диске ещё нет, поэтому не читаем его.
      // Первый ввод уйдёт через persist с пустым baseRev — buffer_save создаст
      // файл вместе с недостающими папками.
      baseRevRef.current = '';
      setLoaded(true);
      mount(initialDoc);
    } else {
      const prior = pendingSaves.get(noteRef);
      Promise.resolve(prior)
        .catch(() => undefined)
        .then(() => commands.noteRead({ ref: noteRef }))
        .then(
          (res) => {
            if (disposed) {
              return;
            }
            baseRevRef.current = res.rev;
            setLoaded(true);
            mount(res.content);
          },
          (error: unknown) => {
            if (disposed) {
              return;
            }
            const reason = describeError(error, 'не удалось прочитать заметку');
            baseRevRef.current = '';
            setLoaded(true);
            mount(`# ${titleFromRef(noteRef)}\n\n> ${reason}\n`, true);
          },
        );
    }

    return () => {
      disposed = true;
      flushSave();
      setMenu(null);
      useEditorViewsStore.getState().unregister(tabId);
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [tabId, noteRef, isWelcome, initialDoc, linkSource, scheduleSave, flushSave, setDirty]);

  useEffect(() => {
    if (readingMode) {
      setMenu(null);
      setDocText(docRef.current);
    } else if (loaded) {
      editorRef.current?.focus();
    }
  }, [readingMode, loaded]);

  useEffect(() => {
    editorRef.current?.setHideFrontmatter(!showPropsInText);
  }, [showPropsInText]);

  // Синк окон одной заметки (#4): buffer_save другого окна (и любые внешние
  // правки) приходят событием note_changed. Своя запись узнаётся по rev; при
  // чистом буфере содержимое перечитывается с сохранением позиции курсора.
  useEffect(() => {
    if (isWelcome || !isTauriAvailable()) {
      return;
    }
    let active = true;
    let syncing = false;
    let queued = false;
    let queuedHighlight = false;

    const applyFresh = (highlight: boolean) => {
      if (syncing) {
        queued = true;
        queuedHighlight = queuedHighlight || highlight;
        return;
      }
      syncing = true;
      commands
        .noteRead({ ref: noteRef })
        .then((res) => {
          if (!active || editorRef.current === null) {
            return;
          }
          if (res.content === docRef.current) {
            baseRevRef.current = res.rev;
            if (dirtyRef.current) {
              dirtyRef.current = false;
              setDirty(tabId, false);
            }
            return;
          }
          if (!dirtyRef.current) {
            applyDisk(res.content, res.rev, highlight);
            return;
          }
          useUiStore.getState().pushToast({
            kind: 'info',
            text: `«${titleFromRef(noteRef)}» изменена извне`,
            action: {
              label: 'Загрузить с диска',
              run: () => {
                applyDisk(res.content, res.rev, true);
              },
            },
          });
        })
        .catch(() => undefined)
        .finally(() => {
          syncing = false;
          if (queued && active) {
            queued = false;
            const highlight = queuedHighlight;
            queuedHighlight = false;
            applyFresh(highlight);
          }
        });
    };

    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      const payload = event.payload;
      if (!active || payload.ref !== noteRef || payload.kind === 'removed') {
        return;
      }
      if (payload.rev === baseRevRef.current) {
        return;
      }
      if (savingRef.current || pendingSaveRef.current) {
        return;
      }
      if (editorRef.current === null) {
        return;
      }
      applyFresh(payload.actor !== 'user');
    });
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, [noteRef, isWelcome, tabId, setDirty, applyDisk]);

  // Drag-drop картинок из проводника (#29): Tauri перехватывает нативный дроп,
  // поэтому слушаем его событие и вставляем вложение по координатам броска.
  useEffect(() => {
    if (isWelcome || !isTauriAvailable()) {
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;

    const pointInHost = (physicalX: number, physicalY: number): { x: number; y: number } | null => {
      const host = hostRef.current;
      if (host === null) {
        return null;
      }
      const scale = window.devicePixelRatio || 1;
      const x = physicalX / scale;
      const y = physicalY / scale;
      const rect = host.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        return null;
      }
      return { x, y };
    };

    const dropImages = (paths: string[], x: number, y: number) => {
      const handle = editorRef.current;
      if (handle === null) {
        return;
      }
      const view = handle.view;
      const pos = attachmentInsertPos(
        view,
        view.posAtCoords({ x, y }) ?? view.state.selection.main.from,
      );
      const uploadId = beginAttachmentUpload(view, pos);
      void (async () => {
        const rels: string[] = [];
        let failure: string | null = null;
        for (const path of paths) {
          try {
            const res = await commands.saveAttachmentFromPath({ srcPath: path });
            rels.push(res.relPath);
          } catch (error) {
            failure = describeError(error, 'Не удалось сохранить изображение');
          }
        }
        if (rels.length === 0) {
          finishAttachmentUpload(view, uploadId, null);
          if (failure !== null) {
            useUiStore.getState().pushToast({ kind: 'error', text: failure });
          }
          return;
        }
        const markdown = rels
          .map((rel, index) => (index === 0 ? attachmentMarkdown(view, pos, rel) : `![](${rel})\n`))
          .join('');
        finishAttachmentUpload(view, uploadId, markdown);
        if (failure !== null) {
          useUiStore.getState().pushToast({ kind: 'error', text: failure });
        }
      })();
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!active) {
          return;
        }
        const payload = event.payload;
        if (payload.type === 'leave') {
          dragPathsRef.current = [];
          setDropActive(false);
          return;
        }
        if (payload.type === 'enter') {
          dragPathsRef.current = payload.paths.filter((path) => IMAGE_PATH_RE.test(path));
        }
        const hasImages = dragPathsRef.current.length > 0;
        const inside =
          hasImages && !useUiStore.getState().readingMode
            ? pointInHost(payload.position.x, payload.position.y)
            : null;
        if (payload.type === 'drop') {
          const paths = payload.paths.filter((path) => IMAGE_PATH_RE.test(path));
          dragPathsRef.current = [];
          setDropActive(false);
          const point = paths.length > 0 && !useUiStore.getState().readingMode
            ? pointInHost(payload.position.x, payload.position.y)
            : null;
          if (point !== null) {
            dropImages(paths, point.x, point.y);
          }
          return;
        }
        setDropActive(inside !== null);
      })
      .then((fn) => {
        if (active) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      setDropActive(false);
      unlisten?.();
    };
  }, [noteRef, isWelcome]);

  const handleReadingToggle = useCallback(
    (line: number) => {
      const next = toggleTaskOnLine(docRef.current, line);
      if (next === null) {
        return;
      }
      docRef.current = next;
      setDocText(next);
      editorRef.current?.setDoc(next);
      useEditorViewsStore.getState().bumpDocVersion();
      if (!isWelcome) {
        dirtyRef.current = true;
        setDirty(tabId, true);
        scheduleSave();
      }
    },
    [isWelcome, tabId, setDirty, scheduleSave],
  );

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (useUiStore.getState().readingMode) {
      return;
    }
    const host = hostRef.current;
    if (host === null || !(event.target instanceof Node) || !host.contains(event.target)) {
      return;
    }
    const handle = editorRef.current;
    if (handle === null || handle.view.state.readOnly) {
      return;
    }
    if (handle.view.state.selection.main.empty) {
      return;
    }
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      style={selectionStyle}
      onContextMenu={handleContextMenu}
    >
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden"
        inert={readingMode || undefined}
      />

      <Presence>
        {readingMode && loaded ? (
          <ReadingView
            key="reading"
            doc={docText}
            noteRef={noteRef}
            reduced={reduced}
            onToggleTask={handleReadingToggle}
            onOpenLink={openLink}
          />
        ) : null}
      </Presence>

      <Presence>
        {menu !== null && editorRef.current !== null ? (
          <SelectionMenu
            key="selection-menu"
            at={menu}
            view={editorRef.current.view}
            reduced={reduced}
            onClose={closeMenu}
            onSweepDone={handleSweepSelection}
          />
        ) : null}
      </Presence>

      <Presence>
        {dropActive ? (
          <motion.div
            key="drop-hint"
            className="pointer-events-none absolute inset-0 z-30 p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0.08 : 0.14, ease: easePoints.out }}
          >
            <motion.div
              className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-l border border-dashed border-accent/60 bg-bg-0/80"
              initial={reduced ? { scale: 1 } : { scale: 0.985 }}
              animate={{ scale: 1, transition: springSnappy }}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
                <ImagePlus size={22} strokeWidth={1.75} />
              </span>
              <p className="text-ui font-medium text-text-0">Отпустите — картинка ляжет в заметку</p>
              <p className="text-caption text-text-2">Файл сохранится во вложения хранилища</p>
            </motion.div>
          </motion.div>
        ) : null}
      </Presence>

      <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-1.5">
        {!readingMode && !isWelcome ? (
          <Tooltip content="Убрать сделанное в «Готово»">
            <button
              type="button"
              onClick={handleSweepDone}
              aria-label="Убрать сделанное в «Готово»"
              className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-s border border-stroke-1 bg-bg-2 text-text-1 shadow-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4"
            >
              <ListChecks size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content={readingMode ? 'Режим правки' : 'Режим чтения'}>
          <button
            type="button"
            onClick={toggleReadingMode}
            aria-label={readingMode ? 'Режим правки' : 'Режим чтения'}
            className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-s border border-stroke-1 bg-bg-2 text-text-1 shadow-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4"
          >
            {readingMode ? (
              <PencilLine size={15} strokeWidth={1.75} />
            ) : (
              <BookOpen size={15} strokeWidth={1.75} />
            )}
          </button>
        </Tooltip>
        <div className="pointer-events-auto">
          <ExportMenu noteRef={noteRef} />
        </div>
        <div className="pointer-events-auto">
          <CopyPageButton noteRef={noteRef} />
        </div>
      </div>
    </div>
  );
}
