import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { EyeOff } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import type { NoteRef, Status } from '@graphite/bindings';
import { REDUCED_CROSSFADE, springSnappy } from '../../motion';
import { COLUMN_LABEL_MAX } from '../../stores/boardStore';
import { KanbanCard } from './KanbanCard';
import type { KanbanCardData, ResolvedColumn } from './columns';

interface ColumnTitleProps {
  column: ResolvedColumn;
  onRename(status: Status, label: string): void;
}

function ColumnTitle({ column, onRename }: ColumnTitleProps) {
  const [editing, setEditing] = useState(false);
  const done = useRef(false);

  const commit = (value: string) => {
    if (done.current) {
      return;
    }
    done.current = true;
    setEditing(false);
    const trimmed = value.trim();
    // Пустое поле и совпадение с дефолтом снимают алиас — колонка возвращает штатную подпись.
    onRename(column.status, trimmed === column.defaultLabel ? '' : trimmed);
  };

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={column.label}
        placeholder={column.defaultLabel}
        maxLength={COLUMN_LABEL_MAX}
        aria-label={`Название колонки «${column.defaultLabel}»`}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => commit(event.currentTarget.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
          } else if (event.key === 'Escape') {
            done.current = true;
            setEditing(false);
          }
        }}
        className="h-5 w-full min-w-0 flex-1 rounded-xs border border-accent/50 bg-bg-1 px-1.5 text-caption font-medium text-text-0 outline-none placeholder:text-text-3"
      />
    );
  }

  return (
    <Tooltip content="Двойной клик — переименовать" delayMs={700}>
      <span
        className="min-w-0 truncate text-caption font-medium text-text-1"
        onDoubleClick={() => {
          done.current = false;
          setEditing(true);
        }}
      >
        {column.label}
      </span>
    </Tooltip>
  );
}

export interface KanbanColumnProps {
  column: ResolvedColumn;
  cards: KanbanCardData[];
  reduced: boolean;
  draggingRef: NoteRef | null;
  settlingRef: NoteRef | null;
  isOver: boolean;
  columnDragging: boolean;
  registerColumn(status: Status, el: HTMLElement | null): void;
  registerCard(ref: NoteRef, el: HTMLElement): void;
  unregisterCard(ref: NoteRef, el: HTMLElement): void;
  onCardLift(event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]): void;
  onCardOpen(ref: NoteRef): void;
  onAliasChange(ref: NoteRef, alias: string): void;
  onHeaderLift(event: ReactPointerEvent<HTMLElement>, status: Status): void;
  onRename(status: Status, label: string): void;
  consumeDropClick(): boolean;
}

export function KanbanColumn({
  column,
  cards,
  reduced,
  draggingRef,
  settlingRef,
  isOver,
  columnDragging,
  registerColumn,
  registerCard,
  unregisterCard,
  onCardLift,
  onCardOpen,
  onAliasChange,
  onHeaderLift,
  onRename,
  consumeDropClick,
}: KanbanColumnProps) {
  const Icon = column.icon;

  return (
    <motion.section
      ref={(el) => {
        registerColumn(column.status, el);
      }}
      layout={!reduced}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      aria-label={column.label}
      className={cx(
        'flex h-full min-h-0 min-w-60 flex-1 flex-col rounded-l border transition-colors duration-150',
        isOver
          ? 'border-accent/40 bg-bg-1/60'
          : columnDragging
            ? 'z-10 border-stroke-1 bg-bg-1/70 shadow-2'
            : column.hidden
              ? 'border-dashed border-stroke-0'
              : 'border-transparent',
      )}
    >
      <header
        onPointerDown={(event) => onHeaderLift(event, column.status)}
        className={cx(
          'flex select-none items-center gap-2 px-2.5 py-2.5 touch-none',
          columnDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <span
          className={cx('flex size-5 shrink-0 items-center justify-center rounded-full', column.tintClass)}
          style={column.tintStyle}
        >
          <Icon size={13} strokeWidth={1.75} className={column.iconClass} style={column.iconStyle} aria-hidden />
        </span>
        <ColumnTitle column={column} onRename={onRename} />
        {column.hidden ? (
          <Tooltip content="Колонка скрыта — показана временно">
            <EyeOff size={12} strokeWidth={1.75} className="shrink-0 text-text-3" />
          </Tooltip>
        ) : null}
        <span className="ml-auto rounded-full bg-bg-2 px-1.5 py-0.5 text-micro text-text-3 tabular-nums">
          {cards.length}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <AnimatePresence initial={false}>
          {cards.map((card) => (
            <KanbanCard
              key={card.ref}
              card={card}
              reduced={reduced}
              dragging={draggingRef === card.ref}
              settling={settlingRef === card.ref}
              onLift={onCardLift}
              onOpen={onCardOpen}
              onAliasChange={onAliasChange}
              consumeDropClick={consumeDropClick}
              registerCard={registerCard}
              unregisterCard={unregisterCard}
            />
          ))}
        </AnimatePresence>

        {cards.length === 0 ? (
          <div
            className={cx(
              'flex flex-1 items-center justify-center rounded-m border border-dashed px-3 py-8 text-center text-micro transition-colors duration-150',
              isOver ? 'border-accent/50 text-text-2' : 'border-stroke-0 text-text-3',
            )}
          >
            {isOver ? 'Отпустите здесь' : column.hint}
          </div>
        ) : null}
      </div>
    </motion.section>
  );
}
