import { FileText, Search, Settings, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
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
          active ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
        )}
      >
        {active ? (
          <span
            aria-hidden
            className="absolute -left-1.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent"
          />
        ) : null}
        <Icon size={18} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}

export function Rail() {
  const railView = useUiStore((s) => s.railView);
  const setRailView = useUiStore((s) => s.setRailView);
  return (
    <nav
      aria-label="Разделы"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stroke-0 bg-bg-1 py-2"
    >
      {MAIN_ITEMS.map((item) => (
        <RailButton key={item.view} item={item} active={railView === item.view} onSelect={setRailView} />
      ))}
      <div className="flex-1" />
      <RailButton item={SETTINGS_ITEM} active={railView === SETTINGS_ITEM.view} onSelect={setRailView} />
    </nav>
  );
}
