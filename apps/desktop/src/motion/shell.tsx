import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import {
  launchContainerVariants,
  launchItemVariants,
  launchWindowVariants,
  pageVariants,
  reducedFadeVariants,
  reducedLaunchContainerVariants,
  springStandard,
} from './variants';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

interface BoxProps {
  children: ReactNode;
  className?: string;
}

export function AppLaunch({ children, className }: BoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? reducedFadeVariants : launchWindowVariants}
      initial="initial"
      animate="animate"
    >
      {children}
    </motion.div>
  );
}

export function PanelStagger({ children, className }: BoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? reducedLaunchContainerVariants : launchContainerVariants}
      initial="initial"
      animate="animate"
    >
      {children}
    </motion.div>
  );
}

export function PanelItem({ children, className }: BoxProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div className={className} variants={reduced ? reducedFadeVariants : launchItemVariants}>
      {children}
    </motion.div>
  );
}

interface CollapsibleColumnProps {
  open: boolean;
  width: number;
  className?: string;
  children: ReactNode;
}

export function CollapsibleColumn({ open, width, className, children }: CollapsibleColumnProps) {
  const reduced = usePrefersReducedMotion();
  const w = useMotionValue(open ? width : 0);
  const [animating, setAnimating] = useState(false);
  const prevOpen = useRef(open);

  useEffect(() => {
    const wasOpen = prevOpen.current;
    prevOpen.current = open;
    const target = open ? width : 0;
    if (reduced || (open && wasOpen)) {
      w.set(target);
      setAnimating(false);
      return;
    }
    setAnimating(true);
    const controls = animate(w, target, {
      ...springStandard,
      onComplete: () => setAnimating(false),
    });
    return () => {
      controls.stop();
    };
  }, [open, width, reduced, w]);

  const overflowVisible = open && !animating;

  return (
    <motion.div
      className={className}
      style={{ width: w, overflow: overflowVisible ? 'visible' : 'hidden' }}
    >
      <div style={{ width }} className="h-full" inert={!open || undefined} aria-hidden={!open || undefined}>
        {children}
      </div>
    </motion.div>
  );
}

interface ViewSwapProps {
  viewKey: string;
  children: ReactNode;
}

export function ViewSwap({ viewKey, children }: ViewSwapProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={viewKey}
          className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
          variants={reduced ? reducedFadeVariants : pageVariants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
