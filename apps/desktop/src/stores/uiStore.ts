import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NoteRef } from '@graphite/bindings';
import type { Theme } from '../theme';
import { applyTheme, isTheme } from '../theme';
import { todayYmd } from '../lib/dailyDoc';
import type { CaptureDest } from '../lib/quickCapture';

export const TREE_WIDTH_MIN = 240;
export const TREE_WIDTH_MAX = 420;
export const TREE_WIDTH_DEFAULT = 280;

export const RIGHT_WIDTH_MIN = 280;
export const RIGHT_WIDTH_MAX = 460;
export const RIGHT_WIDTH_DEFAULT = 300;

export const ANIMATION_SPEED_MIN = 0.5;
export const ANIMATION_SPEED_MAX = 1.6;
export const ANIMATION_SPEED_DEFAULT = 1;

export const EDITOR_SCALE_MIN = 0.85;
export const EDITOR_SCALE_MAX = 1.3;
export const EDITOR_SCALE_DEFAULT = 1;
export const EDITOR_SCALE_STEP = 0.05;

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
  focusMode: boolean;
  typewriter: boolean;
  editorScale: number;
  pendingSearch: string | undefined;
  journalDate: string | undefined;
  pendingTreeReveal: string | undefined;
  pendingGraphFocus: NoteRef | undefined;
  pendingTreeFilter: boolean;
  pendingBoardFilter: boolean;
  pendingTag: string | undefined;
  floatingCaptureOpen: boolean;
  captureDest: CaptureDest;
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
  toggleFocusMode(): void;
  setFocusMode(on: boolean): void;
  setTypewriter(on: boolean): void;
  setEditorScale(scale: number): void;
  nudgeEditorScale(delta: number): void;
  resetEditorScale(): void;
  openSearchWith(query: string): void;
  consumePendingSearch(): string | undefined;
  openJournalDay(date?: string): void;
  consumeJournalDate(): string | undefined;
  requestTreeReveal(id: string): void;
  consumeTreeReveal(): string | undefined;
  focusTreeFilter(): void;
  consumeTreeFilterFocus(): boolean;
  focusBoardFilter(): void;
  consumeBoardFilterFocus(): boolean;
  openTag(tag: string): void;
  consumePendingTag(): string | undefined;
  revealOnGraph(ref: NoteRef): void;
  consumeGraphFocus(): NoteRef | undefined;
  setFloatingCaptureOpen(open: boolean): void;
  toggleFloatingCapture(): void;
  setCaptureDest(dest: CaptureDest): void;
  setOnboardingDone(done: boolean): void;
  pushToast(t: Omit<Toast, 'id'>): string;
  dismissToast(id: string): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapEditorScale(value: number): number {
  const snapped = Math.round(value / EDITOR_SCALE_STEP) * EDITOR_SCALE_STEP;
  return clamp(Number(snapped.toFixed(2)), EDITOR_SCALE_MIN, EDITOR_SCALE_MAX);
}

function hydrateNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function isRailItemView(value: unknown): value is RailItemView {
  return typeof value === 'string' && (RAIL_DEFAULT_ORDER as readonly string[]).includes(value);
}

