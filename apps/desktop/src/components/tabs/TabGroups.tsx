import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { motion } from 'motion/react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Layers, Palette, Pencil, Plus, X } from 'lucide-react';
import { cx, springTransition } from '@graphite/ui';
import { GROUP_COLORS, useTabsStore } from '../../stores/tabsStore';
import type { Tab, TabGroup } from '../../stores/tabsStore';
import { usePanesStore } from '../../stores/panesStore';
import { resolveIconColor } from '../tree/NoteIcon';

const TAB_DND_TYPE = 'application/x-graphite-tab';

export type StripSegment =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'group'; group: TabGroup; tabs: Tab[] };

export interface TabStrip {
  pinned: Tab[];
  segments: StripSegment[];
}

const byOrder = (a: Tab, b: Tab): number => a.order - b.order;

export function buildTabStrip(paneTabs: Tab[], groups: TabGroup[]): TabStrip {
  const pinned = paneTabs.filter((tab) => tab.pinned).sort(byOrder);
  const unpinned = paneTabs.filter((tab) => !tab.pinned).sort(byOrder);
  const groupById = new Map(groups.map((group) => [group.id, group] as const));
  const segments: StripSegment[] = [];
  const emitted = new Set<string>();
  for (const tab of unpinned) {
    const group = tab.groupId !== undefined ? groupById.get(tab.groupId) : undefined;
    if (group === undefined) {
      segments.push({ kind: 'tab', tab });
      continue;
    }
    if (emitted.has(group.id)) {
      continue;
    }
    emitted.add(group.id);
    segments.push({ kind: 'group', group, tabs: unpinned.filter((member) => member.groupId === group.id) });
  }
  return { pinned, segments };
}

export function flattenStrip(strip: TabStrip): Tab[] {
  const flat: Tab[] = [...strip.pinned];
  for (const segment of strip.segments) {
    if (segment.kind === 'tab') {
      flat.push(segment.tab);
    } else {
      flat.push(...segment.tabs);
    }
  }
  return flat;
}

export function pruneEmptyGroups(): void {
  const { tabs, groups, deleteGroup } = useTabsStore.getState();
  const used = new Set(tabs.map((tab) => tab.groupId).filter((id): id is string => id !== undefined));
  for (const group of groups) {
    if (!used.has(group.id)) {
      deleteGroup(group.id);
    }
  }
}

export function normalizeOrder(paneId: string): void {
  pruneEmptyGroups();
  const { tabs, groups, reorder } = useTabsStore.getState();
  const strip = buildTabStrip(
    tabs.filter((tab) => tab.paneId === paneId),
    groups,
  );
  reorder(
    paneId,
    flattenStrip(strip).map((tab) => tab.id),
  );
}

export type DropTarget =
  | { type: 'tab'; id: string; before: boolean }
  | { type: 'group'; groupId: string }
  | { type: 'end' };

export interface DropPlan {
  orderedIds: string[];
  nextGroupId: string | undefined;
  unpin: boolean;
}

export function planDrop(
  paneTabs: Tab[],
  groups: TabGroup[],
  draggedId: string,
  target: DropTarget,
): DropPlan | null {
  const dragged = paneTabs.find((tab) => tab.id === draggedId);
  if (dragged === undefined) {
    return null;
  }
  const strip = buildTabStrip(paneTabs, groups);
  const pinnedIds = strip.pinned.map((tab) => tab.id).filter((id) => id !== draggedId);
  const unpinned: string[] = [];
  for (const segment of strip.segments) {
    if (segment.kind === 'tab') {
      unpinned.push(segment.tab.id);
    } else {
      for (const member of segment.tabs) {
        unpinned.push(member.id);
      }
    }
  }
  const flat = unpinned.filter((id) => id !== draggedId);

  let index = flat.length;
  let nextGroupId: string | undefined;
  if (target.type === 'tab') {
    if (target.id === draggedId) {
      return null;
    }
    const hovered = paneTabs.find((tab) => tab.id === target.id);
    const at = flat.indexOf(target.id);
    if (at === -1) {
      return null;
    }
    index = target.before ? at : at + 1;
    nextGroupId = hovered?.groupId;
  } else if (target.type === 'group') {
    const members = paneTabs.filter(
      (tab) => tab.groupId === target.groupId && !tab.pinned && tab.id !== draggedId,
    );
    const lastId = members.length > 0 ? members[members.length - 1].id : undefined;
    index = lastId !== undefined ? flat.indexOf(lastId) + 1 : flat.length;
    nextGroupId = target.groupId;
  }
  flat.splice(index, 0, draggedId);
  return { orderedIds: [...pinnedIds, ...flat], nextGroupId, unpin: dragged.pinned };
}

