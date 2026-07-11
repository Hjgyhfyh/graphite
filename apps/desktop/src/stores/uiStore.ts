import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '../theme';
import { applyTheme, isTheme } from '../theme';

export const TREE_WIDTH_MIN = 240;
export const TREE_WIDTH_MAX = 420;
export const TREE_WIDTH_DEFAULT = 280;

export const RIGHT_WIDTH_MIN = 280;
export const RIGHT_WIDTH_MAX = 460;
export const RIGHT_WIDTH_DEFAULT = 300;

export const ANIMATION_SPEED_MIN = 0.5;
export const ANIMATION_SPEED_MAX = 1.6;
export const ANIMATION_SPEED_DEFAULT = 1;

const TOAST_DURATION_MS = 4000;

export type RailView =
  | 'explorer'
  | 'tree'
  | 'search'
  | 'tasks'
  | 'brief'
  | 'plan'
  | 'graph'
  | 'daily'
  | 'tags'
  | 'settings';
export type RailItemView = Exclude<RailView, 'settings'>;
export type RightPanelTab = 'properties' | 'aiFeed' | 'links' | 'backlinks' | 'outline';

// Дефолтный порядок настраиваемых разделов рейки; кнопка настроек в него не входит —
// её нельзя скрыть или переместить.
export const RAIL_DEFAULT_ORDER: readonly RailItemView[] = [
  'explorer',
  'tree',
  'search',
  'tasks',
  'brief',
  'plan',
  'graph',
  'daily',
  'tags',
];

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: ToastAction;
}

