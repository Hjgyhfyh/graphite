import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, HardDrive, X } from 'lucide-react';
import { Button, MOTION, TooltipProvider, cx } from '@graphite/ui';
import { commands, GRAPHITE_EVENT, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type {
  IndexProgressEvent,
  NoteChangedEvent,
  NoteRef,
  UiFlashNoteEvent,
  UiOpenNoteEvent,
} from '@graphite/bindings';
import { BriefView } from '../components/brief/BriefView';
import { ExplorerView } from '../components/explorer/ExplorerView';
import { CommandPalette } from '../components/palette/CommandPalette';
import { QuickSwitcher } from '../components/palette/QuickSwitcher';
import { FloatingCapture } from '../components/capture/FloatingCapture';
import { GraphView } from '../components/graph/GraphView';
import { JournalView } from '../components/journal/JournalView';
import { KanbanView } from '../components/kanban/KanbanView';
import { Onboarding } from '../components/onboarding/Onboarding';
import { Rail } from '../components/rail/Rail';
import { RightPanel } from '../components/right/RightPanel';
import { SearchPanel } from '../components/search/SearchPanel';
import { SettingsView } from '../components/settings/SettingsView';
import { SplitView } from '../components/panes/SplitView';
import { StatusBar } from '../components/statusbar/StatusBar';
import { TagsView } from '../components/tags/TagsView';
import { TasksView } from '../components/tasks/TasksView';
import { TemplatePicker } from '../components/templates/TemplatePicker';
import { TreePanel } from '../components/tree/TreePanel';
import { TimelineOverlay } from '../components/backup/TimelineOverlay';
import { PromptHistoryOverlay } from '../components/brief/PromptHistoryOverlay';
import { UpdateBanner } from '../components/updater/UpdateBanner';
import { Keymap, useActionHandler } from './Keymap';
import {
  AppLaunch,
  AppMotionConfig,
  CollapsibleColumn,
  PanelItem,
  PanelStagger,
  REDUCED_CROSSFADE,
  ViewSwap,
  listContainerVariants,
  listItemVariants,
  reducedFadeVariants,
  springSnappy,
  springStandard,
  usePrefersReducedMotion,
} from '../motion';
import { initSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import type { Toast } from '../stores/uiStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { bootstrapVault, pickVaultFolder, switchVault } from '../stores/vaultActions';
import { useVaultStore } from '../stores/vaultStore';
import { useVaultsStore } from '../stores/vaultsStore';

const TOAST_DOT: Record<Toast['kind'], string> = {
  info: 'bg-accent',
  success: 'bg-ok',
  error: 'bg-danger',
};

const TOAST_PROGRESS_S = MOTION.M10.durationsMs.progress / 1000;

async function copyPage(ref: NoteRef): Promise<void> {
  const ui = useUiStore.getState();
  try {
    const response = await commands.bundleCompose({ ref, includeLinked: true });
    await navigator.clipboard.writeText(response.text);
    const title = useVaultStore.getState().tree.find((n) => n.ref === ref)?.title ?? 'Страница для ИИ';
    void commands
      .promptLogAppend({ source: 'copyPage', title, refs: [ref], text: response.text })
      .catch(() => undefined);
    ui.pushToast({ kind: 'success', text: `Скопировано для ИИ · ${response.members.length} файлов` });
  } catch (error) {
    ui.pushToast({ kind: 'error', text: isGraphiteError(error) ? error.message : 'Не удалось скопировать страницу' });
  }
}

function ToastViewport() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const reduced = usePrefersReducedMotion();
  return (
    <div
      role="region"
      aria-label="Уведомления"
      aria-live="polite"
      className="pointer-events-none fixed bottom-10 right-4 z-50 flex w-80 flex-col items-stretch gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            role="status"
            layout={!reduced}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, y: 6, scale: 0.985, transition: { duration: 0.16, ease: 'easeIn' } }
            }
            transition={
              reduced
                ? REDUCED_CROSSFADE
                : { layout: springSnappy, default: springStandard, opacity: { duration: 0.16 } }
            }
            className="pointer-events-auto relative overflow-hidden rounded-m border border-stroke-0 bg-bg-2 shadow-2 inset-shadow-hairline"
          >
            <div className="flex items-start gap-2.5 px-3.5 py-3">
              <span aria-hidden className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', TOAST_DOT[toast.kind])} />
              <div className="min-w-0 flex-1 text-ui text-text-0">{toast.text}</div>
              {toast.action !== undefined ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.run();
                    dismissToast(toast.id);
                  }}
                  className="shrink-0 rounded-xs px-1.5 py-0.5 text-ui text-accent transition-colors duration-[120ms] hover:bg-bg-3"
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Закрыть уведомление"
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 rounded-xs p-0.5 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            </div>
            {reduced ? null : (
              <motion.span
                aria-hidden
                className={cx('absolute inset-x-0 bottom-0 h-0.5 origin-left', TOAST_DOT[toast.kind])}
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: TOAST_PROGRESS_S, ease: 'linear' }}
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function VaultGate() {
  const known = useVaultsStore((s) => s.known);
  const reduced = usePrefersReducedMotion();
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<boolean>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const recent = known.slice(0, 4);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto bg-bg-0 px-6 py-10">
      <div className="flex flex-col items-center gap-2.5 text-center">
        <h1 className="text-[26px] font-semibold tracking-tight text-text-0">Graphite</h1>
        <p className="max-w-sm text-ui leading-relaxed text-text-1">
          Заметки живут обычными markdown-файлами в вашей папке. Выберите её — и поехали.
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <Button variant="primary" disabled={busy} onClick={() => void run(() => pickVaultFolder(true))}>
          Создать хранилище
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run(() => pickVaultFolder(false))}>
          Открыть папку
        </Button>
      </div>
      {recent.length > 0 ? (
        <motion.div
          variants={reduced ? undefined : listContainerVariants}
          initial="initial"
          animate="animate"
          className="flex w-full max-w-md flex-col gap-1.5"
        >
          <span className="px-1 pb-0.5 text-micro uppercase tracking-wide text-text-2">Недавние хранилища</span>
          {recent.map((vault) => (
            <motion.button
              key={vault.path}
              type="button"
              variants={reduced ? reducedFadeVariants : listItemVariants}
              disabled={busy}
              onClick={() => void run(() => switchVault(vault.path))}
              className="group flex items-center gap-3 rounded-m border border-stroke-0 bg-bg-1 px-3.5 py-2.5 text-left transition-colors duration-[120ms] hover:border-stroke-1 hover:bg-bg-2 active:scale-[0.99] disabled:opacity-60"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 text-text-2 transition-colors duration-[120ms] group-hover:border-stroke-1 group-hover:text-accent">
                <HardDrive size={15} strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-text-0">{vault.name}</span>
                <span className="truncate font-mono text-micro text-text-2">{vault.path}</span>
              </span>
              <ChevronRight
                size={15}
                strokeWidth={1.75}
                className="shrink-0 text-text-3 transition-transform duration-[120ms] group-hover:translate-x-0.5 group-hover:text-text-1"
              />
            </motion.button>
          ))}
        </motion.div>
      ) : null}
    </main>
  );
}

