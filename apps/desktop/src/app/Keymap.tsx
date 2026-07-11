import { useEffect, useRef } from 'react';
import { exportNoteHtml, exportNoteMarkdown, printNote } from '../lib/exportNote';
import { openBriefView } from '../stores/briefStore';
import { openPromptHistory } from '../stores/promptHistoryStore';
import type { ActionId } from '../stores/keybindingsStore';
import { useKeybindingsStore } from '../stores/keybindingsStore';
import { useNavStore } from '../stores/navStore';
import { usePanesStore } from '../stores/panesStore';
import { useTabsStore } from '../stores/tabsStore';
import { useTemplatePickerStore } from '../stores/templatePickerStore';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';

type ActionHandler = () => void;

const handlers = new Map<ActionId, ActionHandler[]>();

const GLOBAL_ACTIONS = new Set<ActionId>([
  'palette.open',
  'switcher.open',
  'search.global',
  'settings.open',
  'view.tasks',
  'view.brief',
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
  'note.newFromTemplate',
  'note.copyPage',
  'editor.toggleReading',
  'task.sweepDone',
  'view.outline',
]);

export function registerActionHandler(id: ActionId, handler: ActionHandler): () => void {
  const stack = handlers.get(id) ?? [];
  stack.push(handler);
  handlers.set(id, stack);
  return () => {
    const current = handlers.get(id);
    if (current === undefined) {
      return;
    }
    const index = current.lastIndexOf(handler);
    if (index !== -1) {
      current.splice(index, 1);
    }
    if (current.length === 0) {
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

function focusActiveEditor(): boolean {
  const content = document.querySelector<HTMLElement>('.cm-editor .cm-content');
  if (content === null) {
    return false;
  }
  content.focus();
  return true;
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
    case 'view.brief':
      openBriefView();
      return true;
    case 'prompts.history':
      openPromptHistory();
      return true;
    case 'settings.open':
      ui.setRailView('settings');
      ui.setSidebarHidden(false);
      return true;
    case 'nav.back':
      useNavStore.getState().back();
      return true;
    case 'nav.forward':
      useNavStore.getState().forward();
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
    case 'view.outline':
      ui.toggleRightPanel('outline');
      return true;
    case 'editor.toggleReading':
      ui.toggleReadingMode();
      return true;
    case 'search.inNote':
      return focusActiveEditor();
    case 'capture.quick':
      ui.setFloatingCaptureOpen(true);
      return true;
    case 'note.new':
      void useVaultStore.getState().createNote();
      return true;
    case 'note.newChild':
      void useVaultStore.getState().createNote({ parent: useVaultStore.getState().currentRef });
      return true;
    case 'note.newFromTemplate':
      useTemplatePickerStore.getState().openPicker();
      return true;
    case 'note.exportHtml': {
      const ref = useVaultStore.getState().currentRef;
      if (ref === undefined) {
        return false;
      }
      void exportNoteHtml(ref);
      return true;
    }
    case 'note.exportMd': {
      const ref = useVaultStore.getState().currentRef;
      if (ref === undefined) {
        return false;
      }
      void exportNoteMarkdown(ref);
      return true;
    }
    case 'note.print': {
      const ref = useVaultStore.getState().currentRef;
      if (ref === undefined) {
        return false;
      }
      void printNote(ref);
      return true;
    }
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
  const stack = handlers.get(id);
  const handler = stack !== undefined && stack.length > 0 ? stack[stack.length - 1] : undefined;
  if (handler !== undefined) {
    handler();
    return true;
  }
  return runBuiltin(id);
}

export function Keymap() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Клавиша, уже обработанная редактором (CodeMirror ставит preventDefault),
      // не должна вдобавок запускать глобальный экшен.
      if (event.defaultPrevented) {
        return;
      }
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

  useEffect(() => {
    // Боковые кнопки мыши (3 — назад, 4 — вперёд) двигают историю заметок.
    // Жест глобальный: по isEditableTarget не отсекаем — работает и в редакторе.
    const suppress = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        useNavStore.getState().back();
      } else if (event.button === 4) {
        event.preventDefault();
        useNavStore.getState().forward();
      }
    };
    window.addEventListener('pointerdown', suppress, { capture: true });
    window.addEventListener('auxclick', suppress, { capture: true });
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointerdown', suppress, { capture: true });
      window.removeEventListener('auxclick', suppress, { capture: true });
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);
  return null;
}
