import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { NoteRef, Status } from '@graphite/bindings';
import type { KanbanCardData } from './columns';

const DRAG_THRESHOLD_PX = 4;
const SCROLL_EDGE_PX = 64;
const SCROLL_MAX_STEP_PX = 14;

export interface GhostState {
  card: KanbanCardData;
  tags: string[];
  width: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

export interface GhostApi {
  track(x: number, y: number): void;
  flyTo(x: number, y: number, onDone: () => void): void;
}

export interface KanbanDndOptions {
  reduced: boolean;
  statusOf(ref: NoteRef): Status | null;
  onDrop(ref: NoteRef, status: Status): void;
}

export interface KanbanDnd {
  ghost: GhostState | null;
  draggingRef: NoteRef | null;
  overStatus: Status | null;
  settlingRef: NoteRef | null;
  setBoardEl(el: HTMLElement | null): void;
  registerColumn(status: Status, el: HTMLElement | null): void;
  registerCard(ref: NoteRef, el: HTMLElement): void;
  unregisterCard(ref: NoteRef, el: HTMLElement): void;
  attachGhost(api: GhostApi | null): void;
  liftCard(event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]): void;
  consumeDropClick(): boolean;
}

interface ActiveDrag {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  started: boolean;
}

/**
 * Перенос карточек между колонками на pointer-событиях: нативный HTML5-DnD в
 * Tauri-окне на Windows перехватывается drag-drop-обработчиком WebView2 (он
 * нужен для дропа внешних файлов), поэтому drop-события до DOM не доходят.
 * Карточка «поднимается» в портальный призрак, колонки хит-тестятся по
 * рамкам, посадка — пружинный перелёт призрака в реальный слот.
 */
