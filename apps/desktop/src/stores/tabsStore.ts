import { create } from 'zustand';
import type { NoteRef } from '@graphite/bindings';
import { usePanesStore } from './panesStore';

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
}

export interface OpenOptions {
  kind?: TabKind;
  paneId?: string;
}

export interface TabsStore {
  tabs: Tab[];
  groups: TabGroup[];
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
  addToGroup(tabId: string, groupId: string): void;
  removeFromGroup(tabId: string): void;
  deleteGroup(groupId: string): void;
  setTabIcon(id: string, icon?: string, iconColor?: string): void;
}

export const GROUP_COLORS = ['accent', 'ai', 'ok', 'warn', 'danger', 'text-1'] as const;

export function titleFromRef(ref: NoteRef): string {
  if (ref.startsWith('path:')) {
    const path = ref.slice('path:'.length);
    const base = path.split('/').pop() ?? path;
    return base.toLowerCase().endsWith('.md') ? base.slice(0, -'.md'.length) : base;
  }
  return 'Заметка';
}

function nextOrder(tabs: Tab[], paneId: string): number {
  const orders = tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function siblingIn(tabs: Tab[], paneId: string, excludeId: string): string | undefined {
  const siblings = tabs
    .filter((tab) => tab.paneId === paneId && tab.id !== excludeId)
    .sort((a, b) => a.order - b.order);
  return siblings[siblings.length - 1]?.id;
}

export const useTabsStore = create<TabsStore>()((set, get) => ({
  tabs: [],
  groups: [],
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
    const tab: Tab = {
      id: crypto.randomUUID(),
      noteRef: ref,
      title: titleFromRef(ref),
      dirty: false,
      kind,
      pinned: false,
      paneId,
      order: nextOrder(get().tabs, paneId),
    };
    set((s) => ({ tabs: [...s.tabs, tab] }));
    panes.setPaneActiveTab(paneId, tab.id);
    panes.setActivePane(paneId);
  },
  close: (id) => {
    const closing = get().tabs.find((tab) => tab.id === id);
    if (closing === undefined) {
      return;
    }
    const sibling = siblingIn(get().tabs, closing.paneId, id);
    set((s) => ({ tabs: s.tabs.filter((tab) => tab.id !== id) }));
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
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.noteRef === oldRef ? { ...tab, noteRef: next.ref, title: next.title } : tab)),
    }));
  },
  togglePin: (id) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)) }));
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
      const order = nextOrder(s.tabs, paneId);
      return { tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, paneId, order } : tab)) };
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
        order: s.groups.length,
      };
      const members = new Set(tabIds ?? []);
      return {
        groups: [...s.groups, group],
        tabs: s.tabs.map((tab) => (members.has(tab.id) ? { ...tab, groupId: id } : tab)),
      };
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
  addToGroup: (tabId, groupId) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId } : tab)) }));
  },
  removeFromGroup: (tabId) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId: undefined } : tab)) }));
  },
  deleteGroup: (groupId) => {
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== groupId),
      tabs: s.tabs.map((tab) => (tab.groupId === groupId ? { ...tab, groupId: undefined } : tab)),
    }));
  },
  setTabIcon: (id, icon, iconColor) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, icon, iconColor } : tab)) }));
  },
}));
