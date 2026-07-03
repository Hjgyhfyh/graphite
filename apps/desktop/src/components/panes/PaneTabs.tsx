import { Fragment, useState } from 'react';
import type { DragEvent } from 'react';
import { Columns2, PanelRightClose, Pin, SquareArrowOutUpRight, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Tooltip, cx, springTransition } from '@graphite/ui';
import { MAX_PANES, usePanesStore } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import type { Tab } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { usePrefersReducedMotion } from '../../motion';
import { NoteIcon } from '../tree/NoteIcon';
import { TabGroups } from '../tabs/TabGroups';

export interface PaneTabsProps {
  paneId: string;
}

export const TAB_DND_TYPE = 'application/x-graphite-tab';

const CONTROL = 'flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors hover:bg-bg-3 hover:text-text-0';

function orderTabs(tabs: Tab[]): Tab[] {
  return [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
}

function clampIndex(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function ActiveIndicator({ paneId, reduced }: { paneId: string; reduced: boolean }) {
  if (reduced) {
    return <span aria-hidden className="pointer-events-none absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" />;
  }
  return (
    <motion.span
      aria-hidden
      layoutId={`pane-active-${paneId}`}
      transition={springTransition('snappy')}
      className="pointer-events-none absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent"
    />
  );
}

function DropLine() {
  return <span aria-hidden className="h-6 w-0.5 shrink-0 rounded-full bg-accent" />;
}

export function PaneTabs({ paneId }: PaneTabsProps) {
  const reduced = usePrefersReducedMotion();
  const tabs = useTabsStore((s) => s.tabs);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);
  const reorder = useTabsStore((s) => s.reorder);
  const moveTabToPane = usePanesStore((s) => s.moveTabToPane);
  const activeTabId = usePanesStore((s) => s.panes.find((p) => p.id === paneId)?.activeTabId);
  const paneCount = usePanesStore((s) => s.panes.length);
  const addPane = usePanesStore((s) => s.addPane);
  const removePane = usePanesStore((s) => s.removePane);
  const pushToast = useUiStore((s) => s.pushToast);

  const paneTabs = orderTabs(tabs.filter((tab) => tab.paneId === paneId));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);

  const onTabDragStart = (event: DragEvent<HTMLDivElement>, tab: Tab) => {
    event.dataTransfer.setData(TAB_DND_TYPE, tab.id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(tab.id);
  };

  const onTabDragEnd = () => {
    setDraggingId(null);
    setDropGap(null);
  };

  const onTabDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    setDropGap(after ? index + 1 : index);
  };

  const onStripDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (event.target === event.currentTarget) {
      setDropGap(paneTabs.length);
    }
  };

  const onStripDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropGap(null);
    }
  };

  const onStripDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedId = event.dataTransfer.getData(TAB_DND_TYPE);
    const gap = dropGap ?? paneTabs.length;
    setDropGap(null);
    setDraggingId(null);
    if (draggedId === '') {
      return;
    }
    const source = useTabsStore.getState().tabs.find((tab) => tab.id === draggedId);
    if (source === undefined) {
      return;
    }
    const currentIds = paneTabs.map((tab) => tab.id);
    if (source.paneId === paneId) {
      const without = currentIds.filter((id) => id !== draggedId);
      const from = currentIds.indexOf(draggedId);
      const target = clampIndex(from !== -1 && from < gap ? gap - 1 : gap, without.length);
      without.splice(target, 0, draggedId);
      reorder(paneId, without);
    } else {
      moveTabToPane(draggedId, paneId);
      const next = [...currentIds];
      next.splice(clampIndex(gap, next.length), 0, draggedId);
      reorder(paneId, next);
    }
  };

  const detachActive = () => {
    if (activeTabId === undefined) {
      pushToast({ kind: 'info', text: 'Нет активной вкладки для выноса' });
      return;
    }
    if (paneTabs.length <= 1) {
      pushToast({ kind: 'info', text: 'Отдельное окно — скоро' });
      return;
    }
    const newPaneId = addPane();
    if (newPaneId === undefined) {
      pushToast({ kind: 'info', text: `Отдельное окно — скоро. Достигнут предел областей (${MAX_PANES}).` });
      return;
    }
    moveTabToPane(activeTabId, newPaneId);
    pushToast({ kind: 'info', text: 'Отдельное окно — скоро. Пока вынес в новую область.' });
  };

  return (
    <div className="shrink-0 border-b border-stroke-0 bg-bg-0">
      <TabGroups paneId={paneId} />
      <div className="flex h-9 items-center">
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
          onDragOver={onStripDragOver}
          onDragLeave={onStripDragLeave}
          onDrop={onStripDrop}
        >
          {paneTabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            return (
              <Fragment key={tab.id}>
                {dropGap === index ? <DropLine /> : null}
                <div
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  draggable
                  onDragStart={(event) => onTabDragStart(event, tab)}
                  onDragEnd={onTabDragEnd}
                  onDragOver={(event) => onTabDragOver(event, index)}
                  onClick={() => activate(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      close(tab.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate(tab.id);
                    }
                  }}
                  className={cx(
                    'group relative flex h-7 min-w-[120px] max-w-[220px] flex-1 cursor-default select-none items-center gap-1.5 rounded-s px-2.5 text-ui transition-colors duration-[120ms]',
                    active ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
                    draggingId === tab.id ? 'opacity-50' : undefined,
                  )}
                >
                  {tab.icon !== undefined ? (
                    <NoteIcon icon={tab.icon} color={tab.iconColor} size={14} className="shrink-0" />
                  ) : null}
                  {tab.dirty ? (
                    <span aria-label="Не сохранено" className="size-1.5 shrink-0 rounded-full bg-accent" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  {tab.pinned ? (
                    <Pin size={12} strokeWidth={1.75} className="shrink-0 text-text-2" />
                  ) : (
                    <button
                      type="button"
                      aria-label={`Закрыть ${tab.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        close(tab.id);
                      }}
                      className="rounded-xs p-0.5 text-text-2 opacity-0 transition-opacity duration-[120ms] hover:bg-bg-4 hover:text-text-0 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={13} strokeWidth={1.75} />
                    </button>
                  )}
                  {active ? <ActiveIndicator paneId={paneId} reduced={reduced} /> : null}
                </div>
              </Fragment>
            );
          })}
          {dropGap === paneTabs.length ? <DropLine /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-stroke-0 px-1.5">
          {paneCount < MAX_PANES ? (
            <Tooltip content="Разделить область" side="bottom">
              <button type="button" aria-label="Разделить область" className={CONTROL} onClick={() => addPane()}>
                <Columns2 size={15} strokeWidth={1.75} />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content="В отдельное окно" side="bottom">
            <button type="button" aria-label="В отдельное окно" className={CONTROL} onClick={detachActive}>
              <SquareArrowOutUpRight size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
          {paneCount > 1 ? (
            <Tooltip content="Закрыть область" side="bottom">
              <button type="button" aria-label="Закрыть область" className={CONTROL} onClick={() => removePane(paneId)}>
                <PanelRightClose size={15} strokeWidth={1.75} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}
