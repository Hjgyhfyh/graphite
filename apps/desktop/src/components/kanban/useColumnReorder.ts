import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Status } from '@graphite/bindings';

const DRAG_THRESHOLD_PX = 5;
const SCROLL_EDGE_PX = 64;
const SCROLL_MAX_STEP_PX = 14;
// Пауза после перестановки: сосед ещё едет к новому слоту layout-анимацией, и
// его «живой» центр может мигнуть обратно через курсор — без паузы порядок дрожит.
const REORDER_COOLDOWN_MS = 140;

export interface ColumnReorderOptions {
  boardEl(): HTMLElement | null;
  visibleOrder(): Status[];
  columnEl(status: Status): HTMLElement | undefined;
  onCommit(visible: Status[]): void;
}

export interface ColumnReorder {
  draggingColumn: Status | null;
  previewOrder: Status[] | null;
  liftColumn(event: ReactPointerEvent<HTMLElement>, status: Status): void;
}

/** Перестановка колонок за заголовок: лёгкий pointer-DnD поверх layout-анимаций. */
export function useColumnReorder(options: ColumnReorderOptions): ColumnReorder {
  const opts = useRef(options);
  opts.current = options;

  const [draggingColumn, setDraggingColumn] = useState<Status | null>(null);
  const [previewOrder, setPreviewOrder] = useState<Status[] | null>(null);
  const preview = useRef<Status[] | null>(null);
  const busy = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      detachRef.current?.();
    },
    [],
  );

  const liftColumn = useCallback((event: ReactPointerEvent<HTMLElement>, status: Status) => {
    if (event.button !== 0 || busy.current) {
      return;
    }
    // С интерактивных элементов заголовка (инпут переименования) drag не стартует.
    if (event.target instanceof Element && event.target.closest('input, button, a') !== null) {
      return;
    }
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let cooldownUntil = 0;
    let lastX = event.clientX;
    let scrollRaf = 0;
    busy.current = true;
    el.setPointerCapture(pointerId);

    const setPreview = (next: Status[] | null) => {
      preview.current = next;
      setPreviewOrder(next);
    };

    const evaluate = (clientX: number) => {
      const now = performance.now();
      if (now < cooldownUntil) {
        return;
      }
      const order = preview.current ?? opts.current.visibleOrder();
      const others = order.filter((s) => s !== status);
      let index = others.length;
      for (let i = 0; i < others.length; i += 1) {
        const rect = opts.current.columnEl(others[i])?.getBoundingClientRect();
        if (rect !== undefined && clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      const next = [...others.slice(0, index), status, ...others.slice(index)];
      if (next.some((s, i) => s !== order[i])) {
        setPreview(next);
        cooldownUntil = now + REORDER_COOLDOWN_MS;
      }
    };

    const stopAutoScroll = () => {
      if (scrollRaf !== 0) {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = 0;
      }
    };

    const autoScroll = () => {
      const board = opts.current.boardEl();
      if (board !== null) {
        const rect = board.getBoundingClientRect();
        let step = 0;
        if (lastX < rect.left + SCROLL_EDGE_PX) {
          const t = Math.min(1, (rect.left + SCROLL_EDGE_PX - lastX) / SCROLL_EDGE_PX);
          step = -SCROLL_MAX_STEP_PX * t * t;
        } else if (lastX > rect.right - SCROLL_EDGE_PX) {
          const t = Math.min(1, (lastX - (rect.right - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX);
          step = SCROLL_MAX_STEP_PX * t * t;
        }
        if (step !== 0) {
          board.scrollLeft += step;
          evaluate(lastX);
        }
      }
      scrollRaf = requestAnimationFrame(autoScroll);
    };

    const detach = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      stopAutoScroll();
      if (el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
      busy.current = false;
      detachRef.current = null;
    };

    const finish = (commit: boolean) => {
      detach();
      const result = preview.current;
      if (commit && started && result !== null) {
        opts.current.onCommit(result);
      }
      setPreview(null);
      setDraggingColumn(null);
    };

    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerId) {
        return;
      }
      lastX = e.clientX;
      if (!started) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        started = true;
        setDraggingColumn(status);
        window.getSelection()?.removeAllRanges();
        scrollRaf = requestAnimationFrame(autoScroll);
      }
      evaluate(e.clientX);
    }

    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) {
        return;
      }
      finish(true);
    }

    function onCancel(e: PointerEvent) {
      if (e.pointerId !== pointerId) {
        return;
      }
      finish(false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    detachRef.current = detach;
  }, []);

  return { draggingColumn, previewOrder, liftColumn };
}
