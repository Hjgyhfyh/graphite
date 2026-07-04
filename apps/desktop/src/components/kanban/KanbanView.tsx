import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGroup } from 'motion/react';
import { commands } from '@graphite/bindings';
import type { NoteRef, Status } from '@graphite/bindings';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { usePrefersReducedMotion } from '../../motion';
import { KanbanColumn } from './KanbanColumn';
import { DragGhost } from './DragGhost';
import { useKanbanDnd } from './useKanbanDnd';
import { COLUMNS, groupByStatus, pipelineStatus, statusReason } from './columns';
import type { KanbanCardData } from './columns';

interface OptimisticMove {
  status: Status;
  at: number;
}

export function KanbanView() {
  const tree = useVaultStore((s) => s.tree);
  const openNote = useVaultStore((s) => s.openNote);
  const loadTree = useVaultStore((s) => s.loadTree);
  const pushToast = useUiStore((s) => s.pushToast);
  const setRailView = useUiStore((s) => s.setRailView);
  const reduced = usePrefersReducedMotion();

  const [optimistic, setOptimistic] = useState<Record<NoteRef, OptimisticMove>>({});

  useEffect(() => {
    if (useVaultStore.getState().tree.length === 0) {
      void useVaultStore.getState().loadTree();
    }
  }, []);

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
      });
    }
    return list;
  }, [tree, optimistic]);

  const byStatus = useMemo(() => groupByStatus(cards), [cards]);

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

  const handleOpen = useCallback(
    (ref: NoteRef) => {
      openNote(ref);
      setRailView('tree');
    },
    [openNote, setRailView],
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-0">
      <header className="flex items-baseline justify-between gap-4 px-6 pb-4 pt-6">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-h2 text-text-0">Поток</h1>
          {cards.length > 0 ? <span className="text-caption text-text-3">{cards.length}</span> : null}
        </div>
        <p className="hidden text-caption text-text-2 md:block">
          Перетащите карточку между колонками, чтобы сменить статус
        </p>
      </header>

      <LayoutGroup>
        <div ref={dnd.setBoardEl} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6">
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column.status}
              column={column}
              cards={byStatus[column.status]}
              reduced={reduced}
              draggingRef={dnd.draggingRef}
              settlingRef={dnd.settlingRef}
              isOver={dnd.overStatus === column.status}
              registerColumn={dnd.registerColumn}
              registerCard={dnd.registerCard}
              unregisterCard={dnd.unregisterCard}
              onCardLift={dnd.liftCard}
              onCardOpen={handleOpen}
              consumeDropClick={dnd.consumeDropClick}
            />
          ))}
        </div>
      </LayoutGroup>

      {dnd.ghost !== null ? (
        <DragGhost key={dnd.ghost.card.ref} ghost={dnd.ghost} reduced={reduced} onApi={dnd.attachGhost} />
      ) : null}
    </main>
  );
}
