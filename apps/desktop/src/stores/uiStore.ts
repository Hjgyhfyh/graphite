import { create } from 'zustand';

export const TREE_WIDTH_MIN = 240;
export const TREE_WIDTH_MAX = 360;
export const TREE_WIDTH_DEFAULT = 280;

const TOAST_DURATION_MS = 4000;

export type RailView = 'tree' | 'search' | 'plan' | 'settings';
export type RightPanelTab = 'properties' | 'aiFeed' | 'links';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UiStore {
  railView: RailView;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  treeWidth: number;
  paletteOpen: boolean;
  toasts: Toast[];
  firstRun: boolean;
  setRailView(v: RailView): void;
  toggleRightPanel(tab?: RightPanelTab): void;
  setTreeWidth(w: number): void;
  setPaletteOpen(open: boolean): void;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  finishFirstRun(): void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
  railView: 'tree',
  rightPanelOpen: true,
  rightPanelTab: 'properties',
  treeWidth: TREE_WIDTH_DEFAULT,
  paletteOpen: false,
  toasts: [],
  firstRun: false,
  setRailView: (v) => {
    set({ railView: v });
  },
  toggleRightPanel: (tab) => {
    set((s) => {
      if (!s.rightPanelOpen) {
        return { rightPanelOpen: true, rightPanelTab: tab ?? s.rightPanelTab };
      }
      if (tab !== undefined && tab !== s.rightPanelTab) {
        return { rightPanelTab: tab };
      }
      return { rightPanelOpen: false };
    });
  },
  setTreeWidth: (w) => {
    set({ treeWidth: Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(w))) });
  },
  setPaletteOpen: (open) => {
    set({ paletteOpen: open });
  },
  pushToast: (t) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => {
      get().dismissToast(id);
    }, TOAST_DURATION_MS);
  },
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
  },
  finishFirstRun: () => {
    set({ firstRun: false });
  },
}));
