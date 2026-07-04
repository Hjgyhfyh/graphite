import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { REDUCED_CROSSFADE, springSoft, springStandard, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { CARD_WIDTH, CoachCard } from './CoachCard';
import type { CoachCaret } from './CoachCard';
import { COACH_STEPS } from './steps';
import type { CoachPlacement, CoachStep } from './steps';
import { Spotlight } from './Spotlight';

const OPEN_DELAY_MS = 1100;
const SYNC_INTERVAL_MS = 320;
const GAP = 18;
const EDGE = 16;
const CENTER_RADIUS = 999;
const CARET_HALF = 7;

interface HoleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CardPlacement {
  x: number;
  y: number;
  caret: CoachCaret | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveTarget(step: CoachStep): HTMLElement | null {
  for (const selector of step.selectors) {
    const found = document.querySelector(selector.query);
    if (!(found instanceof HTMLElement)) {
      continue;
    }
    const el =
      selector.parent === true && found.parentElement instanceof HTMLElement ? found.parentElement : found;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return el;
    }
  }
  return null;
}

function holeFor(
  step: CoachStep,
  el: HTMLElement | null,
  vw: number,
  vh: number,
): { rect: HoleRect; radius: number; found: boolean } {
  if (el !== null) {
    const bounds = el.getBoundingClientRect();
    return {
      rect: {
        x: bounds.left - step.padding,
        y: bounds.top - step.padding,
        width: bounds.width + step.padding * 2,
        height: bounds.height + step.padding * 2,
      },
      radius: step.radius,
      found: true,
    };
  }
  return { rect: { x: vw / 2, y: vh / 2, width: 0, height: 0 }, radius: CENTER_RADIUS, found: false };
}

function placeCard(
  hole: HoleRect,
  found: boolean,
  placement: CoachPlacement,
  card: { width: number; height: number },
  vw: number,
  vh: number,
): CardPlacement {
  if (!found || placement === 'center') {
    return { x: (vw - card.width) / 2, y: (vh - card.height) / 2, caret: null };
  }
  const centerX = hole.x + hole.width / 2;
  const centerY = hole.y + hole.height / 2;
  if (placement === 'left' || placement === 'right') {
    let side = placement;
    const fitsRight = hole.x + hole.width + GAP + card.width <= vw - EDGE;
    const fitsLeft = hole.x - GAP - card.width >= EDGE;
    if (side === 'right' && !fitsRight && fitsLeft) {
      side = 'left';
    } else if (side === 'left' && !fitsLeft && fitsRight) {
      side = 'right';
    }
    const x =
      side === 'right'
        ? Math.min(hole.x + hole.width + GAP, vw - EDGE - card.width)
        : Math.max(hole.x - GAP - card.width, EDGE);
    const y = clamp(centerY - card.height / 2, EDGE, Math.max(EDGE, vh - EDGE - card.height));
    return {
      x,
      y,
      caret: {
        side: side === 'right' ? 'left' : 'right',
        offset: clamp(centerY - y - CARET_HALF, 14, card.height - 28),
      },
    };
  }
  let side = placement;
  const fitsBottom = hole.y + hole.height + GAP + card.height <= vh - EDGE;
  const fitsTop = hole.y - GAP - card.height >= EDGE;
  if (side === 'bottom' && !fitsBottom && fitsTop) {
    side = 'top';
  } else if (side === 'top' && !fitsTop && fitsBottom) {
    side = 'bottom';
  }
  const y =
    side === 'bottom'
      ? Math.min(hole.y + hole.height + GAP, vh - EDGE - card.height)
      : Math.max(hole.y - GAP - card.height, EDGE);
  const x = clamp(centerX - card.width / 2, EDGE, Math.max(EDGE, vw - EDGE - card.width));
  return {
    x,
    y,
    caret: {
      side: side === 'bottom' ? 'top' : 'bottom',
      offset: clamp(centerX - x - CARET_HALF, 14, card.width - 28),
    },
  };
}

function nearRect(a: HoleRect, b: HoleRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function caretEquals(a: CoachCaret | null, b: CoachCaret | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.side === b.side && Math.abs(a.offset - b.offset) < 0.5;
}

export function Onboarding() {
  const done = useUiStore((s) => s.onboardingDone);
  const vaultReady = useVaultStore((s) => s.info !== undefined);
  const reduced = usePrefersReducedMotion();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [hasTarget, setHasTarget] = useState(false);
  const [caret, setCaret] = useState<CoachCaret | null>(null);

  const holeX = useMotionValue(0);
  const holeY = useMotionValue(0);
  const holeW = useMotionValue(0);
  const holeH = useMotionValue(0);
  const holeR = useMotionValue(CENTER_RADIUS);
  const cardX = useMotionValue(0);
  const cardY = useMotionValue(0);

  const cardSizeRef = useRef({ width: CARD_WIDTH, height: 240 });
  const appliedRef = useRef<{ hole: HoleRect; radius: number; card: { x: number; y: number } } | null>(null);
  const seededRef = useRef(false);
  const enteredRef = useRef(false);

  useEffect(() => {
    if (done || !vaultReady) {
      setOpen(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setStepIndex(0);
      seededRef.current = false;
      enteredRef.current = false;
      appliedRef.current = null;
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setOpen(true);
    }, OPEN_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [done, vaultReady]);

  const finish = useCallback(() => {
    if (!reduced) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      animate(holeX, -80, springSoft);
      animate(holeY, -80, springSoft);
      animate(holeW, vw + 160, springSoft);
      animate(holeH, vh + 160, springSoft);
    }
    useUiStore.getState().setOnboardingDone(true);
    setOpen(false);
  }, [reduced, holeX, holeY, holeW, holeH]);

  const next = useCallback(() => {
    if (stepIndex >= COACH_STEPS.length - 1) {
      finish();
    } else {
      setStepIndex(stepIndex + 1);
    }
  }, [stepIndex, finish]);

  const back = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex(stepIndex - 1);
    }
  }, [stepIndex]);

  const select = useCallback((index: number) => {
    setStepIndex(index);
  }, []);

  const sync = useCallback(
    (animated: boolean) => {
      const step = COACH_STEPS[stepIndex];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const el = resolveTarget(step);
      const { rect, radius, found } = holeFor(step, el, vw, vh);
      const placed = placeCard(rect, found, step.placement, cardSizeRef.current, vw, vh);
      setHasTarget(found);
      setCaret((prev) => (caretEquals(prev, placed.caret) ? prev : placed.caret));
      const prev = appliedRef.current;
      if (
        prev !== null &&
        nearRect(prev.hole, rect) &&
        prev.radius === radius &&
        Math.abs(prev.card.x - placed.x) < 0.5 &&
        Math.abs(prev.card.y - placed.y) < 0.5
      ) {
        return;
      }
      appliedRef.current = { hole: rect, radius, card: { x: placed.x, y: placed.y } };
      if (!seededRef.current) {
        holeX.set(-80);
        holeY.set(-80);
        holeW.set(vw + 160);
        holeH.set(vh + 160);
        holeR.set(radius);
        cardX.set(placed.x);
        cardY.set(placed.y);
        seededRef.current = true;
      }
      const instant = !animated || reduced;
      const spring = enteredRef.current ? springStandard : springSoft;
      enteredRef.current = true;
      const apply = (mv: MotionValue<number>, value: number) => {
        if (instant) {
          mv.set(value);
        } else {
          animate(mv, value, spring);
        }
      };
      apply(holeX, rect.x);
      apply(holeY, rect.y);
      apply(holeW, rect.width);
      apply(holeH, rect.height);
      apply(holeR, radius);
      apply(cardX, placed.x);
      apply(cardY, placed.y);
    },
    [stepIndex, reduced, holeX, holeY, holeW, holeH, holeR, cardX, cardY],
  );

  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => syncRef.current(true));
    const interval = window.setInterval(() => syncRef.current(true), SYNC_INTERVAL_MS);
    const onResize = () => syncRef.current(false);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.removeEventListener('resize', onResize);
    };
  }, [open, stepIndex]);

  const handleMeasure = useCallback((size: { width: number; height: number }) => {
    if (
      Math.abs(size.width - cardSizeRef.current.width) < 1 &&
      Math.abs(size.height - cardSizeRef.current.height) < 1
    ) {
      return;
    }
    cardSizeRef.current = size;
    syncRef.current(true);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      const step = COACH_STEPS[stepIndex];
      if (step.id === 'palette' && event.ctrlKey && !event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        finish();
        useUiStore.getState().setPaletteOpen(true);
        return;
      }
      if (step.id === 'palette' && event.ctrlKey && event.altKey && event.code === 'Space') {
        event.preventDefault();
        finish();
        useUiStore.getState().setFloatingCaptureOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
        if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button') !== null) {
          return;
        }
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, stepIndex, finish, next, back]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="onboarding"
          role="dialog"
          aria-modal="true"
          aria-label="Знакомство с Graphite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: reduced ? REDUCED_CROSSFADE : { duration: 0.24, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: reduced ? REDUCED_CROSSFADE : { duration: 0.26, ease: 'easeIn' } }}
          className="fixed inset-0 z-50 cursor-default overflow-hidden"
          onClick={next}
        >
          <Spotlight
            x={holeX}
            y={holeY}
            width={holeW}
            height={holeH}
            radius={holeR}
            ringVisible={hasTarget}
            reduced={reduced}
          />
          <CoachCard
            step={COACH_STEPS[stepIndex]}
            index={stepIndex}
            total={COACH_STEPS.length}
            x={cardX}
            y={cardY}
            caret={caret}
            reduced={reduced}
            onNext={next}
            onSkip={finish}
            onSelect={select}
            onMeasure={handleMeasure}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
