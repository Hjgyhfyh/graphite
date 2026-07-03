import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Diamond,
  FileText,
  Inbox,
  Library,
  ListTodo,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import { GRAPHITE_EVENT, commands, isTauriAvailable } from '@graphite/bindings';
import type { McpSessionEvent } from '@graphite/bindings';
import { Fade, Presence, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

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
}

function StatChip({ icon: Icon, value, label, accent = false }: StatChipProps) {
  return (
    <Tooltip content={`${label}: ${value}`} side="top">
      <span
        aria-label={`${label}: ${value}`}
        className={cx('flex items-center gap-1 tabular-nums', accent ? 'text-accent' : 'text-text-2')}
      >
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {value}
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
      ) : hasVault ? (
        <Fade key="fresh" className="flex items-center gap-1.5 text-text-2">
          <span aria-hidden className="size-1.5 rounded-full bg-ok" />
          Индекс свежий
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
          'flex items-center gap-1.5 rounded-xs px-1 py-0.5 transition-colors duration-[120ms] hover:bg-bg-3',
          active ? 'text-ai' : 'text-text-3',
        )}
      >
        <span className={cx('inline-flex origin-center', active && !reduced ? 'animate-pulse-mcp' : null)}>
          <Diamond size={11} strokeWidth={1.75} fill="currentColor" aria-hidden />
        </span>
        <span className="font-mono text-micro">MCP</span>
      </button>
    </Tooltip>
  );
}

export function StatusBar() {
  const info = useVaultStore((s) => s.info);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const [mcp, setMcp] = useState<McpSessionEvent>({ active: false });

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
        if (!cancelled && status.state !== 'idle') {
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

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-stroke-0 bg-bg-1 px-2.5 text-micro text-text-2">
      <div className="flex min-w-0 items-center gap-2">
        <Library size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
        <span className="truncate text-text-1">{vaultLabel(info?.root)}</span>
        {info !== undefined ? (
          <>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-stroke-0" />
            <div className="flex shrink-0 items-center gap-2.5">
              <StatChip icon={FileText} value={info.counts.notes} label="Заметок" />
              <StatChip icon={Inbox} value={info.counts.inbox} label="Входящие" accent={info.counts.inbox > 0} />
              <StatChip icon={ListTodo} value={info.counts.tasksOpen} label="Открытых задач" />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <IndexIndicator />
        <McpIndicator active={mcp.active} />
        <span aria-hidden className="h-3.5 w-px bg-stroke-0" />
        <Tooltip content={sidebarHidden ? 'Показать панель заметок' : 'Скрыть панель заметок'} side="top">
          <button
            type="button"
            aria-label={sidebarHidden ? 'Показать панель заметок' : 'Скрыть панель заметок'}
            aria-pressed={!sidebarHidden}
            onClick={() => toggleSidebar()}
            className="flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
          >
            {sidebarHidden ? (
              <PanelLeft size={14} strokeWidth={1.75} />
            ) : (
              <PanelLeftClose size={14} strokeWidth={1.75} />
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
