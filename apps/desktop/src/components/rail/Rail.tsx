import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as Popover from '@radix-ui/react-popover';
import {
  CalendarDays,
  Check,
  FileText,
  FolderOpen,
  FolderPlus,
  HardDrive,
  ListChecks,
  Loader,
  Network,
  PanelLeft,
  PanelLeftClose,
  Search,
  Settings,
  Sparkles,
  SquareKanban,
  Tag,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, cx, springTransition } from '@graphite/ui';
import {
  listContainerVariants,
  listItemVariants,
  reducedFadeVariants,
  usePrefersReducedMotion,
} from '../../motion';
import { openBriefView } from '../../stores/briefStore';
import { useUiStore } from '../../stores/uiStore';
import type { RailView } from '../../stores/uiStore';
import { forgetVault, pickVaultFolder, switchVault } from '../../stores/vaultActions';
import { useVaultStore } from '../../stores/vaultStore';
import { useVaultsStore, vaultKey, vaultName } from '../../stores/vaultsStore';

interface RailItem {
  view: RailView;
  label: string;
  icon: LucideIcon;
}

const MAIN_ITEMS: readonly RailItem[] = [
  { view: 'tree', label: 'Заметки', icon: FileText },
  { view: 'search', label: 'Поиск', icon: Search },
  { view: 'tasks', label: 'Задачи', icon: ListChecks },
  { view: 'brief', label: 'Бриф для Claude', icon: Sparkles },
  { view: 'plan', label: 'Канбан — скоро', icon: SquareKanban },
  { view: 'graph', label: 'Граф связей', icon: Network },
  { view: 'daily', label: 'Дневник', icon: CalendarDays },
  { view: 'tags', label: 'Теги', icon: Tag },
];

const SETTINGS_ITEM: RailItem = { view: 'settings', label: 'Настройки', icon: Settings };

const VAULT_ACTION_ROW =
  'flex h-8 w-full select-none items-center gap-2 rounded-s px-2 text-left text-ui text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0';

interface RailButtonProps {
  item: RailItem;
  active: boolean;
  onSelect: (view: RailView) => void;
}

function RailButton({ item, active, onSelect }: RailButtonProps) {
  const Icon = item.icon;
  return (
    <Tooltip content={item.label} side="right">
      <button
        type="button"
        aria-label={item.label}
        aria-pressed={active}
        onClick={() => onSelect(item.view)}
        className={cx(
          'relative flex size-9 items-center justify-center rounded-s transition-colors duration-[120ms]',
          active ? 'text-text-0' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
        )}
      >
        {active ? (
          <>
            <motion.span
              aria-hidden
              layoutId="rail-active-pill"
              transition={springTransition('snappy')}
              className="absolute inset-0 rounded-s bg-bg-3"
            />
            <motion.span
              aria-hidden
              layoutId="rail-active-marker"
              transition={springTransition('snappy')}
              style={{ top: 'calc(50% - 8px)' }}
              className="pointer-events-none absolute -left-1.5 h-4 w-[3px] rounded-full bg-accent"
            />
          </>
        ) : null}
        <Icon size={18} strokeWidth={1.75} className="relative" />
      </button>
    </Tooltip>
  );
}

