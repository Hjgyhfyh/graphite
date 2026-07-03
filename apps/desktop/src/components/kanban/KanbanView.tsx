import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGroup } from 'motion/react';
import { commands } from '@graphite/bindings';
import type { NoteRef, Status } from '@graphite/bindings';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { usePrefersReducedMotion } from '../../motion';
import { KanbanColumn } from './KanbanColumn';
import { COLUMNS, groupByStatus, pipelineStatus, statusReason } from './columns';
import type { KanbanCardData } from './columns';

export function KanbanView() {
  const tree = useVaultStore((s) => s.tree);
  const openNote = useVaultStore((s) => s.openNote);
  const loadTree = useVaultStore((s) => s.loadTree);
  const pushToast = useUiStore((s) => s.pushToast);
  const setRailView = useUiStore((s) => s.setRailView);
  const reduced = usePrefersReducedMotion();

  const [optimistic, setOptimistic] = useState<Record<NoteRef, Status>>({});
  const [draggingRef, setDraggingRef] = useState<NoteRef | null>(null);
  const [overStatus, setOverStatus] = useState<Status | null>(null);

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
      list.push({ ...node, status: optimistic[node.ref] ?? base });
    }
    return list;
  }, [tree, optimistic]);

  const byStatus = useMemo(() => groupByStatus(cards), [cards]);

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
      const node = useVaultStore.getState().tree.find((n) => n.ref === ref);
      const base = node !== undefined ? pipelineStatus(node) : null;
      if (base === null) {
        return;
      }
      const current = optimistic[ref] ?? base;
      if (current === target) {
        return;
      }
      setOptimistic((prev) => ({ ...prev, [ref]: target }));
      try {
        await commands.setStatus({ ref, status: target });
        await loadTree();
        clearOptimistic(ref);
      } catch (error) {
        clearOptimistic(ref);
        pushToast({ kind: 'error', text: statusReason(error, 'Не удалось сменить статус') });
      }
    },
    [optimistic, loadTree, clearOptimistic, pushToast],
  );

  const handleDragStart = useCallback((ref: NoteRef) => {
    setDraggingRef(ref);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingRef(null);
    setOverStatus(null);
  }, []);

  const handleOver = useCallback((status: Status) => {
    setOverStatus(status);
  }, []);

  const handleLeave = useCallback((status: Status) => {
    setOverStatus((current) => (current === status ? null : current));
  }, []);

  const handleDrop = useCallback(
    (status: Status, ref: string) => {
      const target = ref.length > 0 ? ref : draggingRef;
      setDraggingRef(null);
      setOverStatus(null);
      if (target !== null && target.length > 0) {
        void move(target, status);
      }
    },
    [draggingRef, move],
  );

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
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6">
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column.status}
              column={column}
              cards={byStatus[column.status]}
              reduced={reduced}
              draggingRef={draggingRef}
              isOver={overStatus === column.status}
              onOver={handleOver}
              onLeave={handleLeave}
              onDropCard={handleDrop}
              onCardDragStart={handleDragStart}
              onCardDragEnd={handleDragEnd}
              onCardOpen={handleOpen}
            />
          ))}
        </div>
      </LayoutGroup>
    </main>
  );
}
