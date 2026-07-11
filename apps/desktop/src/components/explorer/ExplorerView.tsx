import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { invoke } from '@tauri-apps/api/core';
import { Folder, FolderOpen, FolderPlus, FolderTree, HardDrive, House, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Switch, cx } from '@graphite/ui';
import { REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useExplorerStore } from '../../stores/explorerStore';
import { useUiStore } from '../../stores/uiStore';
import { ExplorerPane } from './ExplorerPane';
import { SavedPathsBar } from './SavedPathsBar';
import { fsAvailable, fsRoots } from './fsApi';
import type { FsRoot } from './fsApi';

const DD_CONTENT =
  'z-50 max-h-[70vh] min-w-56 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop overflow-y-auto rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';

const ROOT_ICON: Record<FsRoot['kind'], LucideIcon> = {
  drive: HardDrive,
  home: House,
  folder: Folder,
};

function AddPaneMenu() {
  const openFolderPane = useExplorerStore((s) => s.openFolderPane);
  const pushToast = useUiStore((s) => s.pushToast);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadRoots = () => {
    if (loaded || !fsAvailable()) {
      return;
    }
    fsRoots().then(
      (result) => {
        setRoots(result);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  };

  const pickFolder = async () => {
    try {
      const selected = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Открыть папку' },
      });
      if (typeof selected === 'string' && selected.length > 0) {
        openFolderPane(selected);
      }
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось выбрать папку' });
    }
  };

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) {
          loadRoots();
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button variant="primary" size="sm">
          <Plus size={14} strokeWidth={2} />
          Панель
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={DD_CONTENT}>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void pickFolder()}>
            <FolderOpen size={15} strokeWidth={1.75} className="text-text-2" />
            <span className="flex-1">Выбрать папку…</span>
          </DropdownMenu.Item>
          {roots.length > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-stroke-0" /> : null}
          {roots.map((root) => {
            const Icon = ROOT_ICON[root.kind];
            return (
              <DropdownMenu.Item
                key={root.path}
                className={MENU_ITEM}
                onSelect={() => openFolderPane(root.path)}
              >
                <Icon size={15} strokeWidth={1.75} className="text-text-2" />
                <span className="flex-1 truncate">{root.name}</span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function EmptyState() {
  const openFolderPane = useExplorerStore((s) => s.openFolderPane);
  const pushToast = useUiStore((s) => s.pushToast);

  const pickFolder = async () => {
    try {
      const selected = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Открыть папку' },
      });
      if (typeof selected === 'string' && selected.length > 0) {
        openFolderPane(selected);
      }
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось выбрать папку' });
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-l border border-stroke-0 bg-bg-1 text-text-3">
        <FolderTree size={26} strokeWidth={1.5} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-text-0">Ни одной открытой папки</h2>
        <p className="max-w-sm text-ui leading-relaxed text-text-2">
          Откройте папку в панели — можно листать файлы, заходить внутрь и смотреть их прямо здесь.
          Часто нужные папки сохраняйте в закладки.
        </p>
      </div>
      <Button variant="primary" onClick={() => void pickFolder()}>
        <FolderPlus size={15} strokeWidth={1.75} />
        Открыть папку
      </Button>
    </div>
  );
}

export function ExplorerView() {
  const panes = useExplorerStore((s) => s.panes);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const toggleHidden = useExplorerStore((s) => s.toggleHidden);
  const reduced = usePrefersReducedMotion();

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-0">
      <div className="flex shrink-0 items-center gap-3 border-b border-stroke-0 px-3 py-2">
        <div className="flex items-center gap-2 text-text-1">
          <FolderTree size={16} strokeWidth={1.75} className="text-accent" />
          <span className="text-ui font-medium text-text-0">Проводник</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-caption text-text-2">
            Скрытые файлы
            <Switch checked={showHidden} onCheckedChange={toggleHidden} aria-label="Показывать скрытые файлы" />
          </label>
          <AddPaneMenu />
        </div>
      </div>

      <SavedPathsBar />

      {panes.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div
            className="grid min-h-full gap-3 p-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gridAutoRows: 'minmax(360px, 1fr)' }}
          >
            <AnimatePresence initial={false}>
              {panes.map((pane) => (
                <motion.div
                  key={pane.id}
                  layout={reduced ? undefined : 'position'}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                  transition={reduced ? REDUCED_CROSSFADE : springSnappy}
                  className={cx('min-h-0 min-w-0')}
                >
                  <ExplorerPane pane={pane} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}
    </main>
  );
}
