import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight, Layers, Pin, PinOff, Plus, SquareArrowOutUpRight, X } from 'lucide-react';
import { cx, springTransition } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import { REDUCED_CROSSFADE, usePrefersReducedMotion } from '../../motion';
import { usePanesStore } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import type { Tab, TabGroup } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { NoteIcon, resolveIconColor } from '../tree/NoteIcon';
import { GroupChip, buildTabStrip, flattenStrip, normalizeOrder, planDrop, pruneEmptyGroups } from './TabGroups';
import type { DropTarget } from './TabGroups';

export interface TabBarProps {
  paneId: string;
  trailing?: ReactNode;
}

export const TAB_DND_TYPE = 'application/x-graphite-tab';

const FULL_TAB =
  'group relative flex h-7 w-full items-center gap-1.5 rounded-s px-2.5 text-ui transition-colors duration-[120ms]';
const PIN_TAB =
  'group relative flex h-7 w-full items-center justify-center rounded-s transition-colors duration-[120ms]';
const MENU_CONTENT =
  'z-50 min-w-48 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';
const DD_CONTENT =
  'z-50 max-h-80 w-64 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop overflow-y-auto rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';

interface TabItemProps {
  tab: Tab;
  paneId: string;
  active: boolean;
  compact: boolean;
  groupColor?: string;
  groups: TabGroup[];
  indicatorId: string;
  reduced: boolean;
  insertion?: 'before' | 'after';
  dragging: boolean;
  onCloseOthers: () => void;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  registerEl: (id: string, el: HTMLDivElement | null) => void;
}