function isRailView(value: unknown): value is RailView {
  return isRailItemView(value) || value === 'settings';
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

const UI_PERSIST_KEY = 'graphite.ui';

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      railView: 'explorer',
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
      focusMode: false,
      typewriter: true,
      editorScale: EDITOR_SCALE_DEFAULT,
      pendingSearch: undefined,
      journalDate: undefined,
      pendingTreeReveal: undefined,
      pendingGraphFocus: undefined,
      pendingTreeFilter: false,
      pendingBoardFilter: false,
      pendingTag: undefined,
      floatingCaptureOpen: false,
      captureDest: 'inbox',
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
      toggleFocusMode: () => {
        set((s) => ({ focusMode: !s.focusMode }));
      },
      setFocusMode: (on) => {
        set({ focusMode: on });
      },
      setTypewriter: (on) => {
        set({ typewriter: on });
      },
      setEditorScale: (scale) => {
        set({ editorScale: snapEditorScale(scale) });
      },
      nudgeEditorScale: (delta) => {
        set((s) => ({ editorScale: snapEditorScale(s.editorScale + delta) }));
      },
      resetEditorScale: () => {
        set({ editorScale: EDITOR_SCALE_DEFAULT });
      },
      openSearchWith: (query) => {
        set({ pendingSearch: query, railView: 'search', sidebarHidden: false, focusMode: false });
      },
      consumePendingSearch: () => {
        const query = get().pendingSearch;
        if (query !== undefined) {
          set({ pendingSearch: undefined });
        }
        return query;
      },
      openJournalDay: (date) => {
        set({
          journalDate: date ?? todayYmd(),
          railView: 'daily',
          focusMode: false,
        });
      },
      consumeJournalDate: () => {
        const date = get().journalDate;
        if (date !== undefined) {
          set({ journalDate: undefined });
        }
        return date;
      },
      requestTreeReveal: (id) => {
        set({
          pendingTreeReveal: id,
          railView: 'tree',
          sidebarHidden: false,
          focusMode: false,
        });
      },
      consumeTreeReveal: () => {
        const id = get().pendingTreeReveal;
        if (id !== undefined) {
          set({ pendingTreeReveal: undefined });
        }
        return id;
      },
      focusTreeFilter: () => {
        set({
          pendingTreeFilter: true,
          railView: 'tree',
          sidebarHidden: false,
          focusMode: false,
        });
      },
      consumeTreeFilterFocus: () => {
        if (!get().pendingTreeFilter) {
          return false;
        }
        set({ pendingTreeFilter: false });
        return true;
      },
      focusBoardFilter: () => {
        set({
          pendingBoardFilter: true,
          railView: 'plan',
          focusMode: false,
        });
      },
      consumeBoardFilterFocus: () => {
        if (!get().pendingBoardFilter) {
          return false;
        }
        set({ pendingBoardFilter: false });
        return true;
      },
      openTag: (tag) => {
        const name = tag.trim().replace(/^#+/, '');
        if (name.length === 0) {
          return;
        }
        set({
          pendingTag: name,
          railView: 'tags',
          sidebarHidden: false,
          focusMode: false,
        });
      },
      consumePendingTag: () => {
        const tag = get().pendingTag;
        if (tag !== undefined) {
          set({ pendingTag: undefined });
        }
        return tag;
      },
      revealOnGraph: (ref) => {
        set({
          pendingGraphFocus: ref,
          railView: 'graph',
          focusMode: false,
        });
      },
      consumeGraphFocus: () => {
        const ref = get().pendingGraphFocus;
        if (ref !== undefined) {
          set({ pendingGraphFocus: undefined });
        }
        return ref;
      },
      setFloatingCaptureOpen: (open) => {
        set({ floatingCaptureOpen: open });
      },
      toggleFloatingCapture: () => {
        set((s) => ({ floatingCaptureOpen: !s.floatingCaptureOpen }));
      },
      setCaptureDest: (dest) => {
        set({ captureDest: dest });
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
      name: UI_PERSIST_KEY,
      partialize: (s) => ({
        railView: s.railView,
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
        focusMode: s.focusMode,
        typewriter: s.typewriter,
        editorScale: s.editorScale,
        captureDest: s.captureDest,
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
          editorScale: hydrateNumber(saved.editorScale, EDITOR_SCALE_MIN, EDITOR_SCALE_MAX, EDITOR_SCALE_DEFAULT),
          captureDest: saved.captureDest === 'journal' ? 'journal' : 'inbox',
          theme: isTheme(saved.theme) ? saved.theme : 'default',
          focusMode: saved.focusMode === true,
          typewriter: saved.typewriter !== false,
          railView: isRailView(saved.railView) ? saved.railView : current.railView,
          ...normalizeRailOrder(saved.railOrder, saved.railHidden),
        };
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== UI_PERSIST_KEY || event.newValue == null) {
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue) as { state?: { captureDest?: unknown } };
      const dest = parsed.state?.captureDest;
      if (dest === 'inbox' || dest === 'journal') {
        useUiStore.setState({ captureDest: dest });
      }
    } catch {
      /* битый persist — оставляем текущее */
    }
  });
}
