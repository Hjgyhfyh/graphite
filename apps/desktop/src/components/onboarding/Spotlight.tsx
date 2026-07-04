import { motion } from 'motion/react';
import type { MotionValue } from 'motion/react';

export interface SpotlightProps {
  x: MotionValue<number>;
  y: MotionValue<number>;
  width: MotionValue<number>;
  height: MotionValue<number>;
  radius: MotionValue<number>;
  ringVisible: boolean;
  reduced: boolean;
}

const DIM_SHADOW = '0 0 0 200vmax color-mix(in srgb, var(--bg-0) 76%, transparent)';
const RING_SHADOW = `0 0 0 1px color-mix(in srgb, var(--accent) 65%, transparent), 0 0 0 6px var(--accent-dim), ${DIM_SHADOW}`;

export function Spotlight({ x, y, width, height, radius, ringVisible, reduced }: SpotlightProps) {
  return (
    <motion.div
      aria-hidden
      className="absolute left-0 top-0"
      style={{ x, y, width, height, borderRadius: radius, boxShadow: ringVisible ? RING_SHADOW : DIM_SHADOW }}
    >
      {ringVisible && !reduced ? (
        <>
          <motion.span
            className="absolute inset-0 rounded-[inherit] border border-accent"
            animate={{ opacity: [0.55, 0], scale: [1, 1.4] }}
            transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.45 }}
          />
          <motion.span
            className="absolute inset-0 rounded-[inherit] border border-accent"
            animate={{ opacity: [0.35, 0], scale: [1, 1.7] }}
            transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.45, delay: 0.4 }}
          />
        </>
      ) : null}
    </motion.div>
  );
}