function TabItem({
  tab,
  paneId,
  active,
  compact,
  groupColor,
  groups,
  indicatorId,
  reduced,
  insertion,
  dragging,
  onCloseOthers,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  registerEl,
}: TabItemProps) {
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);

  const pinToggle = () => {
    const store = useTabsStore.getState();
    const current = store.tabs.find((t) => t.id === tab.id);
    if (current === undefined) {
      return;
    }
    if (!current.pinned) {
      store.removeFromGroup(tab.id);
    }
    store.togglePin(tab.id);
    normalizeOrder(paneId);
  };
  const joinGroup = (groupId: string) => {
    const store = useTabsStore.getState();
    if (tab.pinned) {
      store.togglePin(tab.id);
    }
    store.addToGroup(tab.id, groupId);
    normalizeOrder(paneId);
  };
  const createGroup = () => {
    const store = useTabsStore.getState();
    if (tab.pinned) {
      store.togglePin(tab.id);
    }
    store.createGroup(undefined, [tab.id]);
    normalizeOrder(paneId);
  };
  const leaveGroup = () => {
    useTabsStore.getState().removeFromGroup(tab.id);
    normalizeOrder(paneId);
  };
  const detach = () => {
    commands
      .openNoteWindow(tab.noteRef)
      .then(() => close(tab.id))
      .catch(() => {
        useUiStore.getState().pushToast({ kind: 'info', text: 'Отдельное окно недоступно вне приложения' });
      });
  };

  return (
    <motion.div
      layout
      ref={(el) => registerEl(tab.id, el)}
      className={cx('relative flex h-7', compact ? 'w-9 shrink-0' : 'min-w-[120px] max-w-[220px] flex-1 basis-0')}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springTransition('snappy')}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            title={compact ? tab.title : undefined}
            onClick={() => activate(tab.id)}
            onAuxClick={
              compact
                ? undefined
                : (event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      close(tab.id);
                    }
                  }
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate(tab.id);
              }
            }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            className={cx(
              compact ? PIN_TAB : FULL_TAB,
              'cursor-default select-none',
              active ? 'text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
              dragging && 'opacity-40',
            )}
          >
            {active ? (
              <motion.span
                layoutId={indicatorId}
                transition={reduced ? REDUCED_CROSSFADE : springTransition('snappy')}
                className="absolute inset-0 rounded-s bg-bg-3 shadow-1"
              />
            ) : null}

            {compact ? (
              <span className="relative z-10 flex items-center justify-center">
                <NoteIcon
                  icon={tab.icon}
                  color={tab.iconColor}
                  size={16}
                  className={cx(tab.iconColor === undefined && 'text-text-1')}
                />
                {tab.dirty ? (
                  <span
                    aria-label="Не сохранено"
                    className="absolute -right-2 -top-1.5 size-1.5 rounded-full bg-accent ring-2 ring-bg-0"
                  />
                ) : null}
              </span>
            ) : (
              <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
                <NoteIcon
                  icon={tab.icon}
                  color={tab.iconColor}
                  size={14}
                  className={cx('shrink-0', tab.iconColor === undefined && 'text-text-2')}
                />
                {tab.dirty ? (
                  <span aria-label="Не сохранено" className="size-1.5 shrink-0 rounded-full bg-accent" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                <button
                  type="button"
                  aria-label={`Закрыть ${tab.title}`}
                  draggable={false}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(tab.id);
                  }}
                  className={cx(
                    'shrink-0 rounded-xs p-0.5 text-text-2 transition-opacity duration-[120ms] hover:bg-bg-4 hover:text-text-0 focus-visible:opacity-100',
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              </span>
            )}

            {groupColor !== undefined && !compact ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1.5 -bottom-px z-20 h-0.5 rounded-full"
                style={{ backgroundColor: groupColor }}
              />
            ) : null}

            {insertion !== undefined ? (
              <motion.span
                aria-hidden
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={springTransition('snappy')}
                className={cx(
                  'pointer-events-none absolute inset-y-1 z-30 w-0.5 origin-center rounded-full bg-accent',
                  insertion === 'before' ? '-left-1' : '-right-1',
                )}
              />
            ) : null}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <ContextMenu.Item className={MENU_ITEM} onSelect={pinToggle}>
              {tab.pinned ? (
                <PinOff size={15} strokeWidth={1.75} className="text-text-2" />
              ) : (
                <Pin size={15} strokeWidth={1.75} className="text-text-2" />
              )}
              {tab.pinned ? 'Открепить' : 'Закрепить'}
            </ContextMenu.Item>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cx(MENU_ITEM, 'justify-between data-[state=open]:bg-bg-3')}>
                <span className="flex items-center gap-2">
                  <Layers size={15} strokeWidth={1.75} className="text-text-2" />
                  В группу
                </span>
                <ChevronRight size={14} strokeWidth={1.75} className="text-text-3" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={MENU_CONTENT}>
                  {groups.map((group) => (
                    <ContextMenu.Item key={group.id} className={MENU_ITEM} onSelect={() => joinGroup(group.id)}>
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: resolveIconColor(group.color) }}
                      />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    </ContextMenu.Item>
                  ))}
                  {groups.length > 0 ? <ContextMenu.Separator className="my-1 h-px bg-stroke-0" /> : null}
                  <ContextMenu.Item className={MENU_ITEM} onSelect={createGroup}>
                    <Plus size={15} strokeWidth={1.75} className="text-text-2" />
                    Новая группа
                  </ContextMenu.Item>
                  {tab.groupId !== undefined ? (
                    <ContextMenu.Item className={MENU_ITEM} onSelect={leaveGroup}>
                      <X size={15} strokeWidth={1.75} className="text-text-2" />
                      Убрать из группы
                    </ContextMenu.Item>
                  ) : null}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => close(tab.id)}>
              <X size={15} strokeWidth={1.75} className="text-text-2" />
              Закрыть
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={onCloseOthers}>
              <X size={15} strokeWidth={1.75} className="text-text-2" />
              Закрыть другие
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
            <ContextMenu.Item className={MENU_ITEM} onSelect={detach}>
              <SquareArrowOutUpRight size={15} strokeWidth={1.75} className="text-text-2" />
              Вынести в окно
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </motion.div>
  );
}

