import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { Variants } from 'motion/react';
import { Check, Copy, Loader, ScrollText, X } from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import type { PromptLogEntry, PromptLogMeta } from '@graphite/bindings';
import { Presence, springSnappy, usePrefersReducedMotion } from '../../motion';
import { usePromptHistoryStore } from '../../stores/promptHistoryStore';
import { useUiStore } from '../../stores/uiStore';

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  copyPage: { label: 'Copy Page', className: 'bg-accent/15 text-accent' },
  main: { label: 'Заметка', className: 'bg-accent/15 text-accent' },
  bundle: { label: 'Бандл', className: 'bg-ok/15 text-ok' },
  prompt: { label: 'Промпт', className: 'bg-ai/15 text-ai' },
  brief: { label: 'Бриф', className: 'bg-warn/15 text-warn' },
};

function sourceBadge(source: string): { label: string; className: string } {
  return SOURCE_BADGE[source] ?? { label: source, className: 'bg-bg-3 text-text-2' };
}

function formatChars(chars: number): string {
  if (chars >= 10_000) {
    return `${Math.round(chars / 1000)} тыс`;
  }
  return String(chars);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days === 0) {
    return 'Сегодня';
  }
  if (days === 1) {
    return 'Вчера';
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } },
};

const panelVariants: Variants = {
  initial: { opacity: 0, scale: 0.985, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: springSnappy },
  exit: { opacity: 0, scale: 0.99, y: 6, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } },
};

const reducedVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.08, ease: 'linear' } },
  exit: { opacity: 0, transition: { duration: 0.08, ease: 'linear' } },
};

interface DayGroup {
  label: string;
  items: PromptLogMeta[];
}

/**
 * Оверлей «История промтов»: всё, что уходило в Claude (Copy Page, бандлы,
 * брифы), можно пролистать, перечитать и скопировать снова.
 */
export function PromptHistoryOverlay() {
  const open = usePromptHistoryStore((s) => s.open);
  const setOpen = usePromptHistoryStore((s) => s.setOpen);
  const reduced = usePrefersReducedMotion();

  const [items, setItems] = useState<PromptLogMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<PromptLogEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let disposed = false;
    setLoading(true);
    setSelectedId(null);
    setEntry(null);
    commands
      .promptLogList()
      .then((list) => {
        if (!disposed) {
          setItems(list);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (selectedId === null) {
      setEntry(null);
      return;
    }
    let disposed = false;
    setEntryLoading(true);
    setCopied(false);
    commands
      .promptLogGet(selectedId)
      .then((loaded) => {
        if (!disposed) {
          setEntry(loaded);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) {
          setEntryLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [selectedId]);

  const groups = useMemo<DayGroup[]>(() => {
    const out: DayGroup[] = [];
    let currentKey = '';
    for (const item of items) {
      const key = item.ts.slice(0, 10);
      if (key !== currentKey) {
        currentKey = key;
        out.push({ label: formatDayLabel(item.ts), items: [] });
      }
      out[out.length - 1].items.push(item);
    }
    return out;
  }, [items]);

  const copyAgain = async () => {
    if (entry === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      useUiStore.getState().pushToast({ kind: 'error', text: 'Буфер обмена недоступен' });
    }
  };

  const contentVariants = reduced ? reducedVariants : panelVariants;

  return (
    <Presence>
      {open ? (
        <motion.div
          key="prompt-history-overlay"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 sm:p-8"
          variants={reduced ? reducedVariants : overlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
        >
          <motion.div
            key="prompt-history-panel"
            role="dialog"
            aria-label="История промтов"
            className="flex h-full max-h-[720px] w-full max-w-5xl flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-1 shadow-3"
            variants={contentVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex h-13 shrink-0 items-center gap-3 border-b border-stroke-0 px-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 text-ai">
                <ScrollText size={16} strokeWidth={1.75} />
              </span>
              <div className="flex min-w-0 flex-col">
                <h2 className="text-ui font-semibold text-text-0">История промтов</h2>
                <span className="truncate text-micro text-text-2">
                  {items.length > 0 ? `${items.length} отправок · хранится на этом устройстве` : 'Всё, что уходило в Claude'}
                </span>
              </div>
              <button
                type="button"
                aria-label="Закрыть"
                onClick={close}
                className="ml-auto flex size-8 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </header>

            <div className="flex min-h-0 flex-1">
              <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-stroke-0 py-2">
                {loading && items.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center gap-2 text-caption text-text-2">
                    <Loader size={15} strokeWidth={1.75} className="animate-spin" />
                    Загрузка истории…
                  </div>
                ) : null}
                {!loading && items.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-text-3">
                    <ScrollText size={22} strokeWidth={1.5} />
                    <span className="text-caption">
                      Промтов пока нет — скопируйте страницу для ИИ или соберите бриф, и они появятся здесь.
                    </span>
                  </div>
                ) : null}
                {groups.map((group) => (
                  <div key={group.label} className="flex flex-col">
                    <span className="px-4 pb-1 pt-3 text-micro font-medium uppercase tracking-wide text-text-3">
                      {group.label}
                    </span>
                    {group.items.map((item) => {
                      const badge = sourceBadge(item.source);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSelectedId(item.id)}
                          className={cx(
                            'flex flex-col gap-1 px-4 py-2 text-left transition-colors duration-[120ms] hover:bg-bg-2',
                            selectedId === item.id ? 'bg-bg-2' : undefined,
                          )}
                        >
                          <span className="truncate text-ui text-text-0">
                            {item.title.length > 0 ? item.title : 'Без названия'}
                          </span>
                          <span className="flex items-center gap-2 text-micro text-text-2">
                            <span className={cx('rounded-xs px-1.5 py-px font-medium', badge.className)}>
                              {badge.label}
                            </span>
                            <span>{formatTime(item.ts)}</span>
                            <span>≈ {formatChars(item.chars)} знаков</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                {entry === null ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-3">
                    {entryLoading ? (
                      <Loader size={18} strokeWidth={1.75} className="animate-spin" />
                    ) : (
                      <>
                        <ScrollText size={22} strokeWidth={1.5} />
                        <span className="text-caption">Выберите промт слева, чтобы перечитать его</span>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex shrink-0 items-center gap-2 border-b border-stroke-0 px-4 py-2.5">
                      <span className="min-w-0 truncate text-ui font-medium text-text-0">
                        {entry.title.length > 0 ? entry.title : 'Без названия'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyAgain()}
                        className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-s border border-stroke-1 bg-bg-2 px-2.5 text-caption text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                      >
                        {copied ? (
                          <Check size={13} strokeWidth={1.75} className="text-ok" />
                        ) : (
                          <Copy size={13} strokeWidth={1.75} />
                        )}
                        {copied ? 'Скопировано' : 'Скопировать снова'}
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-text-1">
                        {entry.text}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
