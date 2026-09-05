import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Diamond,
  FileText,
  GitBranch,
  Inbox,
  Library,
  ListTodo,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tooltip, cx, easePoints } from '@graphite/ui';
import { GRAPHITE_EVENT, commands, isTauriAvailable } from '@graphite/bindings';
import type { McpSessionEvent, NoteChangedEvent } from '@graphite/bindings';
import { Fade, Presence, usePrefersReducedMotion } from '../../motion';
import { useGitStore } from '../../stores/gitStore';
import { useNavStore } from '../../stores/navStore';
import { humanSyncError, useSyncStore } from '../../stores/syncStore';
import { useUiStore } from '../../stores/uiStore';
import { useEditorMetaStore } from '../../stores/editorMetaStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Дебаунс git-статуса на note_changed: не гонять пачку git-процессов на каждый автосейв. */
const GIT_STATUS_DEBOUNCE_MS = 4000;

function vaultLabel(root: string | undefined): string {
  if (root === undefined || root.length === 0) {
    return 'Vault не открыт';
  }
  const segments = root.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? root;
}

interface StatChipProps {
  icon: LucideIcon;
  value: number;
  label: string;
  accent?: boolean;
  onClick?: () => void;
}

function StatChip({ icon: Icon, value, label, accent = false, onClick }: StatChipProps) {
  const className = cx(
    'flex items-center gap-1 tabular-nums',
    accent ? 'text-accent' : 'text-text-2',
    onClick !== undefined &&
      'rounded-xs px-1 py-0.5 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0',
  );
  const inner = (
    <>
      <Icon size={12} strokeWidth={1.75} aria-hidden />
      {value}
    </>
  );
  if (onClick !== undefined) {
    return (
      <Tooltip content={`${label}: ${value} · открыть`} side="top">
        <button type="button" aria-label={`${label}: ${value}`} onClick={onClick} className={className}>
          {inner}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={`${label}: ${value}`} side="top">
      <span aria-label={`${label}: ${value}`} className={className}>
        {inner}
      </span>
    </Tooltip>
  );
}

function IndexIndicator() {
  const status = useVaultStore((s) => s.indexStatus);
  const hasVault = useVaultStore((s) => s.info !== undefined);
  const reduced = usePrefersReducedMotion();
  const busy = status.state !== 'idle';
  const fraction = status.total > 0 ? Math.min(1, status.done / status.total) : 0;
  const [everIndexed, setEverIndexed] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    if (busy || status.total > 0) {
      setEverIndexed(true);
    }
  }, [busy, status.total]);

  const rebuild = async () => {
    if (rebuilding || busy || !hasVault || !isTauriAvailable()) {
      return;
    }
    setRebuilding(true);
    try {
      await commands.reindex(true);
      useUiStore.getState().pushToast({ kind: 'success', text: 'Индекс пересобран' });
    } catch {
      useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось пересобрать индекс' });
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <Presence mode="wait">
      {busy ? (
        <Fade key="busy" className="flex items-center gap-1.5">
          <span className="text-text-2">Индексация</span>
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-bg-3">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-accent"
              style={{ transform: `scaleX(${fraction})`, transition: 'transform 300ms var(--ease-out)' }}
            />
            {reduced ? null : (
              <span
                aria-hidden
                className="absolute inset-0 animate-shimmer"
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--text-0) 24%, transparent) 50%, transparent 100%)',
                  backgroundSize: '200% 100%',
                }}
              />
            )}
          </span>
          <span className="tabular-nums text-text-2">
            {status.total > 0 ? `${status.done}/${status.total}` : '…'}
          </span>
        </Fade>
      ) : hasVault && everIndexed ? (
        <Fade key="fresh">
          <Tooltip content="Пересобрать индекс" side="top">
            <button
              type="button"
              onClick={() => void rebuild()}
              disabled={rebuilding}
              className="flex items-center gap-1.5 rounded-xs px-1 py-0.5 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 disabled:opacity-50"
            >
              <span aria-hidden className={cx('size-1.5 rounded-full', rebuilding ? 'bg-warn' : 'bg-ok')} />
              {rebuilding ? 'Пересборка…' : 'Индекс свежий'}
            </button>
          </Tooltip>
        </Fade>
      ) : null}
    </Presence>
  );
}

