import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Reorder, useDragControls } from 'motion/react';
import { EyeOff, GripVertical, RotateCcw, Settings2 } from 'lucide-react';
import { Button, Switch, Tooltip, cx } from '@graphite/ui';
import type { Status } from '@graphite/bindings';
import { REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import { COLUMN_LABEL_MAX, isDefaultBoardConfig, useBoardStore } from '../../stores/boardStore';
import type { BoardConfig } from '../../stores/boardStore';
import { IconPicker } from '../tree/IconPicker';
import { resolveColumn } from './columns';

interface ColumnRowProps {
  vk: string;
  status: Status;
  config: BoardConfig;
  reduced: boolean;
}

function ColumnRow({ vk, status, config, reduced }: ColumnRowProps) {
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const stored = config.columns[status];
  const column = resolveColumn(status, stored);
  const Icon = column.icon;
  const storedLabel = stored?.label ?? '';
  const [draft, setDraft] = useState(storedLabel);

  useEffect(() => {
    setDraft(storedLabel);
  }, [storedLabel]);

  const commit = () => {
    const trimmed = draft.trim();
    useBoardStore.getState().renameColumn(vk, status, trimmed === column.defaultLabel ? '' : trimmed);
  };

  return (
    <Reorder.Item
      value={status}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      whileDrag={reduced ? undefined : { scale: 1.02 }}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      className={cx(
        'relative flex select-none items-center gap-2 rounded-m border py-1.5 pl-1 pr-2 transition-[background-color,border-color,box-shadow] duration-[120ms]',
        dragging ? 'z-10 border-stroke-1 bg-bg-3 shadow-2' : 'border-stroke-0 bg-bg-1 hover:border-stroke-1',
      )}
    >
      <button
        type="button"
        aria-label={`Перетащить «${column.label}»`}
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
      <IconPicker
        icon={stored?.icon}
        color={stored?.iconColor}
        onPick={(icon, color) => useBoardStore.getState().setColumnIcon(vk, status, icon, color)}
        side="left"
        align="start"
      >
        <button
          type="button"
          aria-label={`Иконка и цвет колонки «${column.label}»`}
          title="Иконка и цвет"
          className="flex size-7 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 transition-colors duration-[120ms] hover:border-stroke-1"
        >
          <span
            className={cx('flex size-5 items-center justify-center rounded-full', column.tintClass)}
            style={column.tintStyle}
          >
            <Icon size={13} strokeWidth={1.75} className={column.iconClass} style={column.iconStyle} aria-hidden />
          </span>
        </button>
      </IconPicker>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(storedLabel);
          }
        }}
        maxLength={COLUMN_LABEL_MAX}
        placeholder={column.defaultLabel}
        aria-label={`Название колонки «${column.defaultLabel}»`}
        className={cx(
          'h-7 w-full min-w-0 flex-1 rounded-s border border-transparent bg-transparent px-1.5 text-ui outline-none transition-colors duration-[120ms] placeholder:text-text-3 hover:border-stroke-0 focus:border-accent/50 focus:bg-bg-2',
          column.hidden ? 'text-text-3' : 'text-text-0',
        )}
      />
      {column.hidden ? <EyeOff size={12} strokeWidth={1.75} className="shrink-0 text-text-3" aria-hidden /> : null}
      <Switch
        checked={!column.hidden}
        onCheckedChange={() => useBoardStore.getState().toggleColumnHidden(vk, status)}
        aria-label={column.hidden ? `Показать «${column.label}»` : `Скрыть «${column.label}»`}
      />
    </Reorder.Item>
  );
}

export interface BoardSettingsProps {
  vk: string;
  config: BoardConfig;
  disabled?: boolean;
}

export function BoardSettings({ vk, config, disabled = false }: BoardSettingsProps) {
  const [open, setOpen] = useState(false);
  const reduced = usePrefersReducedMotion();
  const isDefault = isDefaultBoardConfig(config);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Настроить доску" side="bottom">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Настроить доску"
            disabled={disabled}
            className={cx(
              'flex size-7 items-center justify-center rounded-s transition-colors duration-[120ms] disabled:pointer-events-none disabled:opacity-45',
              open ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:bg-bg-3 hover:text-text-0',
            )}
          >
            <Settings2 size={15} strokeWidth={1.75} />
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Вложенный пикер иконок портируется в body: для этой панели клик по
            // нему выглядит «снаружи», без защиты панель захлопывается.
            const insidePopper = event.detail.originalEvent
              .composedPath()
              .some((target) => target instanceof Element && target.hasAttribute('data-radix-popper-content-wrapper'));
            if (insidePopper) {
              event.preventDefault();
            }
          }}
          className="z-50 w-[340px] origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-3 shadow-3"
        >
          <header className="flex flex-col pb-2.5">
            <h2 className="text-ui font-medium text-text-0">Настройка доски</h2>
            <p className="text-caption text-text-2">Порядок, подписи, цвет и видимость колонок</p>
          </header>
          <Reorder.Group
            axis="y"
            values={config.order}
            onReorder={(next: Status[]) => useBoardStore.getState().reorderColumns(vk, next)}
            className="flex flex-col gap-1"
          >
            {config.order.map((status) => (
              <ColumnRow key={status} vk={vk} status={status} config={config} reduced={reduced} />
            ))}
          </Reorder.Group>
          <footer className="mt-2.5 flex items-center justify-between gap-3 border-t border-stroke-0 pt-2.5">
            <p className="text-micro text-text-3">Настройки доски хранятся на этом устройстве</p>
            <Tooltip content="Вернуть порядок, подписи и цвета по умолчанию; подписи карточек тоже сбросятся" side="bottom">
              <Button
                variant="ghost"
                size="sm"
                disabled={isDefault}
                onClick={() => useBoardStore.getState().resetBoard(vk)}
              >
                <RotateCcw size={13} strokeWidth={1.75} />
                Сбросить
              </Button>
            </Tooltip>
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
