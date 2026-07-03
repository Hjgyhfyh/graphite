import { useEffect, useRef } from 'react';
import type { ActionId } from '../stores/keybindingsStore';
import { useKeybindingsStore } from '../stores/keybindingsStore';
import { usePanesStore } from '../stores/panesStore';
import { useTabsStore } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';

type ActionHandler = () => void;

const handlers = new Map<ActionId, ActionHandler>();

const GLOBAL_ACTIONS = new Set<ActionId>([
  'palette.open',
  'switcher.open',
  'search.global',
  'settings.open',
  'view.tasks',
  'sidebar.toggleTree',
  'sidebar.toggleRight',
  'aiFeed.toggle',
  'tab.next',
  'tab.prev',
  'tab.close',
  'pane.split',
  'pane.close',
  'capture.quick',
  'note.new',
  'note.newChild',
  'note.copyPage',
  'editor.toggleReading',
]);

export function registerActionHandler(id: ActionId, handler: ActionHandler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) {
      handlers.delete(id);
    }
  };
}

export function useActionHandler(id: ActionId, handler: ActionHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const stable: ActionHandler = () => ref.current();
    return registerActionHandler(id, stable);
  }, [id]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target.closest('.cm-editor') !== null;
}

function activePaneTabs() {
  const panes = usePanesStore.getState();
  const paneId = panes.activePaneId;
  const pane = panes.panes.find((p) => p.id === paneId);
  const tabs = useTabsStore
    .getState()
    .tabs.filter((tab) => tab.paneId === paneId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
  return { paneId, activeTabId: pane?.activeTabId, tabs };
}

function cycleTab(direction: 1 | -1): void {
  const { activeTabId, tabs } = activePaneTabs();
  if (tabs.length === 0) {
    return;
  }
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const base = currentIndex === -1 ? 0 : currentIndex;
  const next = (base + direction + tabs.length) % tabs.length;
  useTabsStore.getState().activate(tabs[next].id);
}

function runBuiltin(id: ActionId): boolean {
  const ui = useUiStore.getState();
  switch (id) {
    case 'palette.open':
      ui.setPaletteOpen(!ui.paletteOpen);
      return true;
    case 'switcher.open':
      ui.setQuickSwitcherOpen(true);
      return true;
    case 'search.global':
      ui.setRailView('search');
      ui.setSidebarHidden(false);
      return true;
    case 'view.tasks':
      ui.setRailView('tasks');
      ui.setSidebarHidden(false);
      return true;
    case 'settings.open':
      ui.setRailView('settings');
      ui.setSidebarHidden(false);
      return true;
    case 'sidebar.toggleTree':
      ui.toggleSidebar();
      return true;
    case 'sidebar.toggleRight':
      ui.toggleRightPanel();
      return true;
    case 'aiFeed.toggle':
      ui.toggleRightPanel('aiFeed');
      return true;
    case 'editor.toggleReading':
      ui.toggleReadingMode();
      return true;
    case 'capture.quick':
      ui.setFloatingCaptureOpen(true);
      return true;
    case 'note.new':
      void useVaultStore.getState().createNote();
      return true;
    case 'note.newChild':
      void useVaultStore.getState().createNote({ parent: useVaultStore.getState().currentRef });
      return true;
    case 'note.pin': {
      const ref = useVaultStore.getState().currentRef;
      if (ref !== undefined) {
        void useVaultStore.getState().togglePinNote(ref);
      }
      return true;
    }
    case 'tab.next':
      cycleTab(1);
      return true;
    case 'tab.prev':
      cycleTab(-1);
      return true;
    case 'tab.close': {
      const { activeTabId } = activePaneTabs();
      if (activeTabId !== undefined) {
        useTabsStore.getState().close(activeTabId);
      }
      return true;
    }
    case 'tab.togglePin': {
      const { activeTabId } = activePaneTabs();
      if (activeTabId !== undefined) {
        useTabsStore.getState().togglePin(activeTabId);
      }
      return true;
    }
    case 'pane.split':
      usePanesStore.getState().addPane();
      return true;
    case 'pane.close':
      usePanesStore.getState().removePane(usePanesStore.getState().activePaneId);
      return true;
    default:
      return false;
  }
}

export function runAction(id: ActionId): boolean {
  const handler = handlers.get(id);
  if (handler !== undefined) {
    handler();
    return true;
  }
  return runBuiltin(id);
}

export function Keymap() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = useKeybindingsStore.getState().matchEvent(event);
      if (id === null) {
        return;
      }
      if (isEditableTarget(event.target) && !GLOBAL_ACTIONS.has(id)) {
        return;
      }
      if (runAction(id)) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return null;
}
