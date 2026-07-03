import type { ReactNode } from 'react';
import type { Variants } from 'motion/react';
import { motion } from 'motion/react';
import { easePoints } from '@graphite/ui';
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

export interface EditorTransitionProps {
  transitionKey: string;
  children: ReactNode;
}

export function EditorTransition({ transitionKey, children }: EditorTransitionProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Presence mode="sync">
        <motion.div
          key={transitionKey}
          className="absolute inset-0 flex min-h-0 flex-col"
          variants={reduced ? reducedVariants : swapVariants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {children}
        </motion.div>
      </Presence>
    </div>
  );
}
