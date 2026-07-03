import { FileText, ListChecks, PanelLeft, PanelLeftClose, Search, Settings, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Tooltip, cx, springTransition } from '@graphite/ui';
import { useUiStore } from '../../stores/uiStore';
import type { RailView } from '../../stores/uiStore';

interface RailItem {
  view: RailView;
  label: string;
  icon: LucideIcon;
}

const MAIN_ITEMS: readonly RailItem[] = [
  { view: 'tree', label: 'Заметки', icon: FileText },
  { view: 'search', label: 'Поиск', icon: Search },
  { view: 'tasks', label: 'Задачи', icon: ListChecks },
  { view: 'plan', label: 'Канбан — скоро', icon: SquareKanban },
];

const SETTINGS_ITEM: RailItem = { view: 'settings', label: 'Настройки', icon: Settings };

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

export function Rail() {
  const railView = useUiStore((s) => s.railView);
  const setRailView = useUiStore((s) => s.setRailView);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarHidden = useUiStore((s) => s.setSidebarHidden);

  const sidebarView = railView === 'tree' || railView === 'search';
  const sidebarShown = sidebarView && !sidebarHidden;

  const selectView = (view: RailView) => {
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
      <RailButton item={SETTINGS_ITEM} active={railView === SETTINGS_ITEM.view} onSelect={selectView} />
    </nav>
  );
}
