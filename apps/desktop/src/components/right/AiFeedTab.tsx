import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronRight,
  Copy,
  FilePen,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable, GRAPHITE_EVENT } from '@graphite/bindings';
import type { Actor, FileChange, JournalOp, JournalOpEvent, McpSessionEvent } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

const FALLBACK_MCP_COMMAND = 'claude mcp add graphite';

type Filter = 'all' | 'assistant' | 'user' | 'external';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'assistant', label: 'Ассистент' },
  { id: 'user', label: 'Вы' },
  { id: 'external', label: 'Внешние' },
];

const ACTOR_META: Record<Actor, { label: string; tint: string; dot: string }> = {
  assistant: { label: 'Ассистент', tint: 'text-ai', dot: 'bg-ai' },
  user: { label: 'Вы', tint: 'text-accent', dot: 'bg-accent' },
  external: { label: 'Внешняя правка', tint: 'text-warn', dot: 'bg-warn' },
};

const TOOL_LABEL: Record<string, string> = {
  note_edit: 'Правка',
  note_create: 'Создание',
  note_move: 'Перемещение',
  note_rename: 'Переименование',
  note_delete: 'Удаление',
  note_restore: 'Восстановление',
  set_status: 'Смена статуса',
  set_icon: 'Иконка',
  note_pin: 'Закрепление',
  link_add: 'Новая связь',
  link_remove: 'Удаление связи',
  plan_create: 'Создание плана',
  plan_update: 'Правка плана',
  distill_save: 'Выжимка',
  bundle_create: 'Коллекция',
  idea_to_tasks: 'Идея в задачи',
  quick_capture: 'Захват',
  task_check: 'Задачи',
  buffer_save: 'Сохранение',
};

interface FeedGroup {
  key: string;
  session?: string;
  actor: Actor;
  ts: string;
  ops: JournalOp[];
}

function reason(error: unknown): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return 'Не удалось выполнить';
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return few;
  }
  return many;
}

function formatTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(parsed)) / 86_400_000);
  if (diffDays === 0) {
    return 'Сегодня';
  }
  if (diffDays === 1) {
    return 'Вчера';
  }
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function fileKind(file: FileChange): 'add' | 'del' | 'mod' {
  const before = file.before ?? '';
  const after = file.after ?? '';
  if (before.length === 0 && after.length > 0) {
    return 'add';
  }
  if (after.length === 0 && before.length > 0) {
    return 'del';
  }
  return 'mod';
}

const KIND_BADGE: Record<'add' | 'del' | 'mod', string> = {
  add: 'bg-ok/12 text-ok',
  del: 'bg-danger/12 text-danger',
  mod: 'bg-warn/12 text-warn',
};

function groupBySession(ops: JournalOp[]): FeedGroup[] {
  const map = new Map<string, FeedGroup>();
  for (const op of ops) {
    const key = op.session ?? `${op.actor}:${op.ts.slice(0, 10)}`;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, { key, session: op.session, actor: op.actor, ts: op.ts, ops: [op] });
    } else {
      existing.ops.push(op);
      if (op.ts > existing.ts) {
        existing.ts = op.ts;
      }
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.ops.sort((a, b) => b.ts.localeCompare(a.ts));
  }
  groups.sort((a, b) => b.ts.localeCompare(a.ts));
  return groups;
}

function DiffStat({ files }: { files: FileChange[] }) {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const file of files) {
    const kind = fileKind(file);
    if (kind === 'add') {
      added += 1;
    } else if (kind === 'del') {
      removed += 1;
    } else {
      modified += 1;
    }
  }
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-micro tabular-nums">
      {added > 0 ? <span className="text-ok">+{added}</span> : null}
      {modified > 0 ? <span className="text-warn">~{modified}</span> : null}
      {removed > 0 ? <span className="text-danger">−{removed}</span> : null}
    </span>
  );
}