function CenterView() {
  const railView = useUiStore((s) => s.railView);
  const vaultReady = useVaultStore((s) => s.info !== undefined);

  let viewKey: string;
  let view: ReactNode;
  if (railView === 'explorer') {
    // Файловый менеджер работает и без открытого хранилища — ветка до гейта vault.
    viewKey = 'explorer';
    view = <ExplorerView />;
  } else if (!vaultReady) {
    viewKey = 'gate';
    view = <VaultGate />;
  } else if (railView === 'settings') {
    viewKey = 'settings';
    view = <SettingsView />;
  } else if (railView === 'tasks') {
    viewKey = 'tasks';
    view = <TasksView />;
  } else if (railView === 'brief') {
    viewKey = 'brief';
    view = <BriefView />;
  } else if (railView === 'plan') {
    viewKey = 'plan';
    view = <KanbanView />;
  } else if (railView === 'graph') {
    viewKey = 'graph';
    view = <GraphView />;
  } else if (railView === 'daily') {
    viewKey = 'daily';
    view = <JournalView />;
  } else if (railView === 'tags') {
    viewKey = 'tags';
    view = <TagsView />;
  } else {
    viewKey = 'notes';
    view = <SplitView />;
  }

  return <ViewSwap viewKey={viewKey}>{view}</ViewSwap>;
}