function McpIndicator({ active }: { active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const openRightPanel = useUiStore((s) => s.openRightPanel);
  const label = active ? 'Ассистент подключён' : 'Ассистент офлайн';
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={() => openRightPanel('aiFeed')}
        className={cx(
          'flex items-center gap-1.5 rounded-xs px-1 py-0.5 transition-[background-color,color,transform] duration-[160ms] ease-out hover:bg-bg-3 active:scale-[0.97]',
          active ? 'text-ai' : 'text-text-3',
        )}
      >
        <span className="relative inline-flex items-center justify-center">
          <AnimatePresence>
            {active && !reduced ? (
              <motion.span
                key="beacon"
                aria-hidden
                className="pointer-events-none absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: easePoints.out }}
              >
                <span className="absolute inset-0 flex items-center justify-center">
                  <motion.span
                    className="rounded-full"
                    style={{ width: 11, height: 11, backgroundColor: 'var(--ai)', filter: 'blur(3.5px)' }}
                    animate={{ opacity: [0.24, 0.55, 0.24], scale: [0.85, 1.4, 0.85] }}
                    transition={{ duration: 2.6, ease: easePoints.inOut, repeat: Infinity }}
                  />
                </span>
                <span className="absolute inset-0 flex items-center justify-center">
                  <motion.span
                    className="rounded-full"
                    style={{ width: 11, height: 11, border: '1px solid var(--ai)' }}
                    animate={{ opacity: [0.45, 0], scale: [0.7, 1.9] }}
                    transition={{ duration: 2.6, ease: easePoints.out, repeat: Infinity, repeatDelay: 0.25 }}
                  />
                </span>
              </motion.span>
            ) : null}
          </AnimatePresence>
          {active && reduced ? (
            <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span
                className="rounded-full"
                style={{ width: 11, height: 11, backgroundColor: 'var(--ai)', filter: 'blur(3.5px)', opacity: 0.4 }}
              />
            </span>
          ) : null}
          <Diamond size={11} strokeWidth={1.75} fill="currentColor" aria-hidden className="relative block" />
        </span>
        <span className="font-mono text-micro">MCP</span>
      </button>
    </Tooltip>
  );
}

function pluralChanges(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return 'изменение';
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'изменения';
  }
  return 'изменений';
}

function relativeStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) {
    return 'только что';
  }
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function NavHistoryControls() {
  const canBack = useNavStore((s) => s.past.length > 0);
  const canForward = useNavStore((s) => s.future.length > 0);
  const buttonClass =
    'group flex size-6 items-center justify-center rounded-xs text-text-2 transition-[background-color,color,transform,opacity] duration-[140ms] ease-out hover:bg-bg-3 hover:text-text-0 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30';
  const iconClass = 'transition-transform duration-[140ms] ease-out';
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content="Назад" side="top">
        <button
          type="button"
          aria-label="Назад к прошлой заметке"
          disabled={!canBack}
          onClick={() => useNavStore.getState().back()}
          className={buttonClass}
        >
          <ChevronLeft size={14} strokeWidth={1.75} className={cx(iconClass, 'group-hover:-translate-x-px')} />
        </button>
      </Tooltip>
      <Tooltip content="Вперёд" side="top">
        <button
          type="button"
          aria-label="Вперёд к следующей заметке"
          disabled={!canForward}
          onClick={() => useNavStore.getState().forward()}
          className={buttonClass}
        >
          <ChevronRight size={14} strokeWidth={1.75} className={cx(iconClass, 'group-hover:translate-x-px')} />
        </button>
      </Tooltip>
    </div>
  );
}

function clockStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function SyncIndicator() {
  const status = useSyncStore((s) => s.status);
  const busy = useSyncStore((s) => s.busy);
  const reduced = usePrefersReducedMotion();

  if (!status.active) {
    return null;
  }
  const syncing = busy || status.state === 'syncing';
  const failed = status.state === 'error' && !syncing;
  const tip = syncing
    ? 'Синхронизация…'
    : failed
      ? humanSyncError(status.lastError)
      : status.lastSyncAt !== undefined
        ? `Синхронизировано · ${clockStamp(status.lastSyncAt)}`
        : 'Ждёт первой синхронизации';
  return (
    <Tooltip content={tip} side="top">
      <button
        type="button"
        aria-label={`Синхронизация: ${tip}`}
        onClick={() => void useSyncStore.getState().syncNow()}
        className={cx(
          'flex items-center gap-1.5 rounded-xs px-1 py-0.5 transition-colors duration-[120ms] hover:bg-bg-3',
          failed ? 'text-danger' : 'text-text-2 hover:text-text-0',
        )}
      >
        <Cloud size={12} strokeWidth={1.75} aria-hidden />
        <span
          aria-hidden
          className={cx(
            'size-1.5 rounded-full',
            failed ? 'bg-danger' : syncing ? 'bg-warn' : 'bg-ok',
            syncing && !reduced && 'animate-pulse',
          )}
        />
      </button>
    </Tooltip>
  );
}