const MENU_CONTENT =
  'z-50 min-w-44 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';
const MENU_SWATCH =
  'z-50 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2 shadow-3';
const CHIP_BASE =
  'relative flex h-7 flex-none cursor-default select-none items-center gap-1.5 rounded-s px-1.5 text-caption text-text-0 transition-opacity duration-[120ms]';

interface ColorSwatchesProps {
  active: string;
  onPick: (color: string) => void;
}

function ColorSwatches({ active, onPick }: ColorSwatchesProps) {
  return (
    <div className="flex items-center gap-1">
      {GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Цвет ${color}`}
          onClick={() => onPick(color)}
          className={cx(
            'size-5 rounded-full border transition-transform duration-[120ms] hover:scale-110',
            active === color ? 'border-text-0' : 'border-stroke-1',
          )}
          style={{ backgroundColor: resolveIconColor(color) }}
        />
      ))}
    </div>
  );
}

export interface GroupChipProps {
  paneId: string;
  group: TabGroup;
  count: number;
  collapsedView: boolean;
  containsActive: boolean;
  isDropTarget: boolean;
  onDragEnter?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
}

export function GroupChip({
  paneId,
  group,
  count,
  collapsedView,
  containsActive,
  isDropTarget,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: GroupChipProps) {
  const toggleCollapsed = useTabsStore((s) => s.toggleGroupCollapsed);
  const renameGroup = useTabsStore((s) => s.renameGroup);
  const setGroupColor = useTabsStore((s) => s.setGroupColor);
  const deleteGroup = useTabsStore((s) => s.deleteGroup);
  const closeTab = useTabsStore((s) => s.close);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);

  const colorVar = resolveIconColor(group.color) ?? 'var(--text-1)';
  const tint = `color-mix(in srgb, ${colorVar} 16%, transparent)`;
  const rings: string[] = [];
  if (containsActive) {
    rings.push(`inset 0 0 0 1px ${colorVar}`);
  }
  if (isDropTarget) {
    rings.push('0 0 0 2px var(--accent)');
  }

  const startEdit = () => {
    setDraft(group.name);
    setEditing(true);
  };
  const commitEdit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name.length > 0 && name !== group.name) {
      renameGroup(group.id, name);
    }
  };
  const ungroup = () => {
    deleteGroup(group.id);
    normalizeOrder(paneId);
  };
  const closeGroupTabs = () => {
    const members = useTabsStore.getState().tabs.filter((tab) => tab.groupId === group.id && tab.paneId === paneId);
    for (const member of members) {
      closeTab(member.id);
    }
    deleteGroup(group.id);
    normalizeOrder(paneId);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <motion.div
          layout
          role="group"
          aria-label={`Группа ${group.name}`}
          title={collapsedView ? `${group.name} · ${count}` : undefined}
          onClick={collapsedView ? () => toggleCollapsed(group.id) : undefined}
          onDoubleClick={startEdit}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springTransition('snappy')}
          style={{ backgroundColor: tint, boxShadow: rings.length > 0 ? rings.join(', ') : undefined }}
          className={cx(CHIP_BASE, collapsedView && 'hover:opacity-80')}
        >
          <button
            type="button"
            aria-label={collapsedView ? 'Развернуть группу' : 'Свернуть группу'}
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapsed(group.id);
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded-xs text-text-2 hover:text-text-0"
          >
            {collapsedView ? (
              <ChevronRight size={13} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={13} strokeWidth={1.75} />
            )}
          </button>
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label="Цвет группы"
                onClick={(event) => event.stopPropagation()}
                className="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/20 transition-transform duration-[120ms] hover:scale-125"
                style={{ backgroundColor: colorVar }}
              />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom"
                align="start"
                sideOffset={8}
                className="z-50 origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2 shadow-3"
              >
                <ColorSwatches active={group.color} onPick={(color) => setGroupColor(group.id, color)} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitEdit}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitEdit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              className="h-5 w-24 rounded-xs border border-stroke-1 bg-bg-1 px-1 text-caption text-text-0 outline-none"
            />
          ) : (
            <span className="max-w-32 truncate font-medium">{group.name}</span>
          )}
          <span className="shrink-0 text-text-2">{count}</span>
        </motion.div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT}>
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => toggleCollapsed(group.id)}>
            {collapsedView ? (
              <ChevronDown size={15} strokeWidth={1.75} className="text-text-2" />
            ) : (
              <ChevronRight size={15} strokeWidth={1.75} className="text-text-2" />
            )}
            {collapsedView ? 'Развернуть' : 'Свернуть'}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              window.setTimeout(startEdit, 0);
            }}
          >
            <Pencil size={15} strokeWidth={1.75} className="text-text-2" />
            Переименовать
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={cx(MENU_ITEM, 'justify-between data-[state=open]:bg-bg-3')}>
              <span className="flex items-center gap-2">
                <Palette size={15} strokeWidth={1.75} className="text-text-2" />
                Цвет
              </span>
              <ChevronRight size={14} strokeWidth={1.75} className="text-text-3" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className={MENU_SWATCH}>
                <ColorSwatches active={group.color} onPick={(color) => setGroupColor(group.id, color)} />
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={ungroup}>
            <Layers size={15} strokeWidth={1.75} className="text-text-2" />
            Разгруппировать
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cx(MENU_ITEM, 'text-danger data-[highlighted]:text-danger')}
            onSelect={closeGroupTabs}
          >
            <X size={15} strokeWidth={1.75} />
            Закрыть вкладки
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export interface TabGroupsProps {
  paneId: string;
}

export function TabGroups({ paneId }: TabGroupsProps) {
  const tabs = useTabsStore((s) => s.tabs);
  const groups = useTabsStore((s) => s.groups);
  const activeTabId = usePanesStore((s) => s.panes.find((p) => p.id === paneId)?.activeTabId);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [dropNew, setDropNew] = useState(false);

  const paneTabs = tabs.filter((tab) => tab.paneId === paneId);
  const present = groups
    .filter((group) => paneTabs.some((tab) => tab.groupId === group.id))
    .sort((a, b) => a.order - b.order);

  if (present.length === 0 && paneTabs.length < 2) {
    return null;
  }

  const acceptsTab = (event: ReactDragEvent<HTMLElement>): boolean => event.dataTransfer.types.includes(TAB_DND_TYPE);

  const bringToPane = (tabId: string, tab: Tab) => {
    if (tab.paneId !== paneId) {
      usePanesStore.getState().moveTabToPane(tabId, paneId);
    }
    if (tab.pinned) {
      useTabsStore.getState().togglePin(tabId);
    }
  };

  const onGroupDragOver = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!acceptsTab(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropGroupId(groupId);
  };
  const onGroupDrop = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!acceptsTab(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const tabId = event.dataTransfer.getData(TAB_DND_TYPE);
    setDropGroupId(null);
    if (tabId === '') {
      return;
    }
    const dragged = useTabsStore.getState().tabs.find((tab) => tab.id === tabId);
    if (dragged === undefined) {
      return;
    }
    bringToPane(tabId, dragged);
    useTabsStore.getState().addToGroup(tabId, groupId);
    normalizeOrder(paneId);
  };

  const createFrom = (tabId?: string) => {
    const store = useTabsStore.getState();
    const target = tabId ?? activeTabId ?? paneTabs[0]?.id;
    if (target === undefined) {
      return;
    }
    const tab = store.tabs.find((candidate) => candidate.id === target);
    if (tab === undefined) {
      return;
    }
    bringToPane(target, tab);
    store.createGroup(undefined, [target]);
    normalizeOrder(paneId);
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-stroke-0 px-2 py-1">
      {present.map((group) => {
        const members = paneTabs.filter((tab) => tab.groupId === group.id);
        return (
          <GroupChip
            key={group.id}
            paneId={paneId}
            group={group}
            count={members.length}
            collapsedView={group.collapsed}
            containsActive={members.some((member) => member.id === activeTabId)}
            isDropTarget={dropGroupId === group.id}
            onDragOver={(event) => onGroupDragOver(event, group.id)}
            onDragLeave={() => setDropGroupId((current) => (current === group.id ? null : current))}
            onDrop={(event) => onGroupDrop(event, group.id)}
          />
        );
      })}
      <button
        type="button"
        aria-label="Новая группа вкладок"
        title="Собрать вкладки в пачку"
        onClick={() => createFrom()}
        onDragOver={(event) => {
          if (!acceptsTab(event)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          setDropNew(true);
        }}
        onDragLeave={() => setDropNew(false)}
        onDrop={(event) => {
          if (!acceptsTab(event)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const tabId = event.dataTransfer.getData(TAB_DND_TYPE);
          setDropNew(false);
          if (tabId !== '') {
            createFrom(tabId);
          }
        }}
        className={cx(
          'flex h-7 flex-none items-center gap-1 rounded-s border border-dashed px-2 text-caption transition-colors duration-[120ms]',
          dropNew ? 'border-accent text-text-0' : 'border-stroke-1 text-text-2 hover:text-text-0',
        )}
      >
        <Plus size={13} strokeWidth={1.75} />
        Группа
      </button>
    </div>
  );
}