function VaultSwitch() {
  const info = useVaultStore((s) => s.info);
  const known = useVaultsStore((s) => s.known);
  const reduced = usePrefersReducedMotion();
  const [open, setOpen] = useState(false);
  const [switchingPath, setSwitchingPath] = useState<string | undefined>(undefined);

  const busy = switchingPath !== undefined;
  const activeKey = info === undefined ? undefined : vaultKey(info.root);
  const label = info === undefined ? 'Хранилище' : `Хранилище — ${vaultName(info.root)}`;

  const select = async (path: string) => {
    if (busy) {
      return;
    }
    setSwitchingPath(path);
    const ok = await switchVault(path);
    setSwitchingPath(undefined);
    if (ok) {
      setOpen(false);
    }
  };

  const pick = (create: boolean) => {
    setOpen(false);
    void pickVaultFolder(create);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={label} side="right">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cx(
              'relative flex size-9 items-center justify-center rounded-s transition-colors duration-[120ms]',
              open ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
            )}
          >
            <HardDrive size={18} strokeWidth={1.75} />
            {info !== undefined ? (
              <span aria-hidden className="absolute right-[7px] top-[7px] size-1.5 rounded-full bg-ok" />
            ) : null}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={10}
          collisionPadding={8}
          className="z-50 w-72 origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1.5 shadow-3"
        >
          <div className="px-2 pb-1.5 pt-1 text-micro uppercase tracking-wide text-text-2">Хранилища</div>
          {known.length === 0 ? (
            <p className="px-2 pb-2 text-caption text-text-2">
              Откройте папку с заметками — она появится в этом списке.
            </p>
          ) : (
            <motion.div
              variants={reduced ? undefined : listContainerVariants}
              initial="initial"
              animate="animate"
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
            >
              <AnimatePresence initial={false}>
                {known.map((vault) => {
                  const active = activeKey !== undefined && vaultKey(vault.path) === activeKey;
                  return (
                    <motion.div
                      key={vaultKey(vault.path)}
                      layout={!reduced}
                      variants={reduced ? reducedFadeVariants : listItemVariants}
                      exit="exit"
                      className="group relative"
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void select(vault.path)}
                        className={cx(
                          'flex w-full items-center gap-2 rounded-s py-1.5 pl-1.5 pr-8 text-left transition-colors duration-[120ms]',
                          active ? 'bg-bg-3' : 'hover:bg-bg-3',
                        )}
                      >
                        <span
                          className={cx(
                            'flex size-6 shrink-0 items-center justify-center rounded-xs border bg-bg-1 transition-colors duration-[120ms]',
                            active ? 'border-accent/40 text-accent' : 'border-stroke-0 text-text-2',
                          )}
                        >
                          <HardDrive size={13} strokeWidth={1.75} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-ui text-text-0">{vault.name}</span>
                          <span className="truncate font-mono text-micro text-text-3">{vault.path}</span>
                        </span>
                      </button>
                      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
                        {switchingPath === vault.path ? (
                          <Loader
                            size={13}
                            strokeWidth={1.75}
                            className={cx('text-text-2', !reduced && 'animate-spin')}
                          />
                        ) : active ? (
                          <Check size={14} strokeWidth={2} className="text-accent" />
                        ) : (
                          <button
                            type="button"
                            aria-label={`Убрать «${vault.name}» из списка`}
                            onClick={() => forgetVault(vault.path)}
                            className="flex size-5 items-center justify-center rounded-xs text-text-3 opacity-0 transition-[color,opacity,background-color] duration-[120ms] hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 active:scale-90 group-hover:opacity-100"
                          >
                            <X size={13} strokeWidth={1.75} />
                          </button>
                        )}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </motion.div>
          )}
          <div className="mt-1 flex flex-col border-t border-stroke-0 pt-1">
            <button type="button" className={VAULT_ACTION_ROW} onClick={() => pick(false)}>
              <FolderOpen size={14} strokeWidth={1.75} className="shrink-0 text-text-2" />
              Открыть папку…
            </button>
            <button type="button" className={VAULT_ACTION_ROW} onClick={() => pick(true)}>
              <FolderPlus size={14} strokeWidth={1.75} className="shrink-0 text-text-2" />
              Создать хранилище…
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Rail() {
  const railView = useUiStore((s) => s.railView);
  const setRailView = useUiStore((s) => s.setRailView);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarHidden = useUiStore((s) => s.setSidebarHidden);

  const sidebarView = railView === 'tree' || railView === 'search';
  const sidebarShown = sidebarView && !sidebarHidden;

  const selectView = (view: RailView) => {
    if (view === 'brief') {
      openBriefView();
      return;
    }
    setRailView(view);
    if (view === 'tree' || view === 'search') {
      setSidebarHidden(false);
    }
  };

  const onToggleSidebar = () => {
    if (sidebarView) {
      toggleSidebar();
    } else {
      setRailView('tree');
      setSidebarHidden(false);
    }
  };

  return (
    <nav
      aria-label="Разделы"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stroke-0 bg-bg-1 py-2"
    >
      <Tooltip content={sidebarShown ? 'Скрыть панель заметок' : 'Показать панель заметок'} side="right">
        <button
          type="button"
          aria-label={sidebarShown ? 'Скрыть панель заметок' : 'Показать панель заметок'}
          aria-pressed={sidebarShown}
          onClick={onToggleSidebar}
          className="flex size-9 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
        >
          {sidebarShown ? (
            <PanelLeftClose size={18} strokeWidth={1.75} />
          ) : (
            <PanelLeft size={18} strokeWidth={1.75} />
          )}
        </button>
      </Tooltip>
      <span aria-hidden className="my-1 h-px w-5 rounded-full bg-stroke-0" />
      {MAIN_ITEMS.map((item) => (
        <RailButton key={item.view} item={item} active={railView === item.view} onSelect={selectView} />
      ))}
      <div className="flex-1" />
      <VaultSwitch />
      <RailButton item={SETTINGS_ITEM} active={railView === SETTINGS_ITEM.view} onSelect={selectView} />
    </nav>
  );
}