function OpCard({
  op,
  busy,
  onUndo,
  reduced,
}: {
  op: JournalOp;
  busy: boolean;
  onUndo: () => void;
  reduced: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toolLabel = op.tool !== undefined ? TOOL_LABEL[op.tool] ?? op.tool : 'Операция';
  return (
    <div
      className={cx(
        'overflow-hidden rounded-s border border-stroke-0 bg-bg-2 transition-opacity',
        op.undone && 'opacity-55',
      )}
    >
      <div className="flex items-start gap-1.5 p-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-0.5 shrink-0 rounded-xs p-0.5 text-text-3 outline-none transition-colors hover:text-text-1"
        >
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className={cx('transition-transform duration-150', open && 'rotate-90')}
          />
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left outline-none"
        >
          <div className={cx('truncate text-ui', op.undone ? 'text-text-2 line-through' : 'text-text-1')}>
            {op.summary}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-micro text-text-3">
            <span>{formatTime(op.ts)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{toolLabel}</span>
          </div>
        </button>
        <DiffStat files={op.files} />
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0.08 } : { type: 'spring', stiffness: 420, damping: 38 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1 border-t border-stroke-0 px-2 py-2">
              {op.files.length > 0 ? (
                op.files.map((file, index) => {
                  const kind = fileKind(file);
                  const Glyph = kind === 'add' ? Plus : kind === 'del' ? Minus : FilePen;
                  return (
                    <button
                      key={`${file.path}-${index}`}
                      type="button"
                      onClick={() => useVaultStore.getState().openNote(`path:${file.path}`)}
                      title={file.path}
                      className="flex items-center gap-2 rounded-xs px-1 py-1 text-left outline-none transition-colors hover:bg-bg-3"
                    >
                      <span
                        aria-hidden
                        className={cx('grid size-4 shrink-0 place-items-center rounded-xs', KIND_BADGE[kind])}
                      >
                        <Glyph size={11} strokeWidth={2.25} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-micro text-text-1">{file.path}</span>
                    </button>
                  );
                })
              ) : (
                <p className="px-1 py-1 text-micro text-text-3">Файлы не затронуты</p>
              )}
              <div className="mt-1 flex items-center justify-between">
                {op.undone ? (
                  <span className="text-micro text-text-3">Отменено</span>
                ) : (
                  <span className="text-micro text-text-3">
                    {op.files.length} {pluralize(op.files.length, 'файл', 'файла', 'файлов')}
                  </span>
                )}
                {!op.undone ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onUndo}
                    className="flex items-center gap-1.5 rounded-s px-2 py-1 text-caption text-text-1 outline-none transition-colors hover:bg-bg-3 hover:text-text-0 disabled:opacity-45"
                  >
                    <Undo2 size={13} strokeWidth={1.75} />
                    Отменить
                  </button>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function AiFeedTab() {
  const pushToast = useUiStore((s) => s.pushToast);
  const reduced = usePrefersReducedMotion();

  const [ops, setOps] = useState<JournalOp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
  const [mcpActive, setMcpActive] = useState(false);
  const [mcpCommand, setMcpCommand] = useState(FALLBACK_MCP_COMMAND);

  useEffect(() => {
    let cancelled = false;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    commands.journalList({ since, limit: 200 }).then(
      (list) => {
        if (!cancelled) {
          setOps(list);
          setConnected(true);
          setLoaded(true);
        }
      },
      (error) => {
        if (!cancelled) {
          setConnected(!(isGraphiteError(error) && error.code === 'UNAVAILABLE'));
          setLoaded(true);
        }
      },
    );
    commands.detectClaudeCli().then(
      (info) => {
        if (!cancelled && info.mcpAddCommand.length > 0) {
          setMcpCommand(info.mcpAddCommand);
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    const subscriptions = [
      listen<McpSessionEvent>(GRAPHITE_EVENT.mcpSession, (event) => {
        setMcpActive(event.payload.active);
      }),
      listen<JournalOpEvent>(GRAPHITE_EVENT.journalOp, (event) => {
        const incoming = event.payload.op;
        setConnected(true);
        setOps((prev) => (prev.some((op) => op.opId === incoming.opId) ? prev : [incoming, ...prev]));
      }),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? ops : ops.filter((op) => op.actor === filter)),
    [ops, filter],
  );
  const groups = useMemo(() => groupBySession(filtered), [filtered]);

  const undoOp = async (op: JournalOp) => {
    setBusyKey(op.opId);
    try {
      const result = await commands.undoOp(op.opId);
      setOps((prev) => prev.map((item) => (item.opId === op.opId ? { ...item, undone: true } : item)));
      pushToast({
        kind: result.conflicts.length > 0 ? 'info' : 'success',
        text:
          result.conflicts.length > 0
            ? `Откат с конфликтами: ${result.conflicts.length}`
            : `Отменено · ${result.restoredFiles} ${pluralize(result.restoredFiles, 'файл', 'файла', 'файлов')}`,
      });
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error) });
    } finally {
      setBusyKey(undefined);
    }
  };

  const undoSession = async (session: string) => {
    setBusyKey(session);
    try {
      const result = await commands.undoSession(session);
      setOps((prev) => prev.map((item) => (item.session === session ? { ...item, undone: true } : item)));
      pushToast({
        kind: result.conflicts.length > 0 ? 'info' : 'success',
        text:
          result.conflicts.length > 0
            ? `Сессия отменена с конфликтами: ${result.conflicts.length}`
            : `Сессия отменена · ${result.restoredFiles} ${pluralize(result.restoredFiles, 'файл', 'файла', 'файлов')}`,
      });
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error) });
    } finally {
      setBusyKey(undefined);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(mcpCommand);
      pushToast({ kind: 'success', text: 'Команда скопирована' });
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось скопировать команду' });
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cx(
              'size-1.5 shrink-0 rounded-full',
              mcpActive ? cx('bg-ai', !reduced && 'animate-pulse-mcp') : 'bg-text-3',
            )}
          />
          <span className="truncate text-caption text-text-2">
            {mcpActive ? 'Ассистент активен' : 'Ассистент не активен'}
          </span>
        </div>
        <Sparkles size={14} strokeWidth={1.75} className={mcpActive ? 'text-ai' : 'text-text-3'} />
      </div>

      {loaded && ops.length > 0 ? (
        <div className="flex items-center gap-1 px-3 pb-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={cx(
                'rounded-full px-2 py-0.5 text-micro transition-colors duration-[120ms]',
                filter === item.id
                  ? 'bg-bg-3 text-text-0'
                  : 'text-text-2 hover:bg-bg-2 hover:text-text-1',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {!loaded ? (
        <div className="flex flex-col gap-2 px-3">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className={cx(
                'h-14 rounded-s border border-stroke-0',
                reduced
                  ? 'bg-bg-2'
                  : 'animate-shimmer bg-[length:200%_100%] bg-[image:linear-gradient(90deg,var(--bg-2),var(--bg-3),var(--bg-2))]',
              )}
            />
          ))}
        </div>
      ) : ops.length === 0 ? (
        connected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Sparkles size={22} strokeWidth={1.5} className="text-text-3" />
            <p className="text-ui text-text-1">Пока пусто</p>
            <p className="max-w-[220px] text-caption text-text-2">
              Правки ассистента будут появляться здесь — с диффом и откатом в один клик.
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Sparkles size={24} strokeWidth={1.5} className="text-text-3" />
            <p className="text-ui text-text-1">Ассистент ещё не подключён</p>
            <p className="text-caption text-text-2">Подключите Claude Code к вашему хранилищу:</p>
            <button
              type="button"
              onClick={() => void copyCommand()}
              className="group flex items-center gap-2 rounded-s border border-stroke-1 bg-bg-2 px-2.5 py-1.5 font-mono text-caption text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
            >
              {mcpCommand}
              <Copy size={13} strokeWidth={1.75} className="shrink-0 text-text-2 group-hover:text-text-0" />
            </button>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {groups.map((group) => {
            const actor = ACTOR_META[group.actor];
            const undoneAll = group.ops.every((op) => op.undone);
            const canUndoSession = group.session !== undefined && !undoneAll;
            return (
              <section key={group.key} className="flex flex-col gap-1.5">
                <header className="sticky top-0 z-10 -mx-3 flex items-center gap-2 bg-bg-1/95 px-3 py-1 backdrop-blur-sm">
                  <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', actor.dot)} />
                  <span className={cx('shrink-0 text-caption', actor.tint)}>{actor.label}</span>
                  <span className="text-micro text-text-3">
                    {formatDayLabel(group.ts)} · {formatTime(group.ts)}
                  </span>
                  <span className="text-micro text-text-3">
                    · {group.ops.length} {pluralize(group.ops.length, 'изменение', 'изменения', 'изменений')}
                  </span>
                  {canUndoSession ? (
                    <button
                      type="button"
                      disabled={busyKey === group.session}
                      onClick={() => group.session !== undefined && void undoSession(group.session)}
                      className="ml-auto flex shrink-0 items-center gap-1 rounded-s px-1.5 py-0.5 text-micro text-text-2 outline-none transition-colors hover:bg-bg-3 hover:text-text-0 disabled:opacity-45"
                    >
                      <RotateCcw size={12} strokeWidth={1.75} />
                      Сессию
                    </button>
                  ) : null}
                </header>
                <div className="flex flex-col gap-1.5">
                  {group.ops.map((op) => (
                    <motion.div
                      key={op.opId}
                      layout={!reduced}
                      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={springSnappy}
                    >
                      <OpCard
                        op={op}
                        busy={busyKey === op.opId}
                        reduced={reduced}
                        onUndo={() => void undoOp(op)}
                      />
                    </motion.div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
