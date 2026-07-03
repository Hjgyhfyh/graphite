import type { ReactNode } from 'react';
import type { Variants } from 'motion/react';
import { motion, useIsPresent } from 'motion/react';
import { cx, easePoints } from '@graphite/ui';
import { Presence, usePrefersReducedMotion } from '../../motion';

const swapVariants: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.994 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: easePoints.out } },
  exit: { opacity: 0, scale: 0.994, transition: { duration: 0.14, ease: easePoints.in } },
};

const reducedVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.08, ease: 'linear' } },
  exit: { opacity: 0, transition: { duration: 0.08, ease: 'linear' } },
};

interface TransitionPaneProps {
  variants: Variants;
  children: ReactNode;
}

function TransitionPane({ variants, children }: TransitionPaneProps) {
  const present = useIsPresent();
  return (
    <motion.div
      className={cx('absolute inset-0 flex min-h-0 flex-col', !present && 'pointer-events-none')}
      style={{ zIndex: present ? 1 : 0 }}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      inert={!present || undefined}
    >
      {children}
    </motion.div>
  );
}

export interface EditorTransitionProps {
  transitionKey: string;
  children: ReactNode;
}

export function EditorTransition({ transitionKey, children }: EditorTransitionProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Presence mode="sync">
        <TransitionPane key={transitionKey} variants={reduced ? reducedVariants : swapVariants}>
          {children}
        </TransitionPane>
      </Presence>
    </div>
  );
}
