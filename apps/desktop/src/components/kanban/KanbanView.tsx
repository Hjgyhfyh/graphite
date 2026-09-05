import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import { Eye, EyeOff, Search, X } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import type { NoteRef, Status } from '@graphite/bindings';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { vaultKey } from '../../stores/vaultsStore';
import { mergeVisibleOrder, useBoardConfig, useBoardStore } from '../../stores/boardStore';
import { usePrefersReducedMotion } from '../../motion';
import { KanbanColumn } from './KanbanColumn';
import { DragGhost } from './DragGhost';
import { BoardSettings } from './BoardSettings';
import { useKanbanDnd } from './useKanbanDnd';
import { useColumnReorder } from './useColumnReorder';
import { groupByStatus, pipelineStatus, resolveColumns, statusReason, cardMatchesFilter } from './columns';
import type { KanbanCardData, ResolvedColumn } from './columns';
import { filterNeedle } from '../../lib/treeFilter';
import { formatBinding, useKeybindingsStore } from '../../stores/keybindingsStore';

interface OptimisticMove {
  status: Status;
  at: number;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

export function KanbanView() {
  const tree = useVaultStore((s) => s.tree);
  const info = useVaultStore((s) => s.info);
  const openNote = useVaultStore((s) => s.openNote);
  const loadTree = useVaultStore((s) => s.loadTree);
  const pushToast = useUiStore((s) => s.pushToast);
  const setRailView = useUiStore((s) => s.setRailView);
  const reduced = usePrefersReducedMotion();

  const vk = info !== undefined ? vaultKey(info.root) : '';
  const config = useBoardConfig(vk);

  const [optimistic, setOptimistic] = useState<Record<NoteRef, OptimisticMove>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const pendingBoardFilter = useUiStore((s) => s.pendingBoardFilter);
  const filterBinding = useKeybindingsStore((s) => s.bindings['board.filter']);

  useEffect(() => {
    if (useVaultStore.getState().tree.length === 0) {
      void useVaultStore.getState().loadTree();
    }
  }, []);

  useEffect(() => {
    setShowHidden(false);
    setFilter('');
  }, [vk]);

  useEffect(() => {
    if (!pendingBoardFilter) {
      return;
    }
    useUiStore.getState().consumeBoardFilterFocus();
    const frame = requestAnimationFrame(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingBoardFilter]);

  const cards = useMemo<KanbanCardData[]>(() => {
    const list: KanbanCardData[] = [];
    for (const node of tree) {
      const base = pipelineStatus(node);
      if (base === null) {
        continue;
      }
      const move = optimistic[node.ref];
      list.push({
        ...node,
        status: move?.status ?? base,
        sortStamp: move?.at ?? (Date.parse(node.updated) || 0),
        alias: config.cardAliases[node.ref],
      });
    }
    return list;
  }, [tree, optimistic, config.cardAliases]);

  const needle = filterNeedle(filter);
  const visibleCards = useMemo(
    () => (needle.length === 0 ? cards : cards.filter((card) => cardMatchesFilter(card, needle))),
    [cards, needle],
  );

  const byStatus = useMemo(() => groupByStatus(visibleCards), [visibleCards]);

  const columns = useMemo(() => resolveColumns(config, showHidden), [config, showHidden]);

  const hiddenStatuses = useMemo(
    () => config.order.filter((status) => config.columns[status]?.hidden === true),
    [config],
  );
  const hiddenCards = useMemo(
    () => hiddenStatuses.reduce((sum, status) => sum + byStatus[status].length, 0),
    [hiddenStatuses, byStatus],
  );

  const statusByRef = useMemo(() => {
    const map = new Map<NoteRef, Status>();
    for (const card of cards) {
      map.set(card.ref, card.status);
    }
    return map;
  }, [cards]);

  const clearOptimistic = useCallback((ref: NoteRef) => {
    setOptimistic((current) => {
      if (!(ref in current)) {
        return current;
      }
      const next = { ...current };
      delete next[ref];
      return next;
    });
  }, []);

  const move = useCallback(
    async (ref: NoteRef, target: Status) => {
      setOptimistic((prev) => ({ ...prev, [ref]: { status: target, at: Date.now() } }));
      try {
        await commands.setStatus({ ref, status: target });
        await loadTree();
        clearOptimistic(ref);
      } catch (error) {
        clearOptimistic(ref);
        pushToast({ kind: 'error', text: statusReason(error, 'Не удалось сменить статус') });
      }
    },
    [loadTree, clearOptimistic, pushToast],
  );

  const dnd = useKanbanDnd({
    reduced,
    statusOf: (ref) => statusByRef.get(ref) ?? null,
    onDrop: (ref, status) => {
      void move(ref, status);
    },
  });

  const columnEls = useRef(new Map<Status, HTMLElement>());
  const dndRegisterColumn = dnd.registerColumn;
  const registerColumn = useCallback(
    (status: Status, el: HTMLElement | null) => {
      if (el === null) {
        columnEls.current.delete(status);
      } else {
        columnEls.current.set(status, el);
      }
      dndRegisterColumn(status, el);
    },
    [dndRegisterColumn],
  );

  const boardRef = useRef<HTMLElement | null>(null);
  const dndSetBoardEl = dnd.setBoardEl;
  const setBoardEl = useCallback(
    (el: HTMLElement | null) => {
      boardRef.current = el;
      dndSetBoardEl(el);
    },
    [dndSetBoardEl],
  );

  const columnReorder = useColumnReorder({
    boardEl: () => boardRef.current,
    visibleOrder: () => columns.map((column) => column.status),
    columnEl: (status) => columnEls.current.get(status),
    onCommit: (visible) => {
      useBoardStore.getState().reorderColumns(vk, mergeVisibleOrder(config.order, visible));
    },
  });

  const orderedColumns = useMemo<ResolvedColumn[]>(() => {
    if (columnReorder.previewOrder === null) {
      return columns;
    }
    const byStatusMap = new Map(columns.map((column) => [column.status, column]));
    const next: ResolvedColumn[] = [];
    for (const status of columnReorder.previewOrder) {
      const column = byStatusMap.get(status);
      if (column !== undefined) {
        next.push(column);
      }
    }
    return next;
  }, [columns, columnReorder.previewOrder]);

  const liftColumn = columnReorder.liftColumn;
  const handleHeaderLift = useCallback(
    (event: ReactPointerEvent<HTMLElement>, status: Status) => {
      if (vk.length > 0) {
        liftColumn(event, status);
      }
    },
    [vk, liftColumn],
  );

  const handleRename = useCallback(
    (status: Status, label: string) => {
      useBoardStore.getState().renameColumn(vk, status, label);
    },
    [vk],
  );

  const handleAliasChange = useCallback(
    (ref: NoteRef, alias: string) => {
      useBoardStore.getState().setCardAlias(vk, ref, alias);
    },
    [vk],
  );

  const handleOpen = useCallback(
    (ref: NoteRef) => {
      openNote(ref);
      setRailView('tree');
    },
    [openNote, setRailView],
  );

  const hiddenSummary = `${hiddenStatuses.length} ${plural(hiddenStatuses.length, 'скрытая колонка', 'скрытые колонки', 'скрытых колонок')}${
    hiddenCards > 0 ? ` · ${hiddenCards} ${plural(hiddenCards, 'заметка', 'заметки', 'заметок')}` : ''
  }`;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-0">
      <header className="flex items-center justify-between gap-4 px-6 pb-4 pt-6">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-h2 text-text-0">Поток</h1>
          {cards.length > 0 ? (
            <span className="text-caption tabular-nums text-text-3">
              {needle.length > 0 ? `${visibleCards.length} из ${cards.length}` : cards.length}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <label className="flex h-7 w-52 items-center gap-1.5 rounded-s border border-stroke-0 bg-bg-1 px-2 focus-within:border-stroke-1">
            <Search size={13} strokeWidth={1.75} className="shrink-0 text-text-3" aria-hidden />
            <input
              ref={filterRef}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (filter.length > 0) {
                    setFilter('');
                  } else {
                    event.currentTarget.blur();
                  }
                }
              }}
              aria-label={`Фильтр канбана · ${formatBinding(filterBinding)}`}
              placeholder="Фильтр карточек…"
              className="min-w-0 flex-1 bg-transparent text-caption text-text-0 outline-none placeholder:text-text-3"
            />
            {filter.length > 0 ? (
              <button
                type="button"
                aria-label="Сбросить фильтр"
                onClick={() => {
                  setFilter('');
                  filterRef.current?.focus();
                }}
                className="shrink-0 rounded-xs p-0.5 text-text-3 hover:text-text-0"
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            ) : null}
          </label>
          <p className="hidden pr-2 text-caption text-text-2 xl:block">
            Перетащите карточку между колонками, чтобы сменить статус
          </p>
          {hiddenStatuses.length > 0 ? (
            <Tooltip
              content={showHidden ? 'Снова спрятать скрытые колонки' : `${hiddenSummary} — показать временно`}
              side="bottom"
            >
              <button
                type="button"
                aria-pressed={showHidden}
                aria-label={showHidden ? 'Спрятать скрытые колонки' : 'Показать скрытые колонки'}
                onClick={() => setShowHidden((current) => !current)}
                className={cx(
                  'flex h-7 select-none items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors duration-[120ms]',
                  showHidden
                    ? 'border-accent/40 bg-accent/10 text-text-0'
                    : 'border-stroke-0 text-text-2 hover:border-stroke-1 hover:text-text-0',
                )}
              >
                {showHidden ? (
                  <Eye size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <EyeOff size={13} strokeWidth={1.75} aria-hidden />
                )}
                <span className="tabular-nums">{hiddenStatuses.length}</span>
              </button>
            </Tooltip>
          ) : null}
          <BoardSettings vk={vk} config={config} disabled={info === undefined} />
        </div>
      </header>

      <LayoutGroup>
        <div ref={setBoardEl} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6">
          <AnimatePresence initial={false}>
            {orderedColumns.map((column) => (
              <KanbanColumn
                key={column.status}
                column={column}
                cards={byStatus[column.status]}
                reduced={reduced}
                draggingRef={dnd.draggingRef}
                settlingRef={dnd.settlingRef}
                isOver={dnd.overStatus === column.status}
                columnDragging={columnReorder.draggingColumn === column.status}
                filterNeedle={needle}
                emptyHint={needle.length > 0 ? 'Нет совпадений' : undefined}
                registerColumn={registerColumn}
                registerCard={dnd.registerCard}
                unregisterCard={dnd.unregisterCard}
                onCardLift={dnd.liftCard}
                onCardOpen={handleOpen}
                onAliasChange={handleAliasChange}
                onHeaderLift={handleHeaderLift}
                onRename={handleRename}
                consumeDropClick={dnd.consumeDropClick}
              />
            ))}
          </AnimatePresence>
          {orderedColumns.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-caption text-text-3">
              Все колонки скрыты — верните их в настройках доски
            </div>
          ) : null}
        </div>
      </LayoutGroup>

      {dnd.ghost !== null ? (
        <DragGhost key={dnd.ghost.card.ref} ghost={dnd.ghost} reduced={reduced} onApi={dnd.attachGhost} />
      ) : null}
    </main>
  );
}
