import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useUiStore } from '../stores/uiStore';
import { applyMotionSpeed } from './scale';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import { REDUCED_CROSSFADE, fadeVariants, popVariants, reducedFadeVariants, slideUpVariants } from './variants';

// Масштаб скорости из persist-стора применяем синхронно при загрузке модуля —
// до того как AppLaunch/PanelStagger отрисуют первый кадр. Иначе первая
// launch/stagger-анимация проиграется на скорости 1, а масштаб догонит только со
// второго кадра (layout-эффект провайдера выполняется после эффектов детей).
applyMotionSpeed(useUiStore.getState().reducedMotion ? 1 : useUiStore.getState().animationSpeed);

export interface TransitionBoxProps {
  children: ReactNode;
  className?: string;
}

export interface PresenceProps {
  children: ReactNode;
  mode?: 'sync' | 'wait' | 'popLayout';
  initial?: boolean;
}

export function Presence({ children, mode = 'sync', initial = false }: PresenceProps) {
  return (
    <AnimatePresence mode={mode} initial={initial}>
      {children}
    </AnimatePresence>
  );
}

export function Fade({ children, className }: TransitionBoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? reducedFadeVariants : fadeVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

export function SlideUp({ children, className }: TransitionBoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? reducedFadeVariants : slideUpVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

export function Pop({ children, className }: TransitionBoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? reducedFadeVariants : popVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

export function AppMotionConfig({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const speed = useUiStore((s) => s.animationSpeed);

  useLayoutEffect(() => {
    applyMotionSpeed(reduced ? 1 : speed);
  }, [reduced, speed]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (reduced) {
      root.setAttribute('data-reduced-motion', 'true');
    } else {
      root.removeAttribute('data-reduced-motion');
    }
    return () => {
      root.removeAttribute('data-reduced-motion');
    };
  }, [reduced]);

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'user'} transition={reduced ? REDUCED_CROSSFADE : undefined}>
      {children}
    </MotionConfig>
  );
}