export interface UiStore {
  railView: RailView;
  railOrder: RailItemView[];
  railHidden: RailItemView[];
  sidebarHidden: boolean;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  treeWidth: number;
  rightWidth: number;
  paletteOpen: boolean;
  quickSwitcherOpen: boolean;
  readingMode: boolean;
  showPropsInText: boolean;
  reducedMotion: boolean;
  animationSpeed: number;
  theme: Theme;
  floatingCaptureOpen: boolean;
  onboardingDone: boolean;
  toasts: Toast[];
  setRailView(v: RailView): void;
  setRailOrder(order: RailItemView[]): void;
  toggleRailItemHidden(view: RailItemView): void;
  resetRailLayout(): void;
  toggleSidebar(): void;
  setSidebarHidden(hidden: boolean): void;
  toggleRightPanel(tab?: RightPanelTab): void;
  openRightPanel(tab: RightPanelTab): void;
  setRightPanelTab(tab: RightPanelTab): void;
  setTreeWidth(w: number): void;
  setRightWidth(w: number): void;
  setPaletteOpen(open: boolean): void;
  setQuickSwitcherOpen(open: boolean): void;
  toggleReadingMode(): void;
  setReadingMode(on: boolean): void;
  setShowPropsInText(on: boolean): void;
  setReducedMotion(on: boolean): void;
  setAnimationSpeed(speed: number): void;
  setTheme(theme: Theme): void;
  setFloatingCaptureOpen(open: boolean): void;
  toggleFloatingCapture(): void;
  setOnboardingDone(done: boolean): void;
  pushToast(t: Omit<Toast, 'id'>): string;
  dismissToast(id: string): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hydrateNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function isRailItemView(value: unknown): value is RailItemView {
  return typeof value === 'string' && (RAIL_DEFAULT_ORDER as readonly string[]).includes(value);
}

// Чинит сохранённую раскладку рейки под текущий набор разделов: неизвестные id
// отбрасываются, дубли схлопываются, недостающие разделы дописываются в конец
// в дефолтном порядке (новые view будущих версий появляются видимыми).
export function normalizeRailOrder(
  order: unknown,
  hidden: unknown,
): { railOrder: RailItemView[]; railHidden: RailItemView[] } {
  const railOrder: RailItemView[] = [];
  if (Array.isArray(order)) {
    for (const id of order) {
      if (isRailItemView(id) && !railOrder.includes(id)) {
        railOrder.push(id);
      }
    }
  }
  for (const id of RAIL_DEFAULT_ORDER) {
    if (!railOrder.includes(id)) {
      railOrder.push(id);
    }
  }
  const railHidden: RailItemView[] = [];
  if (Array.isArray(hidden)) {
    for (const id of hidden) {
      if (isRailItemView(id) && !railHidden.includes(id)) {
        railHidden.push(id);
      }
    }
  }
  return { railOrder, railHidden };
}

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      railView: 'tree',
      railOrder: [...RAIL_DEFAULT_ORDER],
      railHidden: [],
      sidebarHidden: false,
      rightPanelOpen: true,
      rightPanelTab: 'properties',
      treeWidth: TREE_WIDTH_DEFAULT,
      rightWidth: RIGHT_WIDTH_DEFAULT,
      paletteOpen: false,
      quickSwitcherOpen: false,
      readingMode: false,
      showPropsInText: false,
      reducedMotion: false,
      animationSpeed: ANIMATION_SPEED_DEFAULT,
      theme: 'default',
      floatingCaptureOpen: false,
      onboardingDone: false,
      toasts: [],
      setRailView: (v) => {
        set({ railView: v });
      },
      setRailOrder: (order) => {
        set((s) => normalizeRailOrder(order, s.railHidden));
      },
      toggleRailItemHidden: (view) => {
        set((s) => ({
          railHidden: s.railHidden.includes(view)
            ? s.railHidden.filter((v) => v !== view)
            : [...s.railHidden, view],
        }));
      },
      resetRailLayout: () => {
        set({ railOrder: [...RAIL_DEFAULT_ORDER], railHidden: [] });
      },
      toggleSidebar: () => {
        set((s) => ({ sidebarHidden: !s.sidebarHidden }));
      },
      setSidebarHidden: (hidden) => {
        set({ sidebarHidden: hidden });
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
      openRightPanel: (tab) => {
        set({ rightPanelOpen: true, rightPanelTab: tab });
      },
      setRightPanelTab: (tab) => {
        set({ rightPanelTab: tab });
      },
      setTreeWidth: (w) => {
        set({ treeWidth: clamp(Math.round(w), TREE_WIDTH_MIN, TREE_WIDTH_MAX) });
      },
      setRightWidth: (w) => {
        set({ rightWidth: clamp(Math.round(w), RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX) });
      },
      setPaletteOpen: (open) => {
        set({ paletteOpen: open });
      },
      setQuickSwitcherOpen: (open) => {
        set({ quickSwitcherOpen: open });
      },
      toggleReadingMode: () => {
        set((s) => ({ readingMode: !s.readingMode }));
      },
      setReadingMode: (on) => {
        set({ readingMode: on });
      },
      setShowPropsInText: (on) => {
        set({ showPropsInText: on });
      },
      setReducedMotion: (on) => {
        set({ reducedMotion: on });
      },
      setAnimationSpeed: (speed) => {
        set({ animationSpeed: clamp(speed, ANIMATION_SPEED_MIN, ANIMATION_SPEED_MAX) });
      },
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setFloatingCaptureOpen: (open) => {
        set({ floatingCaptureOpen: open });
      },
      toggleFloatingCapture: () => {
        set((s) => ({ floatingCaptureOpen: !s.floatingCaptureOpen }));
      },
      setOnboardingDone: (done) => {
        set({ onboardingDone: done });
      },
      pushToast: (t) => {
        const id = crypto.randomUUID();
        set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
        window.setTimeout(() => {
          get().dismissToast(id);
        }, TOAST_DURATION_MS);
        return id;
      },
      dismissToast: (id) => {
        set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
      },
    }),
    {
      name: 'graphite.ui',
      partialize: (s) => ({
        railOrder: s.railOrder,
        railHidden: s.railHidden,
        sidebarHidden: s.sidebarHidden,
        rightPanelOpen: s.rightPanelOpen,
        rightPanelTab: s.rightPanelTab,
        treeWidth: s.treeWidth,
        rightWidth: s.rightWidth,
        readingMode: s.readingMode,
        showPropsInText: s.showPropsInText,
        reducedMotion: s.reducedMotion,
        animationSpeed: s.animationSpeed,
        theme: s.theme,
        onboardingDone: s.onboardingDone,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UiStore>;
        return {
          ...current,
          ...saved,
          treeWidth: hydrateNumber(saved.treeWidth, TREE_WIDTH_MIN, TREE_WIDTH_MAX, TREE_WIDTH_DEFAULT),
          rightWidth: hydrateNumber(saved.rightWidth, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX, RIGHT_WIDTH_DEFAULT),
          animationSpeed: hydrateNumber(
            saved.animationSpeed,
            ANIMATION_SPEED_MIN,
            ANIMATION_SPEED_MAX,
            ANIMATION_SPEED_DEFAULT,
          ),
          theme: isTheme(saved.theme) ? saved.theme : 'default',
          ...normalizeRailOrder(saved.railOrder, saved.railHidden),
        };
      },
    },
  ),
);
