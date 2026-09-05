import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { motion } from 'motion/react';
import { Copy, ListTree } from 'lucide-react';
import { EditorView } from '@codemirror/view';
import { Tooltip, cx } from '@graphite/ui';
import { GRAPHITE_EVENT, commands, isTauriAvailable } from '@graphite/bindings';
import type { NoteChangedEvent, NoteRef } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { parseHeadings, pickActiveIndex } from '@graphite/editor';
import type { MdHeading } from '@graphite/editor';
import { Fade, Presence, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useEditorViewsStore } from '../../stores/editorViewsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { copyWikiLink, wikiLinkMarkup } from '../../lib/wikiLink';
import { titleFromRef } from '../../stores/tabsStore';

export interface OutlineTabProps {
  noteRef: NoteRef;
  /** Id вкладки редактора — точный выбор view, когда заметка открыта в нескольких панелях. */
  tabId?: string;
}

const DOC_REFRESH_DEBOUNCE_MS = 150;

/**
 * Оглавление активной заметки: заголовки H1–H6 с прыжком к строке по клику
 * и подсветкой текущего раздела при скролле. Документ берётся из живого
 * буфера редактора; для заметки без открытого редактора — с диска.
 */
export function OutlineTab({ noteRef, tabId }: OutlineTabProps) {
  const views = useEditorViewsStore((s) => s.views);
  const docVersion = useEditorViewsStore((s) => s.docVersion);
  const reduced = usePrefersReducedMotion();
  const [doc, setDoc] = useState<string | undefined>(undefined);
  const [activeLine, setActiveLine] = useState<number | undefined>(undefined);

  const view = useMemo(() => {
    const exact = tabId !== undefined ? views[tabId] : undefined;
    if (exact !== undefined && exact.noteRef === noteRef) {
      return exact.view;
    }
    return Object.values(views).find((entry) => entry.noteRef === noteRef)?.view;
  }, [views, tabId, noteRef]);

  // Живой буфер: моментально при появлении view, дальше — с мягким дебаунсом
  // по docVersion, чтобы не парсить документ на каждое нажатие клавиши.
  useEffect(() => {
    if (view === undefined) {
      return;
    }
    setDoc(view.state.sliceDoc());
  }, [view]);

  useEffect(() => {
    if (view === undefined) {
      return;
    }
    const timer = window.setTimeout(() => {
      setDoc(view.state.sliceDoc());
    }, DOC_REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [view, docVersion]);

  // Заметка без открытого редактора: читаем с диска и следим за note_changed.
  useEffect(() => {
    if (view !== undefined) {
      return;
    }
    let cancelled = false;
    const load = () => {
      commands.noteRead({ ref: noteRef }).then(
        (response) => {
          if (!cancelled) {
            setDoc(response.content);
          }
        },
        () => {
          if (!cancelled) {
            setDoc('');
          }
        },
      );
    };
    load();
    if (!isTauriAvailable()) {
      return () => {
        cancelled = true;
      };
    }
    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      const payload = event.payload;
      if (cancelled || payload.ref !== noteRef || payload.kind === 'removed') {
        return;
      }
      load();
    });
    return () => {
      cancelled = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, [view, noteRef]);

  const headings = useMemo(() => (doc === undefined ? [] : parseHeadings(doc)), [doc]);
  const minLevel = useMemo(() => headings.reduce((min, h) => Math.min(min, h.level), 6), [headings]);
  const tree = useVaultStore((s) => s.tree);
  const childrenByRef = useVaultStore((s) => s.childrenByRef);
  const noteTitle = useMemo(() => {
    const fromTree = tree.find((node) => node.ref === noteRef)?.title;
    if (fromTree !== undefined && fromTree.length > 0) {
      return fromTree;
    }
    for (const nodes of Object.values(childrenByRef)) {
      const title = nodes.find((node) => node.ref === noteRef)?.title;
      if (title !== undefined && title.length > 0) {
        return title;
      }
    }
    return titleFromRef(noteRef);
  }, [tree, childrenByRef, noteRef]);
  const readingMode = useUiStore((s) => s.readingMode);
  const readingScrollEl = useUiStore((s) => s.readingScrollEl);
  const readingScrollRef = useUiStore((s) => s.readingScrollRef);

  // Подсветка текущего раздела в правке: последний заголовок над верхней
  // видимой строкой редактора.
  useEffect(() => {
    if (readingMode || view === undefined) {
      if (!readingMode && view === undefined) {
        setActiveLine(undefined);
      }
      return;
    }
    const scroller = view.scrollDOM;
    const syncActive = () => {
      const block = view.lineBlockAtHeight(scroller.scrollTop);
      const topLine = view.state.doc.lineAt(block.from).number - 1;
      const index = pickActiveIndex(
        headings.map((heading) => heading.line),
        topLine,
      );
      setActiveLine(index === undefined ? undefined : headings[index].line);
    };
    syncActive();
    scroller.addEventListener('scroll', syncActive, { passive: true });
    return () => scroller.removeEventListener('scroll', syncActive);
  }, [view, headings, readingMode]);

  // В чтении редактор скрыт — следим за прокруткой статьи (`#gr-h-<строка>`).
  useEffect(() => {
    if (!readingMode || readingScrollRef !== noteRef || readingScrollEl === undefined) {
      return;
    }
    const scroller = readingScrollEl;
    const syncActive = () => {
      const hostTop = scroller.getBoundingClientRect().top;
      const top = scroller.scrollTop + 24;
      const offsets = headings.map((heading) => {
        const el = scroller.querySelector(`#gr-h-${heading.line}`);
        if (!(el instanceof HTMLElement)) {
          return Number.POSITIVE_INFINITY;
        }
        return el.getBoundingClientRect().top - hostTop + scroller.scrollTop;
      });
      const index = pickActiveIndex(offsets, top);
      setActiveLine(index === undefined ? undefined : headings[index].line);
    };
    syncActive();
    scroller.addEventListener('scroll', syncActive, { passive: true });
    return () => scroller.removeEventListener('scroll', syncActive);
  }, [readingMode, readingScrollEl, readingScrollRef, noteRef, headings]);

  const jumpTo = (heading: MdHeading) => {
    if (view === undefined) {
      useVaultStore.getState().openNote(noteRef);
      return;
    }
    const jump = () => {
      const docLine = view.state.doc.line(Math.min(heading.line + 1, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: docLine.from },
        effects: EditorView.scrollIntoView(docLine.from, { y: 'start', yMargin: 12 }),
      });
      view.focus();
    };
    if (useUiStore.getState().readingMode) {
      useUiStore.getState().requestReadingJump(heading.line);
      return;
    }
    jump();
  };

  const onHeadingClick = (heading: MdHeading, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void copyWikiLink(noteRef, heading.text);
      return;
    }
    jumpTo(heading);
  };

  const state = doc === undefined ? 'loading' : headings.length === 0 ? 'empty' : 'list';

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="flex items-center gap-1.5 text-caption text-text-2">
          <ListTree size={13} strokeWidth={1.75} />
          Оглавление
        </h3>
        {headings.length > 0 ? (
          <span className="rounded-full bg-bg-3 px-1.5 text-micro text-text-2">{headings.length}</span>
        ) : null}
      </div>
      <Presence mode="wait">
        <Fade key={state}>
          {state === 'loading' ? (
            <div className="flex flex-col gap-1">
              {[0, 1].map((row) => (
                <div
                  key={row}
                  className={cx(
                    'h-8 rounded-s border border-stroke-0',
                    reduced
                      ? 'bg-bg-2'
                      : 'animate-shimmer bg-[length:200%_100%] bg-[image:linear-gradient(90deg,var(--bg-2),var(--bg-3),var(--bg-2))]',
                  )}
                />
              ))}
            </div>
          ) : state === 'empty' ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
              <ListTree size={18} strokeWidth={1.5} className="text-text-3" />
              <p className="max-w-[220px] text-caption text-text-2">В заметке нет заголовков</p>
              <p className="max-w-[220px] text-micro text-text-3">
                Начните строку с <span className="font-mono text-text-1">#</span> — и пункт появится здесь
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {headings.map((heading) => {
                const active = heading.line === activeLine;
                const label = heading.text.length > 0 ? heading.text : '…';
                const link = wikiLinkMarkup(noteTitle, heading.text);
                return (
                  <li key={heading.line}>
                    <div
                      style={{ paddingLeft: (heading.level - minLevel) * 14 + 8 }}
                      className={cx(
                        'group relative flex w-full items-center rounded-s pr-1 outline-none transition-colors duration-[120ms]',
                        !active && 'hover:bg-bg-2',
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId="outline-active-row"
                          className="absolute inset-0 rounded-s bg-accent/10"
                          transition={reduced ? { duration: 0 } : springSnappy}
                        />
                      ) : null}
                      <button
                        type="button"
                        title={`${label} · Ctrl+клик — скопировать ${link}`}
                        onClick={(event) => onHeadingClick(heading, event)}
                        className="relative z-10 min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                      >
                        <span
                          className={cx(
                            heading.level <= 2 ? 'text-ui' : 'text-caption',
                            active
                              ? 'text-accent'
                              : heading.level <= 2
                                ? 'text-text-1 group-hover:text-text-0'
                                : 'text-text-2 group-hover:text-text-1',
                          )}
                        >
                          {label}
                        </span>
                      </button>
                      <Tooltip content={`Скопировать ${link}`} side="left">
                        <button
                          type="button"
                          aria-label={`Скопировать ${link}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyWikiLink(noteRef, heading.text);
                          }}
                          className={cx(
                            'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-xs text-text-3 transition-opacity duration-[120ms] hover:bg-bg-3 hover:text-text-0',
                            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                          )}
                        >
                          <Copy size={12} strokeWidth={1.75} />
                        </button>
                      </Tooltip>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Fade>
      </Presence>
    </div>
  );
}
