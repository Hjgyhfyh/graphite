import { useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { animate, motion, useMotionValue, useSpring, useTransform, useVelocity } from 'motion/react';
import { springTransition } from '@graphite/ui';
import { CardSurface } from './KanbanCard';
import type { GhostApi, GhostState } from './useKanbanDnd';

const TILT_MAX_DEG = 4.5;
const TILT_VELOCITY_PX = 1600;

export interface DragGhostProps {
  ghost: GhostState;
  reduced: boolean;
  onApi(api: GhostApi | null): void;
}

export function DragGhost({ ghost, reduced, onApi }: DragGhostProps) {
  const x = useMotionValue(ghost.startX);
  const y = useMotionValue(ghost.startY);
  const scale = useMotionValue(1);
  const grabTilt = useMotionValue(0);
  const shadow = useMotionValue(0);
  const velocityX = useVelocity(x);
  const drift = useSpring(
    useTransform(velocityX, [-TILT_VELOCITY_PX, TILT_VELOCITY_PX], [-TILT_MAX_DEG, TILT_MAX_DEG], { clamp: true }),
    { stiffness: 320, damping: 26, mass: 0.7 },
  );
  const rotate = useTransform(() => (reduced ? 0 : grabTilt.get() + drift.get()));

  useLayoutEffect(() => {
    if (!reduced) {
      animate(scale, 1.04, springTransition('snappy'));
      animate(grabTilt, 1.5, springTransition('snappy'));
      animate(shadow, 1, { duration: 0.16, ease: 'easeOut' });
    }
    onApi({
      track(nextX, nextY) {
        x.set(nextX);
        y.set(nextY);
      },
      flyTo(targetX, targetY, onDone) {
        const spring = springTransition('standard');
        animate(x, targetX, spring);
        animate(y, targetY, { ...spring, onComplete: onDone });
        animate(scale, 1, spring);
        animate(grabTilt, 0, spring);
        animate(shadow, 0, { duration: 0.2, ease: 'easeOut' });
      },
    });
    return () => {
      onApi(null);
    };
  }, [reduced, onApi, x, y, scale, grabTilt, shadow]);

  return createPortal(
    <motion.div
      className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
      style={{ x, y, width: ghost.width }}
    >
      <motion.div className="relative" style={{ scale, rotate }}>
        <motion.div aria-hidden className="absolute inset-0 rounded-m shadow-3" style={{ opacity: shadow }} />
        <CardSurface card={ghost.card} tags={ghost.tags} className="relative" />
      </motion.div>
    </motion.div>,
    document.body,
  );
}
