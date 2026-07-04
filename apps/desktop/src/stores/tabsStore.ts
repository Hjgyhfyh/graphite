import { create } from 'zustand';
import type { NoteRef } from '@graphite/bindings';
import { usePanesStore } from './panesStore';
import { useVaultStore } from './vaultStore';

export type TabKind = 'editor' | 'plan' | 'settings' | 'search' | 'tasks';

export interface Tab {
  id: string;
  noteRef: NoteRef;
  title: string;
  dirty: boolean;
  kind: TabKind;
  pinned: boolean;
  groupId?: string;
  paneId: string;
  icon?: string;
  iconColor?: string;
  order: number;
}

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  order: number;
  pinned: boolean;
}

export interface OpenOptions {
  kind?: TabKind;
  paneId?: string;
}

export interface GroupSection {
  group: TabGroup;
  tabs: Tab[];
}

/**
 * Каноничная раскладка таб-полосы одной панели: закреплённые вкладки,
 * затем все группы (закреплённые группы — первыми), затем свободные вкладки.
 */
export interface TabStrip {
  pinned: Tab[];
  groups: GroupSection[];
  loose: Tab[];
}

export interface TabsStore {
  tabs: Tab[];
  groups: TabGroup[];
  draggingTabId?: string;
  draggingGroupId?: string;
  open(ref: NoteRef, opts?: OpenOptions): void;
  close(id: string): void;
  activate(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  remapRef(oldRef: NoteRef, next: { ref: NoteRef; title: string }): void;
  togglePin(id: string): void;
  reorder(paneId: string, orderedIds: string[]): void;
  moveToPane(id: string, paneId: string): void;
  createGroup(name?: string, tabIds?: string[]): string;
  renameGroup(groupId: string, name: string): void;
  setGroupColor(groupId: string, color: string): void;
  toggleGroupCollapsed(groupId: string): void;
  toggleGroupPinned(groupId: string): void;
  moveGroup(groupId: string, direction: -1 | 1): void;
  reorderGroups(orderedIds: string[]): void;
  addToGroup(tabId: string, groupId: string): void;
  removeFromGroup(tabId: string): void;
  deleteGroup(groupId: string): void;
  setTabIcon(id: string, icon?: string, iconColor?: string): void;
  setDraggingTab(id?: string): void;
  setDraggingGroup(id?: string): void;
}

export const GROUP_COLORS = ['accent', 'ai', 'ok', 'warn', 'danger', 'text-1'] as const;

const FOLDER_SUFFIX = '/_index.md';
const PATH_PREFIX = 'path:';

export function titleFromRef(ref: NoteRef): string {
  if (ref.startsWith(PATH_PREFIX)) {
    const path = ref.slice(PATH_PREFIX.length);
    const base = path.split('/').pop() ?? path;
    return base.toLowerCase().endsWith('.md') ? base.slice(0, -'.md'.length) : base;
  }
  return 'Заметка';
}

const byOrder = (a: Tab, b: Tab): number => a.order - b.order;

export function sortGroupsForStrip(groups: readonly TabGroup[]): TabGroup[] {
  return [...groups].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
}

/**
 * Строит раскладку полосы панели. Группы идут всегда левее свободных вкладок;
 * пустая группа (нет вкладок ни в одной панели) остаётся видимой — это живая
 * «пачка», в которую можно бросать вкладки и файлы.
 */
export function buildTabStrip(tabs: readonly Tab[], groups: readonly TabGroup[], paneId: string): TabStrip {
  const inPane = tabs.filter((tab) => tab.paneId === paneId);
  const pinned = inPane.filter((tab) => tab.pinned).sort(byOrder);
  const unpinned = inPane.filter((tab) => !tab.pinned).sort(byOrder);
  const groupById = new Map(groups.map((group) => [group.id, group] as const));
  const usedAnywhere = new Set<string>();
  for (const tab of tabs) {
    if (!tab.pinned && tab.groupId !== undefined) {
      usedAnywhere.add(tab.groupId);
    }
  }
  const sections: GroupSection[] = [];
  for (const group of sortGroupsForStrip(groups)) {
    const members = unpinned.filter((tab) => tab.groupId === group.id);
    if (members.length > 0 || !usedAnywhere.has(group.id)) {
      sections.push({ group, tabs: members });
    }
  }
  const loose = unpinned.filter((tab) => tab.groupId === undefined || !groupById.has(tab.groupId));
  return { pinned, groups: sections, loose };
}

export function flattenStrip(strip: TabStrip): Tab[] {
  return [...strip.pinned, ...strip.groups.flatMap((section) => section.tabs), ...strip.loose];
}

function normalizeState(tabs: Tab[], groups: TabGroup[]): { tabs: Tab[]; groups: TabGroup[] } {
  const orderedGroups = sortGroupsForStrip(groups).map((group, index) =>
    group.order === index ? group : { ...group, order: index },
  );
  const orderById = new Map<string, number>();
  const paneIds = new Set(tabs.map((tab) => tab.paneId));
  for (const paneId of paneIds) {
    flattenStrip(buildTabStrip(tabs, orderedGroups, paneId)).forEach((tab, index) => {
      orderById.set(tab.id, index);
    });
  }
  const orderedTabs = tabs.map((tab) => {
    const order = orderById.get(tab.id);
    return order === undefined || order === tab.order ? tab : { ...tab, order };
  });
  return { tabs: orderedTabs, groups: orderedGroups };
}

function pruneGroups(tabs: Tab[], groups: TabGroup[], candidateIds: readonly (string | undefined)[]): TabGroup[] {
  const candidates = new Set(candidateIds.filter((id): id is string => id !== undefined));
  if (candidates.size === 0) {
    return groups;
  }
  const used = new Set<string>();
  for (const tab of tabs) {
    if (tab.groupId !== undefined) {
      used.add(tab.groupId);
    }
  }
  return groups.filter((group) => group.pinned || !candidates.has(group.id) || used.has(group.id));
}

function nextOrder(tabs: Tab[], paneId: string): number {
  const orders = tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function nextGroupOrder(groups: TabGroup[]): number {
  const orders = groups.map((group) => group.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function siblingIn(tabs: Tab[], paneId: string, excludeId: string): string | undefined {
  const siblings = tabs
    .filter((tab) => tab.paneId === paneId && tab.id !== excludeId)
    .sort(byOrder);
  return siblings[siblings.length - 1]?.id;
}

function folderDir(ref: NoteRef): string | undefined {
  if (!ref.startsWith(PATH_PREFIX)) {
    return undefined;
  }
  const path = ref.slice(PATH_PREFIX.length);
  return path.endsWith(FOLDER_SUFFIX) ? path.slice(0, -FOLDER_SUFFIX.length) : undefined;
}

export const useTabsStore = create<TabsStore>()((set, get) => ({
  tabs: [],
  groups: [],
  draggingTabId: undefined,
  draggingGroupId: undefined,
  open: (ref, opts) => {
    const panes = usePanesStore.getState();
    const paneId = opts?.paneId ?? panes.activePaneId;
    const kind: TabKind = opts?.kind ?? 'editor';
    const existing = get().tabs.find((tab) => tab.noteRef === ref && tab.kind === kind && tab.paneId === paneId);
    if (existing !== undefined) {
      panes.setPaneActiveTab(paneId, existing.id);
      panes.setActivePane(paneId);
      return;
    }
    const iconInfo = useVaultStore.getState().iconByRef[ref];
    const tab: Tab = {
      id: crypto.randomUUID(),
      noteRef: ref,
      title: titleFromRef(ref),
      dirty: false,
      kind,
      pinned: false,
      paneId,
      icon: iconInfo?.icon,
      iconColor: iconInfo?.color,
      order: nextOrder(get().tabs, paneId),
    };
    set((s) => normalizeState([...s.tabs, tab], s.groups));
    panes.setPaneActiveTab(paneId, tab.id);
    panes.setActivePane(paneId);
  },
  close: (id) => {
    const closing = get().tabs.find((tab) => tab.id === id);
    if (closing === undefined) {
      return;
    }
    const sibling = siblingIn(get().tabs, closing.paneId, id);
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.id !== id);
      return normalizeState(tabs, pruneGroups(tabs, s.groups, [closing.groupId]));
    });
    const panes = usePanesStore.getState();
    const pane = panes.panes.find((p) => p.id === closing.paneId);
    if (pane?.activeTabId === id) {
      panes.setPaneActiveTab(closing.paneId, sibling);
    }
  },
  activate: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab === undefined) {
      return;
    }
    const panes = usePanesStore.getState();
    panes.setPaneActiveTab(tab.paneId, id);
    panes.setActivePane(tab.paneId);
  },
  setDirty: (id, dirty) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)) }));
  },
  remapRef: (oldRef, next) => {
    const oldDir = folderDir(oldRef);
    const newDir = folderDir(next.ref);
    const childPrefix = oldDir !== undefined ? `${PATH_PREFIX}${oldDir}/` : undefined;
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.noteRef === oldRef) {
          return { ...tab, noteRef: next.ref, title: next.title };
        }
        if (childPrefix !== undefined && newDir !== undefined && tab.noteRef.startsWith(childPrefix)) {
          const tail = tab.noteRef.slice(childPrefix.length);
          return { ...tab, noteRef: `${PATH_PREFIX}${newDir}/${tail}` };
        }
        return tab;
      }),
    }));
  },
  togglePin: (id) => {
    set((s) => {
      const current = s.tabs.find((tab) => tab.id === id);
      if (current === undefined) {
        return s;
      }
      const tabs = s.tabs.map((tab) => {
        if (tab.id !== id) {
          return tab;
        }
        const pinned = !tab.pinned;
        return pinned ? { ...tab, pinned, groupId: undefined } : { ...tab, pinned };
      });
      return normalizeState(tabs, pruneGroups(tabs, s.groups, [current.groupId]));
    });
  },
  reorder: (paneId, orderedIds) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.paneId !== paneId) {
          return tab;
        }
        const index = orderedIds.indexOf(tab.id);
        return index === -1 ? tab : { ...tab, order: index };
      }),
    }));
  },
  moveToPane: (id, paneId) => {
    set((s) => {
      const current = s.tabs.find((tab) => tab.id === id);
      if (current === undefined || current.paneId === paneId) {
        return s;
      }
      const order = nextOrder(s.tabs, paneId);
      const tabs = s.tabs.map((tab) => (tab.id === id ? { ...tab, paneId, order } : tab));
      return normalizeState(tabs, s.groups);
    });
  },
  createGroup: (name, tabIds) => {
    const id = crypto.randomUUID();
    set((s) => {
      const group: TabGroup = {
        id,
        name: name ?? 'Группа',
        color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length],
        collapsed: false,
        order: nextGroupOrder(s.groups),
        pinned: false,
      };
      const members = new Set(tabIds ?? []);
      const previousGroupIds = s.tabs.filter((tab) => members.has(tab.id)).map((tab) => tab.groupId);
      const tabs = s.tabs.map((tab) =>
        members.has(tab.id) ? { ...tab, groupId: id, pinned: false } : tab,
      );
      return normalizeState(tabs, pruneGroups(tabs, [...s.groups, group], previousGroupIds));
    });
    return id;
  },
  renameGroup: (groupId, name) => {
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) }));
  },
  setGroupColor: (groupId, color) => {
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) }));
  },
  toggleGroupCollapsed: (groupId) => {
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)) }));
  },
  toggleGroupPinned: (groupId) => {
    set((s) => {
      const groups = s.groups.map((g) => (g.id === groupId ? { ...g, pinned: !g.pinned } : g));
      return normalizeState(s.tabs, groups);
    });
  },
  moveGroup: (groupId, direction) => {
    set((s) => {
      const sequence = sortGroupsForStrip(s.groups);
      const index = sequence.findIndex((group) => group.id === groupId);
      if (index === -1) {
        return s;
      }
      const neighbor = sequence[index + direction];
      if (neighbor === undefined || neighbor.pinned !== sequence[index].pinned) {
        return s;
      }
      [sequence[index], sequence[index + direction]] = [sequence[index + direction], sequence[index]];
      const orderById = new Map(sequence.map((group, at) => [group.id, at] as const));
      const groups = s.groups.map((group) => ({ ...group, order: orderById.get(group.id) ?? group.order }));
      return normalizeState(s.tabs, groups);
    });
  },
  reorderGroups: (orderedIds) => {
    set((s) => {
      const groups = s.groups.map((group) => {
        const index = orderedIds.indexOf(group.id);
        return index === -1 ? group : { ...group, order: index };
      });
      return normalizeState(s.tabs, groups);
    });
  },
  addToGroup: (tabId, groupId) => {
    set((s) => {
      const current = s.tabs.find((tab) => tab.id === tabId);
      if (current === undefined || s.groups.every((group) => group.id !== groupId)) {
        return s;
      }
      const tabs = s.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId, pinned: false } : tab));
      return normalizeState(tabs, pruneGroups(tabs, s.groups, [current.groupId]));
    });
  },
  removeFromGroup: (tabId) => {
    set((s) => {
      const current = s.tabs.find((tab) => tab.id === tabId);
      if (current === undefined || current.groupId === undefined) {
        return s;
      }
      const tabs = s.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId: undefined } : tab));
      return normalizeState(tabs, pruneGroups(tabs, s.groups, [current.groupId]));
    });
  },
  deleteGroup: (groupId) => {
    set((s) => {
      const groups = s.groups.filter((g) => g.id !== groupId);
      const tabs = s.tabs.map((tab) => (tab.groupId === groupId ? { ...tab, groupId: undefined } : tab));
      return normalizeState(tabs, groups);
    });
  },
  setTabIcon: (id, icon, iconColor) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, icon, iconColor } : tab)) }));
  },
  setDraggingTab: (id) => {
    if (get().draggingTabId !== id) {
      set({ draggingTabId: id });
    }
  },
  setDraggingGroup: (id) => {
    if (get().draggingGroupId !== id) {
      set({ draggingGroupId: id });
    }
  },
}));
