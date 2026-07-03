import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import { TooltipProvider, cx } from '@graphite/ui';
import { GRAPHITE_EVENT, isTauriAvailable } from '@graphite/bindings';
import type { IndexProgressEvent, NoteChangedEvent, UiOpenNoteEvent } from '@graphite/bindings';
import { CommandPalette } from '../components/palette/CommandPalette';
import { EditorPane, WELCOME_NOTE_REF } from '../components/editor/EditorPane';
import { Rail } from '../components/rail/Rail';
import { RightPanel } from '../components/right/RightPanel';
import { StatusBar } from '../components/statusbar/StatusBar';
import { TabBar } from '../components/tabs/TabBar';
import { TreePanel } from '../components/tree/TreePanel';
import { useTabsStore } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';
import type { Toast } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';

const TOAST_DOT: Record<Toast['kind'], string> = {
  info: 'bg-accent',
  success: 'bg-ok',
  error: 'bg-danger',
};

function ToastViewport() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div
      role="region"
      aria-label="Уведомления"
      aria-live="polite"
      className="pointer-events-none fixed bottom-10 right-4 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="animate-toast-in pointer-events-auto flex items-start gap-2.5 rounded-m border border-stroke-0 bg-bg-2 px-3.5 py-3 shadow-2"
        >
          <span aria-hidden className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', TOAST_DOT[toast.kind])} />
          <div className="min-w-0 flex-1 text-ui text-text-0">{toast.text}</div>
          <button
            type="button"
            aria-label="Закрыть уведомление"
            onClick={() => dismissToast(toast.id)}
            className="rounded-xs p-0.5 text-text-2 hover:bg-bg-3 hover:text-text-0"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>
  );
}

function EmptyCenter() {
  return <div className="flex flex-1 items-center justify-center text-ui text-text-2">Нет открытых вкладок</div>;
}

export function AppShell() {
  const treeWidth = useUiStore((s) => s.treeWidth);
  const setTreeWidth = useUiStore((s) => s.setTreeWidth);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelTab = useUiStore((s) => s.rightPanelTab);
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activeTab = tabs.find((tab) => tab.id === activeId);

  useEffect(() => {
    useVaultStore.getState().openNote(WELCOME_NOTE_REF);
    void useVaultStore.getState().loadInfo();
    void useVaultStore.getState().loadTree();
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    const subscriptions = [
      listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
        useVaultStore.getState().applyNoteChanged(event.payload);
      }),
      listen<IndexProgressEvent>(GRAPHITE_EVENT.indexProgress, (event) => {
        useVaultStore.getState().setIndexStatus(event.payload);
      }),
      listen<UiOpenNoteEvent>(GRAPHITE_EVENT.uiOpenNote, (event) => {
        useVaultStore.getState().openNote(event.payload.ref);
      }),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        const ui = useUiStore.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
      } else if (key === 'a' && event.shiftKey && !event.altKey) {
        event.preventDefault();
        useUiStore.getState().toggleRightPanel('aiFeed');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-bg-0 text-text-0">
        <div className="flex min-h-0 flex-1">
          <Rail />
          <TreePanel width={treeWidth} onWidthChange={setTreeWidth} />
          <main className="flex min-w-0 flex-1 flex-col bg-bg-0">
            <TabBar />
            {activeTab !== undefined ? (
              <EditorPane key={activeTab.id} tabId={activeTab.id} noteRef={activeTab.noteRef} />
            ) : (
              <EmptyCenter />
            )}
          </main>
          {rightPanelOpen ? <RightPanel tab={rightPanelTab} /> : null}
        </div>
        <StatusBar />
      </div>
      <CommandPalette />
      <ToastViewport />
    </TooltipProvider>
  );
}
