import { Fragment, useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '@graphite/ui';
import { usePanesStore } from '../../stores/panesStore';
import type { Pane } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import { EditorPane } from '../editor/EditorPane';
import { EditorTransition } from '../editor/EditorTransition';
import { PaneTabs, TAB_DND_TYPE } from './PaneTabs';

const MIN_PANE_PX = 200;
const DIVIDER_PX = 1;

const paneWeights = new Map<string, number>();

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
    <div className="flex flex-1 items-center justify-center text-ui text-text-2">Нет открытых вкладок</div>
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
  const [dropActive, setDropActive] = useState(false);

  const onBodyDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropActive(true);
  };

  const onBodyDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropActive(false);
    }
  };

  const onBodyDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) {
      return;
    }
    event.preventDefault();
    setDropActive(false);
    const draggedId = event.dataTransfer.getData(TAB_DND_TYPE);
    if (draggedId === '') {
      return;
    }
    const source = useTabsStore.getState().tabs.find((t) => t.id === draggedId);
    if (source === undefined || source.paneId === pane.id) {
      return;
    }
    moveTabToPane(draggedId, pane.id);
    useTabsStore.getState().removeFromGroup(draggedId);
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
        {dropActive ? (
          <div className="absolute inset-0 z-30" onDragOver={onBodyDragOver} onDrop={onBodyDrop}>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-2 rounded-m bg-accent/10 ring-1 ring-inset ring-accent/50"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function SplitView() {
  const panes = usePanesStore((s) => s.panes);
  const activePaneId = usePanesStore((s) => s.activePaneId);

  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeContext | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>(() => ({ ...Object.fromEntries(paneWeights) }));
  const [dragIndex, setDragIndex] = useState<number | null>(null);

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
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
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
    </div>
  );
}
