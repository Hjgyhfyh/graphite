import { Fragment, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Columns2, FilePlus2 } from 'lucide-react';
import { Button, cx, springTransition } from '@graphite/ui';
import { REDUCED_CROSSFADE, usePrefersReducedMotion } from '../../motion';
import { MAX_PANES, usePanesStore } from '../../stores/panesStore';
import type { Pane } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import { EditorPane } from '../editor/EditorPane';
import { EditorTransition } from '../editor/EditorTransition';
import { NOTE_DND_TYPE, PaneTabs, TAB_DND_TYPE } from './PaneTabs';
import { useVaultStore } from '../../stores/vaultStore';

const MIN_PANE_PX = 200;
const DIVIDER_PX = 1;
const EDGE_HIDE_DELAY_MS = 260;

const paneWeights = new Map<string, number>();

type DragKind = 'tab' | 'note';

function dragKindOf(types: readonly string[]): DragKind | undefined {
  if (types.includes(TAB_DND_TYPE)) {
    return 'tab';
  }
  if (types.includes(NOTE_DND_TYPE)) {
    return 'note';
  }
  return undefined;
}

interface ResizeContext {
  leftId: string;
  rightId: string;
  startX: number;
  leftW: number;
  pairTotal: number;
  pxPerWeight: number;
  minWeight: number;
}

function EmptyPane() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-l border border-stroke-0 bg-bg-1 text-text-3">
        <FilePlus2 size={22} strokeWidth={1.5} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-ui text-text-0">Нет открытых вкладок</p>
        <p className="max-w-xs text-caption text-text-2">Откройте заметку из дерева или создайте новую.</p>
      </div>
      <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().createNote()}>
        Новая заметка
      </Button>
    </div>
  );
}