export function AppShell() {
  const railView = useUiStore((s) => s.railView);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const treeWidth = useUiStore((s) => s.treeWidth);
  const setTreeWidth = useUiStore((s) => s.setTreeWidth);
  const rightWidth = useUiStore((s) => s.rightWidth);
  const setRightWidth = useUiStore((s) => s.setRightWidth);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelTab = useUiStore((s) => s.rightPanelTab);

  useActionHandler('note.delete', () => {
    const ref = useVaultStore.getState().currentRef;
    if (ref !== undefined) {
      void useVaultStore.getState().remove(ref);
    }
  });
  useActionHandler('note.copyPage', () => {
    const ref = useVaultStore.getState().currentRef;
    if (ref !== undefined) {
      void copyPage(ref);
    }
  });

  useEffect(() => {
    void bootstrapVault();
  }, []);

  // Старт всегда в разделе «Проводник» — осознанный оверрайд сохранённого railView.
  useEffect(() => {
    useUiStore.getState().setRailView('explorer');
  }, []);

  useEffect(() => initSyncStore(), []);

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
      listen<UiFlashNoteEvent>(GRAPHITE_EVENT.uiFlashNote, (event) => {
        useVaultStore.getState().flashNote(event.payload.ref);
      }),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    const timer = window.setTimeout(() => {
      void useUpdaterStore.getState().check(false);
    }, 2500);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  const showSidebar = !sidebarHidden && (railView === 'tree' || railView === 'search');

  return (
    <AppMotionConfig>
      <TooltipProvider>
        <AppLaunch className="flex h-dvh flex-col overflow-hidden bg-bg-0 text-text-0">
          <PanelStagger className="flex min-h-0 min-w-0 flex-1">
            <PanelItem className="flex shrink-0">
              <Rail />
            </PanelItem>
            <PanelItem className="flex min-h-0 shrink-0">
              <CollapsibleColumn open={showSidebar} width={treeWidth} className="relative h-full shrink-0">
                {railView === 'search' ? (
                  <SearchPanel width={treeWidth} onWidthChange={setTreeWidth} />
                ) : (
                  <TreePanel width={treeWidth} onWidthChange={setTreeWidth} />
                )}
              </CollapsibleColumn>
            </PanelItem>
            <PanelItem className="flex min-h-0 min-w-0 flex-1">
              <CenterView />
            </PanelItem>
            <PanelItem className="flex min-h-0 shrink-0">
              <CollapsibleColumn
                open={rightPanelOpen && railView !== 'explorer'}
                width={rightWidth}
                className="relative h-full shrink-0"
              >
                <RightPanel tab={rightPanelTab} width={rightWidth} onWidthChange={setRightWidth} />
              </CollapsibleColumn>
            </PanelItem>
          </PanelStagger>
          <StatusBar />
        </AppLaunch>
        <CommandPalette />
        <QuickSwitcher />
        <TemplatePicker />
        <FloatingCapture />
        <Keymap />
        <ToastViewport />
        <UpdateBanner />
        <TimelineOverlay />
        <PromptHistoryOverlay />
        <Onboarding />
      </TooltipProvider>
    </AppMotionConfig>
  );
}