export function TabBar({ paneId, trailing }: TabBarProps) {
  const tabs = useTabsStore((s) => s.tabs);
  const groups = useTabsStore((s) => s.groups);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);
  const toggleGroupCollapsed = useTabsStore((s) => s.toggleGroupCollapsed);
  const activeTabId = usePanesStore((s) => s.panes.find((p) => p.id === paneId)?.activeTabId);
  const reduced = usePrefersReducedMotion();

  const paneTabs = useMemo(() => tabs.filter((tab) => tab.paneId === paneId), [tabs, paneId]);
  const strip = useMemo(() => buildTabStrip(paneTabs, groups), [paneTabs, groups]);
  const groupsInPane = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of paneTabs) {
      if (!tab.pinned && tab.groupId !== undefined) {
        ids.add(tab.groupId);
      }
    }
    return groups.filter((group) => ids.has(group.id)).sort((a, b) => a.order - b.order);
  }, [paneTabs, groups]);

  const draggedId = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<DropTarget | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overflow, setOverflow] = useState<{ scrollable: boolean; hidden: number }>({ scrollable: false, hidden: 0 });

  const registerEl = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el === null) {
      tabEls.current.delete(id);
    } else {
      tabEls.current.set(id, el);
    }
  }, []);

  const clearDrag = useCallback(() => {
    draggedId.current = undefined;
    setDragging(undefined);
    setDropTarget(undefined);
  }, []);

  const applyDrop = useCallback(
    (id: string, target: DropTarget) => {
      clearDrag();
      const dragged = useTabsStore.getState().tabs.find((tab) => tab.id === id);
      if (dragged === undefined) {
        return;
      }
      if (dragged.paneId !== paneId) {
        usePanesStore.getState().moveTabToPane(id, paneId);
      }
      const state = useTabsStore.getState();
      const current = state.tabs.filter((tab) => tab.paneId === paneId);
      const plan = planDrop(current, state.groups, id, target);
      if (plan === null) {
        return;
      }
      const draggedNow = current.find((tab) => tab.id === id);
      if (plan.unpin) {
        state.togglePin(id);
      }
      if (plan.nextGroupId !== draggedNow?.groupId) {
        if (plan.nextGroupId !== undefined) {
          state.addToGroup(id, plan.nextGroupId);
        } else {
          state.removeFromGroup(id);
        }
      }
      state.reorder(paneId, plan.orderedIds);
      pruneEmptyGroups();
    },
    [clearDrag, paneId],
  );

  const draggedFrom = (event: ReactDragEvent<HTMLDivElement>): string | undefined => {
    const fromData = event.dataTransfer.getData(TAB_DND_TYPE);
    return fromData !== '' ? fromData : draggedId.current;
  };
  const accepts = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    event.dataTransfer.types.includes(TAB_DND_TYPE);

  const handleDragStart = (event: ReactDragEvent<HTMLDivElement>, id: string) => {
    draggedId.current = id;
    setDragging(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TAB_DND_TYPE, id);
  };
  const handleTabDragOver = (event: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (paneTabs.find((tab) => tab.id === id)?.pinned === true) {
      setDropTarget(undefined);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setDropTarget({ type: 'tab', id, before: event.clientX < rect.left + rect.width / 2 });
  };
  const handleTabDrop = (event: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedTabId = draggedFrom(event);
    if (draggedTabId === undefined) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    applyDrop(draggedTabId, { type: 'tab', id, before: event.clientX < rect.left + rect.width / 2 });
  };
  const handleGroupDragOver = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ type: 'group', groupId });
  };
  const handleGroupDrop = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedTabId = draggedFrom(event);
    if (draggedTabId === undefined) {
      return;
    }
    applyDrop(draggedTabId, { type: 'group', groupId });
  };
  const handleEndDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ type: 'end' });
  };
  const handleEndDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    const draggedTabId = draggedFrom(event);
    if (draggedTabId === undefined) {
      return;
    }
    applyDrop(draggedTabId, { type: 'end' });
  };

  const closeOthers = (keepId: string) => {
    for (const tab of paneTabs) {
      if (tab.id !== keepId && !tab.pinned) {
        close(tab.id);
      }
    }
  };

  const activateFromMenu = (tab: Tab) => {
    if (tab.groupId !== undefined) {
      const group = groups.find((g) => g.id === tab.groupId);
      if (group?.collapsed === true) {
        toggleGroupCollapsed(group.id);
      }
    }
    activate(tab.id);
    window.requestAnimationFrame(() => {
      tabEls.current.get(tab.id)?.scrollIntoView({
        inline: 'center',
        block: 'nearest',
        behavior: reduced ? 'auto' : 'smooth',
      });
    });
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    const measure = () => {
      const scrollable = el.scrollWidth > el.clientWidth + 1;
      const container = el.getBoundingClientRect();
      let hidden = 0;
      for (const child of Array.from(el.children)) {
        const rect = child.getBoundingClientRect();
        if (rect.width < 8) {
          continue;
        }
        if (rect.right > container.right + 1 || rect.left < container.left - 1) {
          hidden += 1;
        }
      }
      setOverflow((prev) => (prev.scrollable === scrollable && prev.hidden === hidden ? prev : { scrollable, hidden }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [strip]);

  const indicatorId = `tab-indicator-${paneId}`;
  const insertionFor = (id: string): 'before' | 'after' | undefined => {
    if (dropTarget?.type === 'tab' && dropTarget.id === id) {
      return dropTarget.before ? 'before' : 'after';
    }
    return undefined;
  };
  const sharedTabProps = (tab: Tab, compact: boolean, groupColor?: string) => ({
    tab,
    paneId,
    compact,
    groupColor,
    groups: groupsInPane,
    indicatorId,
    reduced,
    active: tab.id === activeTabId,
    insertion: insertionFor(tab.id),
    dragging: dragging === tab.id,
    onCloseOthers: () => closeOthers(tab.id),
    onDragStart: (event: ReactDragEvent<HTMLDivElement>) => handleDragStart(event, tab.id),
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => handleTabDragOver(event, tab.id),
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => handleTabDrop(event, tab.id),
    onDragEnd: clearDrag,
    registerEl,
  });

  const allInOrder = flattenStrip(strip);

  return (
    <div className="shrink-0 border-b border-stroke-0 bg-bg-0">
      <div className="flex h-9 items-center">
        <div
          ref={scrollRef}
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
          onDragOver={handleEndDragOver}
          onDrop={handleEndDrop}
        >
          {strip.pinned.map((tab) => (
            <TabItem key={tab.id} {...sharedTabProps(tab, true)} />
          ))}
          {strip.pinned.length > 0 && strip.segments.length > 0 ? (
            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 self-center bg-stroke-1" />
          ) : null}
          {strip.segments.map((segment) => {
            if (segment.kind === 'tab') {
              return <TabItem key={segment.tab.id} {...sharedTabProps(segment.tab, false)} />;
            }
            const { group, tabs: members } = segment;
            const colorVar = resolveIconColor(group.color) ?? 'var(--text-1)';
            const containsActive = members.some((member) => member.id === activeTabId);
            const isDropTarget = dropTarget?.type === 'group' && dropTarget.groupId === group.id;
            const chip = (
              <GroupChip
                paneId={paneId}
                group={group}
                count={members.length}
                collapsedView={group.collapsed}
                containsActive={containsActive}
                isDropTarget={isDropTarget}
                onDragOver={(event) => handleGroupDragOver(event, group.id)}
                onDrop={(event) => handleGroupDrop(event, group.id)}
              />
            );
            if (group.collapsed) {
              return <Fragment key={group.id}>{chip}</Fragment>;
            }
            return (
              <Fragment key={group.id}>
                {chip}
                {members.map((member) => (
                  <TabItem key={member.id} {...sharedTabProps(member, false, colorVar)} />
                ))}
              </Fragment>
            );
          })}
        </div>

        {overflow.scrollable ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Все вкладки"
                className="flex h-7 shrink-0 items-center gap-1 rounded-s px-1.5 text-text-2 hover:bg-bg-2 hover:text-text-0"
              >
                <ChevronDown size={15} strokeWidth={1.75} />
                {overflow.hidden > 0 ? <span className="text-caption tabular-nums">+{overflow.hidden}</span> : null}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className={DD_CONTENT}>
                {allInOrder.map((tab) => (
                  <DropdownMenu.Item
                    key={tab.id}
                    className={cx(MENU_ITEM, tab.id === activeTabId && 'bg-bg-3 text-text-0')}
                    onSelect={() => activateFromMenu(tab)}
                  >
                    <NoteIcon
                      icon={tab.icon}
                      color={tab.iconColor}
                      size={15}
                      className={cx('shrink-0', tab.iconColor === undefined && 'text-text-2')}
                    />
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    {tab.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    {tab.groupId !== undefined ? (
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: resolveIconColor(groups.find((g) => g.id === tab.groupId)?.color) }}
                      />
                    ) : null}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}

        {trailing !== undefined ? (
          <div className="flex shrink-0 items-center gap-0.5 border-l border-stroke-0 px-1.5">{trailing}</div>
        ) : null}
      </div>
    </div>
  );
}
