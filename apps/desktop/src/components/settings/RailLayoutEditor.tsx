import { useState } from 'react';
import { Reorder, useDragControls } from 'motion/react';
import { GripVertical, RotateCcw } from 'lucide-react';
import { Button, Switch, cx } from '@graphite/ui';
import { REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import { RAIL_DEFAULT_ORDER, useUiStore } from '../../stores/uiStore';
import type { RailItemView } from '../../stores/uiStore';
import { RAIL_META } from '../rail/railItems';

interface RailLayoutRowProps {
  view: RailItemView;
  hidden: boolean;
  reduced: boolean;
}

function RailLayoutRow({ view, hidden, reduced }: RailLayoutRowProps) {
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const meta = RAIL_META[view];
  const Icon = meta.icon;

  return (
    <Reorder.Item
      value={view}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      whileDrag={reduced ? undefined : { scale: 1.02 }}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      className={cx(
        'relative flex select-none items-center gap-2.5 rounded-m border py-2 pl-1.5 pr-3 transition-[background-color,border-color,box-shadow] duration-[120ms]',
        dragging ? 'z-10 border-stroke-1 bg-bg-3 shadow-2' : 'border-stroke-0 bg-bg-2 hover:border-stroke-1',
      )}
    >
      <button
        type="button"
        aria-label={`Перетащить «${meta.label}»`}
        onPointerDown={(event) => {
          event.preventDefault();
          controls.start(event);
        }}
        className={cx(
          'flex h-7 w-5 shrink-0 touch-none items-center justify-center rounded-xs text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-1',
          dragging ? 'cursor-grabbing text-text-1' : 'cursor-grab',
        )}
      >
        <GripVertical size={14} strokeWidth={1.75} />
      </button>
      <span
        className={cx(
          'flex size-7 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-1 transition-colors duration-[120ms]',
          hidden ? 'text-text-3' : 'text-text-1',
        )}
      >
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <span
        className={cx(
          'min-w-0 flex-1 truncate text-ui transition-colors duration-[120ms]',
          hidden ? 'text-text-3' : 'text-text-0',
        )}
      >
        {meta.label}
      </span>
      {hidden ? <span className="shrink-0 text-micro uppercase tracking-wide text-text-3">Скрыт</span> : null}
      <Switch
        checked={!hidden}
        onCheckedChange={() => useUiStore.getState().toggleRailItemHidden(view)}
        aria-label={hidden ? `Показать «${meta.label}»` : `Скрыть «${meta.label}»`}
      />
    </Reorder.Item>
  );
}

export function RailLayoutEditor() {
  const railOrder = useUiStore((s) => s.railOrder);
  const railHidden = useUiStore((s) => s.railHidden);
  const reduced = usePrefersReducedMotion();

  const isDefault =
    railHidden.length === 0 &&
    railOrder.length === RAIL_DEFAULT_ORDER.length &&
    railOrder.every((view, index) => view === RAIL_DEFAULT_ORDER[index]);

  return (
    <div className="flex flex-col gap-3">
      <Reorder.Group
        axis="y"
        values={railOrder}
        onReorder={(next) => useUiStore.getState().setRailOrder(next)}
        className="flex flex-col gap-1.5"
      >
        {railOrder.map((view) => (
          <RailLayoutRow key={view} view={view} hidden={railHidden.includes(view)} reduced={reduced} />
        ))}
      </Reorder.Group>
      <div className="flex items-center justify-between gap-4 border-t border-stroke-0 pt-3">
        <p className="text-caption text-text-2">
          Перетащите раздел за ручку, чтобы изменить порядок. Настройки и переключатель панели всегда
          остаются на месте.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={isDefault}
          onClick={() => useUiStore.getState().resetRailLayout()}
        >
          <RotateCcw size={14} strokeWidth={1.75} />
          Сбросить порядок
        </Button>
      </div>
    </div>
  );
}