function GitIndicator() {
  const status = useGitStore((s) => s.status);
  const openTimeline = useGitStore((s) => s.openTimeline);

  if (status === null || !status.isRepo) {
    return null;
  }
  const changed = status.changedFiles;
  const label = changed > 0 ? `${changed} ${pluralChanges(changed)}` : 'сохранено';
  const tip =
    status.lastCommit !== undefined
      ? `Снимок: ${status.lastCommit.subject} · ${relativeStamp(status.lastCommit.date)}`
      : 'История версий';
  return (
    <Tooltip content={tip} side="top">
      <button
        type="button"
        aria-label={`История версий · ${label}`}
        onClick={() => openTimeline()}
        className={cx(
          'flex items-center gap-1.5 rounded-xs px-1 py-0.5 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0',
          changed > 0 ? 'text-text-1' : 'text-text-2',
        )}
      >
        <GitBranch size={12} strokeWidth={1.75} aria-hidden />
        <span className="tabular-nums">{label}</span>
        {status.ahead > 0 ? (
          <span className="flex items-center gap-0.5 text-accent">
            <ArrowUp size={11} strokeWidth={2} aria-hidden />
            {status.ahead}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

const TODAY_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function TodayChip() {
  const label = TODAY_FMT.format(new Date());
  return (
    <Tooltip content="Сегодняшний день в дневнике · Ctrl+Shift+J" side="top">
      <button
        type="button"
        aria-label={`Сегодня ${label}`}
        onClick={() => useUiStore.getState().openJournalDay()}
        className="flex items-center gap-1 rounded-xs px-1 py-0.5 tabular-nums text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
      >
        <CalendarDays size={12} strokeWidth={1.75} aria-hidden />
        {label}
      </button>
    </Tooltip>
  );
}

function DocStats() {
  const words = useEditorMetaStore((s) => s.words);
  const readingMin = useEditorMetaStore((s) => s.readingMin);
  const currentRef = useVaultStore((s) => s.currentRef);
  if (currentRef === undefined || words === 0) {
    return null;
  }
  const label =
    readingMin === 0 ? `${words} сл.` : `${words} сл. · ${readingMin} мин`;
  return (
    <Tooltip content="Слов в открытой заметке · оценка чтения" side="top">
      <span className="tabular-nums text-text-2">{label}</span>
    </Tooltip>
  );
}

export function StatusBar() {
  const info = useVaultStore((s) => s.info);
  const railView = useUiStore((s) => s.railView);
  const setRailView = useUiStore((s) => s.setRailView);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarHidden = useUiStore((s) => s.setSidebarHidden);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const [mcp, setMcp] = useState<McpSessionEvent>({ active: false });

  const sidebarView = railView === 'tree' || railView === 'search';
  const sidebarShown = sidebarView && !sidebarHidden;
  const onToggleSidebar = () => {
    if (sidebarView) {
      toggleSidebar();
    } else {
      setRailView('tree');
      setSidebarHidden(false);
    }
  };

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    const subscription = listen<McpSessionEvent>(GRAPHITE_EVENT.mcpSession, (event) => {
      setMcp(event.payload);
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await commands.indexStatus();
        if (!cancelled && status.state !== 'idle' && status.total > 0) {
          useVaultStore.getState().setIndexStatus({ done: status.done, total: status.total });
        }
      } catch {
        /* ядро ещё не подключено — оставляем текущий статус */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void useGitStore.getState().refreshStatus();
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let timer: number | undefined;
    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        void useGitStore.getState().refreshStatus({ silent: true });
      }, GIT_STATUS_DEBOUNCE_MS);
      // Правки пользователя перезапускают дебаунс тихого авто-снимка.
      if (event.payload.actor === 'user') {
        useGitStore.getState().maybeAutoSnapshot();
      }
    });
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-stroke-0 bg-bg-1 px-2.5 text-micro text-text-2">
      <div className="flex min-w-0 items-center gap-2">
        <Library size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
        <span className="truncate text-text-1">{vaultLabel(info?.root)}</span>
        {info !== undefined ? <TodayChip /> : null}
        {info !== undefined ? (
          <>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-stroke-0" />
            <div className="flex shrink-0 items-center gap-2.5">
              <StatChip icon={FileText} value={info.counts.notes} label="Заметок" />
              <StatChip
                icon={Inbox}
                value={info.counts.inbox}
                label="Входящие"
                accent={info.counts.inbox > 0}
                onClick={() => useUiStore.getState().openSearchWith('status:inbox')}
              />
              <StatChip
                icon={ListTodo}
                value={info.counts.tasksOpen}
                label="Открытых задач"
                onClick={() => {
                  useUiStore.getState().setFocusMode(false);
                  useUiStore.getState().setRailView('tasks');
                }}
              />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {info !== undefined ? (
          <>
            <DocStats />
            <span aria-hidden className="h-3.5 w-px bg-stroke-0" />
            <NavHistoryControls />
            <span aria-hidden className="h-3.5 w-px bg-stroke-0" />
          </>
        ) : null}
        <SyncIndicator />
        <GitIndicator />
        <IndexIndicator />
        <McpIndicator active={mcp.active} />
        <span aria-hidden className="h-3.5 w-px bg-stroke-0" />
        <Tooltip content={sidebarShown ? 'Скрыть панель заметок' : 'Показать панель заметок'} side="top">
          <button
            type="button"
            aria-label={sidebarShown ? 'Скрыть панель заметок' : 'Показать панель заметок'}
            aria-pressed={sidebarShown}
            onClick={onToggleSidebar}
            className="flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
          >
            {sidebarShown ? (
              <PanelLeftClose size={14} strokeWidth={1.75} />
            ) : (
              <PanelLeft size={14} strokeWidth={1.75} />
            )}
          </button>
        </Tooltip>
        <Tooltip content={rightPanelOpen ? 'Скрыть правую панель' : 'Показать правую панель'} side="top">
          <button
            type="button"
            aria-label={rightPanelOpen ? 'Скрыть правую панель' : 'Показать правую панель'}
            aria-pressed={rightPanelOpen}
            onClick={() => toggleRightPanel()}
            className="flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
          >
            {rightPanelOpen ? (
              <PanelRightClose size={14} strokeWidth={1.75} />
            ) : (
              <PanelRight size={14} strokeWidth={1.75} />
            )}
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
