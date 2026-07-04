import type { PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import { cx } from '@graphite/ui';
import type { NoteRef, Status } from '@graphite/bindings';
import { KanbanCard } from './KanbanCard';
import type { ColumnDef, KanbanCardData } from './columns';

export interface KanbanColumnProps {
  column: ColumnDef;
  cards: KanbanCardData[];
  reduced: boolean;
  draggingRef: NoteRef | null;
  settlingRef: NoteRef | null;
  isOver: boolean;
  registerColumn(status: Status, el: HTMLElement | null): void;
  registerCard(ref: NoteRef, el: HTMLElement): void;
  unregisterCard(ref: NoteRef, el: HTMLElement): void;
  onCardLift(event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]): void;
  onCardOpen(ref: NoteRef): void;
  consumeDropClick(): boolean;
}

export function KanbanColumn({
  column,
  cards,
  reduced,
  draggingRef,
  settlingRef,
  isOver,
  registerColumn,
  registerCard,
  unregisterCard,
  onCardLift,
  onCardOpen,
  consumeDropClick,
}: KanbanColumnProps) {
  const Icon = column.icon;

  return (
    <section
      ref={(el) => {
        registerColumn(column.status, el);
      }}
      aria-label={column.label}
      className={cx(
        'flex h-full min-h-0 min-w-60 flex-1 flex-col rounded-l border transition-colors duration-150',
        isOver ? 'border-accent/40 bg-bg-1/60' : 'border-transparent',
      )}
    >
      <header className="flex items-center gap-2 px-2.5 py-2.5">
        <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full', column.tintClass)}>
          <Icon size={13} strokeWidth={1.75} className={column.iconClass} aria-hidden />
        </span>
        <span className="text-caption font-medium text-text-1">{column.label}</span>
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
    </section>
  );
}
