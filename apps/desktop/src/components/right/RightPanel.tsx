import { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { PanelRightClose } from 'lucide-react';
import { cx } from '@graphite/ui';
import type { NoteRef } from '@graphite/bindings';
import { Presence, Fade, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import type { RightPanelTab } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { usePanesStore } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import { PropertiesTab } from './PropertiesTab';

const AiFeedTab = lazy(() => import('./AiFeedTab').then((module) => ({ default: module.AiFeedTab })));
const BacklinksTab = lazy(() => import('./BacklinksTab').then((module) => ({ default: module.BacklinksTab })));
const BundlePanel = lazy(() =>
  import('../bundle/BundlePanel').then((module) => ({ default: module.BundlePanel })),
);
const LinksTab = lazy(() => import('./LinksTab').then((module) => ({ default: module.LinksTab })));
const OutlineTab = lazy(() => import('./OutlineTab').then((module) => ({ default: module.OutlineTab })));

export interface RightPanelProps {
  tab: RightPanelTab;
  width: number;
  onWidthChange: (w: number) => void;
}

const TABS: ReadonlyArray<{ id: RightPanelTab; label: string }> = [
  { id: 'properties', label: 'Свойства' },
  { id: 'aiFeed', label: 'ИИ-лента' },
  { id: 'links', label: 'Связи' },
  { id: 'backlinks', label: 'Бэклинки' },
  { id: 'outline', label: 'Оглавление' },
];

function NoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-ui text-text-2">{children}</p>
    </div>
  );
}

export function RightPanel({ tab, width, onWidthChange }: RightPanelProps) {
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const currentRef = useVaultStore((s) => s.currentRef);
  const panes = usePanesStore((s) => s.panes);
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const tabs = useTabsStore((s) => s.tabs);
  const reduced = usePrefersReducedMotion();

  const active = useMemo<{ ref: NoteRef | undefined; tabId: string | undefined }>(() => {
    const pane = panes.find((p) => p.id === activePaneId) ?? panes[0];
    const tabId = pane?.activeTabId;
    const editorTab = tabId !== undefined ? tabs.find((t) => t.id === tabId) : undefined;
    if (editorTab !== undefined && editorTab.kind === 'editor') {
      return { ref: editorTab.noteRef, tabId: editorTab.id };
    }
    return { ref: currentRef, tabId: undefined };
  }, [panes, activePaneId, tabs, currentRef]);

  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      resizeCleanup.current?.();
      resizeCleanup.current = null;
    },
    [],
  );

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = width;
    let frame = 0;
    let lastX = startX;
    const onMove = (moveEvent: PointerEvent) => {
      lastX = moveEvent.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onWidthChange(startWidth + (startX - lastX));
      });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      onWidthChange(startWidth + (startX - lastX));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      resizeCleanup.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    resizeCleanup.current = finish;
  };

  const renderTab = () => {
    if (tab === 'properties') {
      return active.ref !== undefined ? (
        <PropertiesTab key={active.ref} noteRef={active.ref} />
      ) : (
        <NoNote>Откройте заметку, чтобы увидеть её свойства</NoNote>
      );
    }
    if (tab === 'aiFeed') {
      return <AiFeedTab />;
    }
    if (tab === 'links') {
      return active.ref !== undefined ? (
        <div key={active.ref} className="flex flex-col">
          <LinksTab noteRef={active.ref} />
          <div className="border-t border-stroke-0" />
          <BundlePanel noteRef={active.ref} />
        </div>
      ) : (
        <NoNote>Откройте заметку, чтобы увидеть её связи</NoNote>
      );
    }
    if (tab === 'outline') {
      return active.ref !== undefined ? (
        <OutlineTab key={active.ref} noteRef={active.ref} tabId={active.tabId} />
      ) : (
        <NoNote>Откройте заметку, чтобы увидеть оглавление</NoNote>
      );
    }
    return active.ref !== undefined ? (
      <BacklinksTab key={active.ref} noteRef={active.ref} />
    ) : (
      <NoNote>Откройте заметку, чтобы увидеть бэклинки</NoNote>
    );
  };

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-stroke-0 bg-bg-1"
      style={{ width }}
      aria-label="Правая панель"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke-0 pl-1.5 pr-1">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {TABS.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRightPanelTab(item.id)}
                className={cx(
                  'relative h-7 shrink-0 rounded-s px-2.5 text-caption transition-colors duration-[120ms]',
                  active ? 'text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="right-tab-pill"
                    className="absolute inset-0 rounded-s bg-bg-3"
                    transition={reduced ? { duration: 0 } : springSnappy}
                  />
                ) : null}
                <span className="relative z-10">{item.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Скрыть правую панель"
          title="Скрыть панель · Alt+\"
          onClick={() => toggleRightPanel()}
          className="shrink-0 rounded-xs p-1.5 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
        >
          <PanelRightClose size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Presence mode="wait">
          <Fade key={tab} className="min-h-full">
            <Suspense
              fallback={
                <div role="status" className="flex min-h-32 items-center justify-center text-caption text-text-2">
                  Загружаем панель…
                </div>
              }
            >
              {renderTab()}
            </Suspense>
          </Fade>
        </Presence>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину правой панели"
        className="absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize hover:bg-stroke-1 active:bg-stroke-1"
        onPointerDown={onHandlePointerDown}
      />
    </aside>
  );
}
