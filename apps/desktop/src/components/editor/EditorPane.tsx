import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import { motion } from 'motion/react';
import { BookOpen, Check, PencilLine } from 'lucide-react';
import { createEditor, parseBlocks, toggleTaskOnLine } from '@graphite/editor';
import type { EditorHandle, MdBlock, MdInline, WikiLinkItem } from '@graphite/editor';
import { GRAPHITE_EVENT, commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteChangedEvent, NoteRef } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { Tooltip, cx, easePoints } from '@graphite/ui';
import { titleFromRef, useTabsStore } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Presence, usePrefersReducedMotion } from '../../motion';
import { CopyPageButton } from '../bundle/CopyPageButton';

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
const READING_FONT = '"Source Serif 4", "Iowan Old Style", "Palatino Linotype", Georgia, serif';

const pendingSaves = new Map<NoteRef, Promise<void>>();

function describeError(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

function openExternal(href: string): void {
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
  } catch {
    /* opening external links is best-effort outside the desktop shell */
  }
}

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
      case 'code':
        return (
          <code
            key={key}
            className="rounded-xs bg-bg-2 px-1 py-0.5 font-mono text-[0.88em] text-text-0"
          >
            {node.value}
          </code>
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
      return (
        <pre className="mb-4 overflow-x-auto rounded-m border border-stroke-0 bg-bg-1 p-4">
          <code className="font-mono text-[13.5px] leading-[22px] text-text-1">{block.value}</code>
        </pre>
      );
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

interface ReadingViewProps {
  doc: string;
  reduced: boolean;
  onToggleTask: (line: number) => void;
  onOpenLink: (target: string) => void;
}

function ReadingView({ doc, reduced, onToggleTask, onOpenLink }: ReadingViewProps) {
  const blocks = useMemo(() => parseBlocks(doc), [doc]);
  const ctx: InlineContext = { onOpenLink };
  return (
    <motion.div
      key="reading"
      className="absolute inset-0 z-10 overflow-y-auto bg-bg-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.08 : 0.16, ease: easePoints.out }}
    >
      <div className="mx-auto max-w-[70ch] px-6 py-12" style={{ fontFamily: READING_FONT }}>
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

export interface EditorPaneProps {
  tabId: string;
  noteRef: NoteRef;
}

export function EditorPane({ tabId, noteRef }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const baseRevRef = useRef('');
  const docRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef(false);

  const setDirty = useTabsStore((s) => s.setDirty);
  const readingMode = useUiStore((s) => s.readingMode);
  const toggleReadingMode = useUiStore((s) => s.toggleReadingMode);
  const reduced = usePrefersReducedMotion();

  const [docText, setDocText] = useState('');
  const [loaded, setLoaded] = useState(false);

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

  const linkSource = useCallback((query: string): WikiLinkItem[] => {
    const nodes = useVaultStore.getState().tree;
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const items: WikiLinkItem[] = [];
    for (const node of nodes) {
      const title = node.title.trim();
      if (title.length === 0) {
        continue;
      }
      const lower = title.toLowerCase();
      if (seen.has(lower) || (needle.length > 0 && !lower.includes(needle))) {
        continue;
      }
      seen.add(lower);
      const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : undefined;
      items.push({ label: title, detail: dir });
      if (items.length >= 40) {
        break;
      }
    }
    return items;
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
        linkSource,
        onChange: (next) => {
          if (isWelcome) {
            return;
          }
          docRef.current = next;
          dirtyRef.current = true;
          setDirty(tabId, true);
          scheduleSave();
        },
      });
      editorRef.current = handle;
      if (!useUiStore.getState().readingMode) {
        handle.focus();
      }
    };

    if (isWelcome) {
      baseRevRef.current = '';
      setLoaded(true);
      mount(WELCOME_DOC, true);
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
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [tabId, noteRef, isWelcome, linkSource, scheduleSave, flushSave, setDirty]);

  useEffect(() => {
    if (readingMode) {
      setDocText(docRef.current);
    } else if (loaded) {
      editorRef.current?.focus();
    }
  }, [readingMode, loaded]);

  useEffect(() => {
    if (isWelcome || !isTauriAvailable()) {
      return;
    }
    let active = true;
    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      const payload = event.payload;
      if (!active || payload.ref !== noteRef || payload.actor === 'user') {
        return;
      }
      if (editorRef.current === null) {
        return;
      }
      commands.noteRead({ ref: noteRef }).then(
        (res) => {
          if (!active) {
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
            applyDisk(res.content, res.rev, true);
            return;
          }
          baseRevRef.current = res.rev;
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
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, [noteRef, isWelcome, tabId, setDirty, applyDisk]);

  const handleReadingToggle = useCallback(
    (line: number) => {
      const next = toggleTaskOnLine(docRef.current, line);
      if (next === null) {
        return;
      }
      docRef.current = next;
      setDocText(next);
      editorRef.current?.setDoc(next);
      if (!isWelcome) {
        dirtyRef.current = true;
        setDirty(tabId, true);
        scheduleSave();
      }
    },
    [isWelcome, tabId, setDirty, scheduleSave],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
            reduced={reduced}
            onToggleTask={handleReadingToggle}
            onOpenLink={openLink}
          />
        ) : null}
      </Presence>

      <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-1.5">
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
          <CopyPageButton noteRef={noteRef} />
        </div>
      </div>
    </div>
  );
}
