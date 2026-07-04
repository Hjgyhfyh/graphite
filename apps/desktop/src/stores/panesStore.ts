import { create } from 'zustand';
import { useTabsStore } from './tabsStore';
import { useVaultStore } from './vaultStore';

export const MAX_PANES = 5;

const INITIAL_PANE_ID = 'pane-1';

export interface Pane {
  id: string;
  activeTabId?: string;
}

export interface PanesStore {
  panes: Pane[];
  activePaneId: string;
  addPane(): string | undefined;
  removePane(id: string): void;
  setActivePane(id: string): void;
  setPaneActiveTab(paneId: string, tabId?: string): void;
  moveTabToPane(tabId: string, paneId: string): void;
}

export function activeTab(state: PanesStore): { paneId: string; tabId?: string } {
  const pane = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0];
  return { paneId: pane.id, tabId: pane.activeTabId };
}

/**
 * Держит `vaultStore.currentRef` равным заметке видимой (активной) editor-вкладки
 * активной панели. Клик по вкладке, переключение панели split-view и закрытие
 * вкладки идут через панель-стор — правая панель, дерево и хоткеи благодаря этому
 * всегда указывают на заметку, которую пользователь реально видит.
 */
function syncCurrentRef(state: PanesStore): void {
  const pane = state.panes.find((p) => p.id === state.activePaneId);
  const tab = pane?.activeTabId === undefined
    ? undefined
    : useTabsStore.getState().tabs.find((t) => t.id === pane.activeTabId);
  const nextRef = tab !== undefined && tab.kind === 'editor' ? tab.noteRef : undefined;
  if (useVaultStore.getState().currentRef !== nextRef) {
    useVaultStore.setState({ currentRef: nextRef });
  }
}

export const usePanesStore = create<PanesStore>()((set, get) => ({
  panes: [{ id: INITIAL_PANE_ID, activeTabId: undefined }],
  activePaneId: INITIAL_PANE_ID,
  addPane: () => {
    if (get().panes.length >= MAX_PANES) {
      return undefined;
    }
    const id = `pane-${crypto.randomUUID().slice(0, 8)}`;
    set((s) => ({ panes: [...s.panes, { id, activeTabId: undefined }], activePaneId: id }));
    return id;
  },
  removePane: (id) => {
    const { panes } = get();
    if (panes.length <= 1) {
      return;
    }
    const index = panes.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    const fallback = panes[index - 1] ?? panes[index + 1];
    const orphanTabs = useTabsStore.getState().tabs.filter((tab) => tab.paneId === id);
    for (const tab of orphanTabs) {
      useTabsStore.getState().moveToPane(tab.id, fallback.id);
    }
    set((s) => {
      const remaining = s.panes.filter((p) => p.id !== id);
      const nextActive = s.activePaneId === id ? fallback.id : s.activePaneId;
      const withTabs = remaining.map((p) =>
        p.id === fallback.id && p.activeTabId === undefined
          ? { ...p, activeTabId: orphanTabs[orphanTabs.length - 1]?.id }
          : p,
      );
      return { panes: withTabs, activePaneId: nextActive };
    });
    syncCurrentRef(get());
  },
  setActivePane: (id) => {
    set((s) => (s.panes.some((p) => p.id === id) ? { activePaneId: id } : s));
    syncCurrentRef(get());
  },
  setPaneActiveTab: (paneId, tabId) => {
    set((s) => ({
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, activeTabId: tabId } : p)),
    }));
    syncCurrentRef(get());
  },
  moveTabToPane: (tabId, paneId) => {
    if (!get().panes.some((p) => p.id === paneId)) {
      return;
    }
    useTabsStore.getState().moveToPane(tabId, paneId);
    set((s) => {
      const panes = s.panes.map((p) => {
        if (p.id === paneId) {
          return { ...p, activeTabId: tabId };
        }
        if (p.activeTabId === tabId) {
          const sibling = useTabsStore.getState().tabs.find((tab) => tab.paneId === p.id && tab.id !== tabId);
          return { ...p, activeTabId: sibling?.id };
        }
        return p;
      });
      return { panes, activePaneId: paneId };
    });
    syncCurrentRef(get());
  },
}));
