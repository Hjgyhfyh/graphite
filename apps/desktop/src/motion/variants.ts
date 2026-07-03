import type { Transition, Variants } from 'motion/react';
import { springs } from '@graphite/ui';

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

export interface SpringTransition {
  type: 'spring';
  stiffness: number;
  damping: number;
  mass: number;
}

export const springSnappy: SpringTransition = { type: 'spring', ...springs.snappy };
export const springStandard: SpringTransition = { type: 'spring', ...springs.standard };
export const springSoft: SpringTransition = { type: 'spring', ...springs.soft };

export const REDUCED_CROSSFADE: Transition = { duration: 0.08, ease: 'linear' };

export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_IN } },
};

export const reducedFadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: REDUCED_CROSSFADE },
  exit: { opacity: 0, transition: REDUCED_CROSSFADE },
};

export const popVariants: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: springSnappy },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: EASE_IN } },
};

export const slideUpVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: springStandard },
  exit: { opacity: 0, y: 6, transition: { duration: 0.14, ease: EASE_IN } },
};

export const pageVariants: Variants = {
  initial: { opacity: 0, scale: 1.015 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.985, transition: { duration: 0.16, ease: EASE_IN } },
};

export const listContainerVariants: Variants = {
  animate: { transition: { staggerChildren: 0.022 } },
};

export const listItemVariants: Variants = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0, transition: springSnappy },
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_IN } },
};

export const launchWindowVariants: Variants = {
  initial: { opacity: 0, scale: 0.985 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { opacity: { duration: 0.14, ease: EASE_OUT }, scale: springSoft },
  },
};

export const launchContainerVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } },
};

export const launchItemVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
};

export const reducedLaunchContainerVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0 } },
};