export function useKanbanDnd(options: KanbanDndOptions): KanbanDnd {
  const opts = useRef(options);
  opts.current = options;

  const [ghost, setGhost] = useState<GhostState | null>(null);
  const [draggingRef, setDraggingRef] = useState<NoteRef | null>(null);
  const [overStatus, setOverStatus] = useState<Status | null>(null);
  const [settlingRef, setSettlingRef] = useState<NoteRef | null>(null);

  const boardEl = useRef<HTMLElement | null>(null);
  const columnEls = useRef(new Map<Status, HTMLElement>());
  const cardEls = useRef(new Map<NoteRef, HTMLElement>());
  const ghostApi = useRef<GhostApi | null>(null);
  const ghostOn = useRef(false);
  const active = useRef<ActiveDrag | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const over = useRef<Status | null>(null);
  const scrollRaf = useRef(0);
  const suppressClick = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      detachRef.current?.();
    },
    [],
  );

  const setBoardEl = useCallback((el: HTMLElement | null) => {
    boardEl.current = el;
  }, []);

  const registerColumn = useCallback((status: Status, el: HTMLElement | null) => {
    if (el === null) {
      columnEls.current.delete(status);
    } else {
      columnEls.current.set(status, el);
    }
  }, []);

  const registerCard = useCallback((ref: NoteRef, el: HTMLElement) => {
    cardEls.current.set(ref, el);
  }, []);

  const unregisterCard = useCallback((ref: NoteRef, el: HTMLElement) => {
    if (cardEls.current.get(ref) === el) {
      cardEls.current.delete(ref);
    }
  }, []);

  const attachGhost = useCallback((api: GhostApi | null) => {
    ghostApi.current = api;
  }, []);

  const consumeDropClick = useCallback(() => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }, []);

  const liftCard = useCallback(
    (event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]) => {
      if (event.button !== 0 || active.current !== null || ghostOn.current) {
        return;
      }
      const el = event.currentTarget;
      const drag: ActiveDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: 0,
        offsetY: 0,
        started: false,
      };
      active.current = drag;
      pointer.current = { x: event.clientX, y: event.clientY };
      suppressClick.current = false;
      el.setPointerCapture(event.pointerId);

      const setOver = (next: Status | null) => {
        if (over.current !== next) {
          over.current = next;
          setOverStatus(next);
        }
      };

      const hitTest = () => {
        const { x, y } = pointer.current;
        let hit: Status | null = null;
        for (const [status, columnEl] of columnEls.current) {
          const rect = columnEl.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            hit = status;
            break;
          }
        }
        setOver(hit);
      };

      const stopAutoScroll = () => {
        if (scrollRaf.current !== 0) {
          cancelAnimationFrame(scrollRaf.current);
          scrollRaf.current = 0;
        }
      };

      const autoScroll = () => {
        const board = boardEl.current;
        if (board !== null) {
          const x = pointer.current.x;
          const rect = board.getBoundingClientRect();
          let step = 0;
          if (x < rect.left + SCROLL_EDGE_PX) {
            const t = Math.min(1, (rect.left + SCROLL_EDGE_PX - x) / SCROLL_EDGE_PX);
            step = -SCROLL_MAX_STEP_PX * t * t;
          } else if (x > rect.right - SCROLL_EDGE_PX) {
            const t = Math.min(1, (x - (rect.right - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX);
            step = SCROLL_MAX_STEP_PX * t * t;
          }
          if (step !== 0) {
            board.scrollLeft += step;
          }
        }
        hitTest();
        scrollRaf.current = requestAnimationFrame(autoScroll);
      };

      const detach = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        stopAutoScroll();
        if (el.hasPointerCapture(drag.pointerId)) {
          el.releasePointerCapture(drag.pointerId);
        }
        active.current = null;
        detachRef.current = null;
      };

      const settleGhost = () => {
        ghostOn.current = false;
        setGhost(null);
      };

      const cancelDrag = () => {
        detach();
        setOver(null);
        if (!drag.started) {
          return;
        }
        const api = ghostApi.current;
        const home = cardEls.current.get(card.ref);
        if (opts.current.reduced || api === null || home === undefined) {
          settleGhost();
          setDraggingRef(null);
          return;
        }
        const rect = home.getBoundingClientRect();
        api.flyTo(rect.left, rect.top, () => {
          settleGhost();
          setDraggingRef(null);
        });
      };

      const commitDrag = (target: Status) => {
        detach();
        setOver(null);
        setDraggingRef(null);
        setSettlingRef(card.ref);
        opts.current.onDrop(card.ref, target);
        if (opts.current.reduced || ghostApi.current === null) {
          settleGhost();
          setSettlingRef(null);
          return;
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const api = ghostApi.current;
            const landed = cardEls.current.get(card.ref);
            if (api === null || landed === undefined) {
              settleGhost();
              setSettlingRef(null);
              return;
            }
            const rect = landed.getBoundingClientRect();
            api.flyTo(rect.left, rect.top, () => {
              settleGhost();
              setSettlingRef(null);
            });
          });
        });
      };

      function onMove(e: PointerEvent) {
        if (e.pointerId !== drag.pointerId) {
          return;
        }
        pointer.current = { x: e.clientX, y: e.clientY };
        if (!drag.started) {
          if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
            return;
          }
          drag.started = true;
          suppressClick.current = true;
          const rect = el.getBoundingClientRect();
          drag.offsetX = drag.startX - rect.left;
          drag.offsetY = drag.startY - rect.top;
          ghostOn.current = true;
          setGhost({
            card,
            tags,
            width: rect.width,
            startX: e.clientX - drag.offsetX,
            startY: e.clientY - drag.offsetY,
            offsetX: drag.offsetX,
            offsetY: drag.offsetY,
          });
          setDraggingRef(card.ref);
          window.getSelection()?.removeAllRanges();
          hitTest();
          scrollRaf.current = requestAnimationFrame(autoScroll);
          return;
        }
        ghostApi.current?.track(e.clientX - drag.offsetX, e.clientY - drag.offsetY);
        hitTest();
      }

      function onUp(e: PointerEvent) {
        if (e.pointerId !== drag.pointerId) {
          return;
        }
        pointer.current = { x: e.clientX, y: e.clientY };
        if (!drag.started) {
          detach();
          return;
        }
        hitTest();
        const target = over.current;
        const from = opts.current.statusOf(card.ref);
        if (target !== null && from !== null && target !== from) {
          commitDrag(target);
        } else {
          cancelDrag();
        }
      }

      function onCancel(e: PointerEvent) {
        if (e.pointerId !== drag.pointerId) {
          return;
        }
        cancelDrag();
      }

      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelDrag();
        }
      }

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      detachRef.current = detach;
    },
    [],
  );

  return {
    ghost,
    draggingRef,
    overStatus,
    settlingRef,
    setBoardEl,
    registerColumn,
    registerCard,
    unregisterCard,
    attachGhost,
    liftCard,
    consumeDropClick,
  };
}