function PaneColumn({
  pane,
  grow,
  isActive,
  showFrame,
}: {
  pane: Pane;
  grow: number;
  isActive: boolean;
  showFrame: boolean;
}) {
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const moveTabToPane = usePanesStore((s) => s.moveTabToPane);
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === pane.activeTabId));
  const reduced = usePrefersReducedMotion();
  const [dropKind, setDropKind] = useState<DragKind | undefined>(undefined);
  const enterCount = useRef(0);

  const acceptableKind = (event: ReactDragEvent<HTMLDivElement>): DragKind | undefined => {
    const kind = dragKindOf(event.dataTransfer.types);
    if (kind === 'tab') {
      const store = useTabsStore.getState();
      const dragging = store.draggingTabId === undefined
        ? undefined
        : store.tabs.find((t) => t.id === store.draggingTabId);
      if (dragging !== undefined && dragging.paneId === pane.id) {
        return undefined;
      }
    }
    return kind;
  };

  const resetDrop = () => {
    enterCount.current = 0;
    setDropKind(undefined);
  };

  const onBodyDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = acceptableKind(event);
    if (kind === undefined) {
      return;
    }
    event.preventDefault();
    enterCount.current += 1;
    setDropKind(kind);
  };

  const onBodyDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = acceptableKind(event);
    if (kind === undefined) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = kind === 'tab' ? 'move' : 'copy';
    setDropKind(kind);
  };

  const onBodyDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (dragKindOf(event.dataTransfer.types) === undefined) {
      return;
    }
    enterCount.current = Math.max(0, enterCount.current - 1);
    if (enterCount.current === 0) {
      setDropKind(undefined);
    }
  };

  const onBodyDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = dragKindOf(event.dataTransfer.types);
    resetDrop();
    if (kind === undefined) {
      return;
    }
    event.preventDefault();
    if (kind === 'tab') {
      const store = useTabsStore.getState();
      const dataId = event.dataTransfer.getData(TAB_DND_TYPE);
      const draggedId = dataId !== '' ? dataId : (store.draggingTabId ?? '');
      const source = draggedId === '' ? undefined : store.tabs.find((t) => t.id === draggedId);
      if (source !== undefined && source.paneId !== pane.id) {
        moveTabToPane(draggedId, pane.id);
        useTabsStore.getState().removeFromGroup(draggedId);
      }
      useTabsStore.getState().setDraggingTab(undefined);
      return;
    }
    const ref = event.dataTransfer.getData(NOTE_DND_TYPE);
    if (ref !== '') {
      useTabsStore.getState().open(ref, { paneId: pane.id });
    }
  };

  return (
    <section
      style={{ flexGrow: grow, flexBasis: 0 }}
      onMouseDownCapture={() => setActivePane(pane.id)}
      className="relative flex min-h-0 min-w-0 flex-col bg-bg-0"
      aria-label="Область редактора"
    >
      {showFrame && isActive ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ring-accent/40" />
      ) : null}
      <PaneTabs paneId={pane.id} />
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={onBodyDragEnter}
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
      >
        {tab !== undefined && tab.kind === 'editor' ? (
          <EditorTransition transitionKey={tab.id}>
            <EditorPane tabId={tab.id} noteRef={tab.noteRef} />
          </EditorTransition>
        ) : (
          <EmptyPane />
        )}
        <AnimatePresence>
          {dropKind !== undefined ? (
            <motion.div
              key="drop"
              className="absolute inset-0 z-30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduced ? REDUCED_CROSSFADE : { duration: 0.14, ease: 'easeOut' }}
              onDragOver={onBodyDragOver}
              onDrop={onBodyDrop}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-2 rounded-m bg-accent/10 ring-1 ring-inset ring-accent/50"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <motion.span
                  initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                  transition={reduced ? REDUCED_CROSSFADE : springTransition('snappy')}
                  className="flex items-center gap-2 rounded-m border border-stroke-1 bg-bg-2/95 px-3 py-1.5 text-ui text-text-0 shadow-3"
                >
                  {dropKind === 'tab' ? (
                    <Columns2 size={15} strokeWidth={1.75} className="text-accent" />
                  ) : (
                    <FilePlus2 size={15} strokeWidth={1.75} className="text-accent" />
                  )}
                  {dropKind === 'tab' ? 'Перенести сюда' : 'Открыть здесь'}
                </motion.span>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

export function SplitView() {
  const panes = usePanesStore((s) => s.panes);
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const reduced = usePrefersReducedMotion();

  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeContext | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>(() => ({ ...Object.fromEntries(paneWeights) }));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [windowDragKind, setWindowDragKind] = useState<DragKind | undefined>(undefined);
  const [edgeHot, setEdgeHot] = useState(false);

  const weightOf = (id: string): number => weights[id] ?? 1;

  useEffect(() => {
    for (const [id, weight] of Object.entries(weights)) {
      paneWeights.set(id, weight);
    }
  }, [weights]);

  useEffect(() => {
    const ids = new Set(panes.map((pane) => pane.id));
    for (const id of Array.from(paneWeights.keys())) {
      if (!ids.has(id)) {
        paneWeights.delete(id);
      }
    }
    setWeights((prev) => {
      const kept = Object.entries(prev).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [panes]);

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let timer: number | undefined;
    const over = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      const kind = types === undefined ? undefined : dragKindOf(types);
      if (kind === undefined) {
        return;
      }
      setWindowDragKind((prev) => (prev === kind ? prev : kind));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWindowDragKind(undefined), EDGE_HIDE_DELAY_MS);
    };
    const end = () => {
      window.clearTimeout(timer);
      setWindowDragKind(undefined);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, []);

  const edgeVisible = windowDragKind !== undefined && panes.length < MAX_PANES;

  useEffect(() => {
    if (!edgeVisible) {
      setEdgeHot(false);
    }
  }, [edgeVisible]);

  const onEdgeDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = dragKindOf(event.dataTransfer.types);
    if (kind === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = kind === 'tab' ? 'move' : 'copy';
    setEdgeHot(true);
  };

  const onEdgeDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const kind = dragKindOf(event.dataTransfer.types);
    if (kind === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setEdgeHot(false);
    const store = useTabsStore.getState();
    if (kind === 'tab') {
      const dataId = event.dataTransfer.getData(TAB_DND_TYPE);
      const draggedId = dataId !== '' ? dataId : (store.draggingTabId ?? '');
      if (draggedId === '') {
        return;
      }
      const newPaneId = usePanesStore.getState().addPane();
      if (newPaneId !== undefined) {
        usePanesStore.getState().moveTabToPane(draggedId, newPaneId);
        useTabsStore.getState().removeFromGroup(draggedId);
      }
      useTabsStore.getState().setDraggingTab(undefined);
      return;
    }
    const ref = event.dataTransfer.getData(NOTE_DND_TYPE);
    if (ref === '') {
      return;
    }
    const newPaneId = usePanesStore.getState().addPane();
    if (newPaneId !== undefined) {
      store.open(ref, { paneId: newPaneId });
    }
  };

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    const container = containerRef.current;
    if (container === null || index + 1 >= panes.length) {
      return;
    }
    event.preventDefault();
    const leftId = panes[index].id;
    const rightId = panes[index + 1].id;
    const total = panes.reduce((sum, pane) => sum + weightOf(pane.id), 0);
    const width = container.getBoundingClientRect().width - (panes.length - 1) * DIVIDER_PX;
    const pxPerWeight = width > 0 && total > 0 ? width / total : 1;
    const leftW = weightOf(leftId);
    const pairTotal = leftW + weightOf(rightId);
    resizeRef.current = {
      leftId,
      rightId,
      startX: event.clientX,
      leftW,
      pairTotal,
      pxPerWeight,
      minWeight: MIN_PANE_PX / pxPerWeight,
    };
    setDragIndex(index);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const ctx = resizeRef.current;
    if (ctx === null) {
      return;
    }
    const deltaWeight = (event.clientX - ctx.startX) / ctx.pxPerWeight;
    const minWeight = Math.min(ctx.minWeight, ctx.pairTotal / 2);
    const nextLeft = Math.max(minWeight, Math.min(ctx.pairTotal - minWeight, ctx.leftW + deltaWeight));
    setWeights((prev) => ({ ...prev, [ctx.leftId]: nextLeft, [ctx.rightId]: ctx.pairTotal - nextLeft }));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current === null) {
      return;
    }
    resizeRef.current = null;
    setDragIndex(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const equalizePair = (index: number) => {
    if (index + 1 >= panes.length) {
      return;
    }
    const leftId = panes[index].id;
    const rightId = panes[index + 1].id;
    const pair = weightOf(leftId) + weightOf(rightId);
    setWeights((prev) => ({ ...prev, [leftId]: pair / 2, [rightId]: pair / 2 }));
  };

  const showFrame = panes.length > 1;

  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1">
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          <PaneColumn pane={pane} grow={weightOf(pane.id)} isActive={pane.id === activePaneId} showFrame={showFrame} />
          {index < panes.length - 1 ? (
            <div role="separator" aria-orientation="vertical" className="relative z-30 w-px shrink-0 self-stretch bg-stroke-0">
              <div
                aria-label="Изменить ширину области"
                onPointerDown={(event) => onResizeStart(event, index)}
                onPointerMove={onResizeMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDoubleClick={() => equalizePair(index)}
                className={cx(
                  'absolute inset-y-0 -left-1 -right-1 z-30 cursor-col-resize transition-colors',
                  dragIndex === index ? 'bg-accent/25' : 'hover:bg-accent/15',
                )}
              />
              {dragIndex === index ? (
                <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent" />
              ) : null}
            </div>
          ) : null}
        </Fragment>
      ))}
      <AnimatePresence>
        {edgeVisible ? (
          <motion.div
            key="edge"
            className="absolute inset-y-0 right-0 z-40 w-10 p-1"
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 12 }}
            transition={reduced ? REDUCED_CROSSFADE : springTransition('standard')}
            onDragOver={onEdgeDragOver}
            onDragLeave={() => setEdgeHot(false)}
            onDrop={onEdgeDrop}
          >
            <div
              className={cx(
                'flex h-full w-full items-center justify-center rounded-m border border-dashed transition-colors duration-[120ms]',
                edgeHot ? 'border-accent bg-accent/15' : 'border-stroke-1 bg-bg-1/60',
              )}
            >
              <Columns2 size={15} strokeWidth={1.75} className={edgeHot ? 'text-accent' : 'text-text-2'} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
