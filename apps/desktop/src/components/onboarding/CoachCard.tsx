import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { ArrowRight, Check } from 'lucide-react';
import { Button, cx } from '@graphite/ui';
import {
  REDUCED_CROSSFADE,
  reducedFadeVariants,
  slideUpVariants,
  springSnappy,
  springStandard,
} from '../../motion';
import type { CoachStep } from './steps';

export type CoachCaretSide = 'left' | 'right' | 'top' | 'bottom';

export interface CoachCaret {
  side: CoachCaretSide;
  offset: number;
}

export interface CoachCardProps {
  step: CoachStep;
  index: number;
  total: number;
  x: MotionValue<number>;
  y: MotionValue<number>;
  caret: CoachCaret | null;
  reduced: boolean;
  onNext(): void;
  onSkip(): void;
  onSelect(index: number): void;
  onMeasure(size: { width: number; height: number }): void;
}

export const CARD_WIDTH = 320;

const CARET_SIDE: Record<CoachCaretSide, string> = {
  left: 'left-[-7px] border-b border-l',
  right: 'right-[-7px] border-t border-r',
  top: 'top-[-7px] border-l border-t',
  bottom: 'bottom-[-7px] border-b border-r',
};

export function CoachCard({
  step,
  index,
  total,
  x,
  y,
  caret,
  reduced,
  onNext,
  onSkip,
  onSelect,
  onMeasure,
}: CoachCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const Icon = step.icon;
  const isLast = index === total - 1;

  useEffect(() => {
    const el = cardRef.current;
    if (el === null) {
      return;
    }
    el.focus({ preventScroll: true });
    const report = () => onMeasure({ width: el.offsetWidth, height: el.offsetHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [onMeasure]);

  return (
    <motion.div
      style={{ x, y }}
      className="absolute left-0 top-0 w-80"
      onClick={(event) => event.stopPropagation()}
    >
      <motion.div
        ref={cardRef}
        tabIndex={-1}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10 }}
        animate={
          reduced
            ? { opacity: 1, transition: REDUCED_CROSSFADE }
            : { opacity: 1, scale: 1, y: 0, transition: { ...springStandard, delay: 0.12, opacity: { duration: 0.2, delay: 0.12 } } }
        }
        className="relative rounded-l border border-stroke-1 bg-bg-2 shadow-3 inset-shadow-hairline outline-none"
      >
        <div className="p-4 pb-3">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step.id}
              variants={reduced ? reducedFadeVariants : slideUpVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="flex items-center gap-2.5">
                <motion.span
                  initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, transition: { ...springSnappy, delay: 0.14 } }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-s bg-accent-dim text-accent"
                >
                  <Icon size={16} strokeWidth={1.75} />
                </motion.span>
                <h2 className="min-w-0 text-body font-semibold leading-snug text-text-0">{step.title}</h2>
              </div>
              <div className="mt-2.5 text-ui leading-relaxed text-text-1">{step.body}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-stroke-0 px-2.5 py-2">
          <Button variant="ghost" size="sm" onClick={onSkip} className="text-text-2">
            Пропустить
          </Button>
          <div className="flex items-center gap-1" aria-label={`Шаг ${index + 1} из ${total}`}>
            {Array.from({ length: total }, (_, dot) => (
              <button
                key={dot}
                type="button"
                aria-label={`Шаг ${dot + 1}`}
                aria-current={dot === index ? 'step' : undefined}
                onClick={() => onSelect(dot)}
                className="group flex h-4 items-center px-0.5"
              >
                <motion.span
                  initial={false}
                  animate={{ width: dot === index ? 20 : 6 }}
                  transition={reduced ? { duration: 0 } : springSnappy}
                  className={cx(
                    'block h-1.5 rounded-full transition-colors duration-[120ms]',
                    dot === index ? 'bg-accent' : dot < index ? 'bg-accent/45' : 'bg-bg-4 group-hover:bg-stroke-1',
                  )}
                />
              </button>
            ))}
          </div>
          <Button variant="primary" size="sm" onClick={onNext}>
            {isLast ? 'Готово' : 'Далее'}
            {isLast ? <Check size={14} strokeWidth={1.75} /> : <ArrowRight size={14} strokeWidth={1.75} />}
          </Button>
        </div>

        <AnimatePresence>
          {caret !== null ? (
            <motion.span
              key={caret.side}
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.16 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={caret.side === 'left' || caret.side === 'right' ? { top: caret.offset } : { left: caret.offset }}
              className={cx(
                'absolute z-10 size-3.5 rotate-45 rounded-[2px] border-stroke-1 bg-bg-2',
                CARET_SIDE[caret.side],
              )}
            />
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
