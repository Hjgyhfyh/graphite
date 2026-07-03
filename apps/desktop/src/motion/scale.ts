import type { Variants } from 'motion/react';
import { springs } from '@graphite/ui';
import {
  fadeVariants,
  launchContainerVariants,
  launchItemVariants,
  listContainerVariants,
  listItemVariants,
  pageVariants,
  popVariants,
  slideUpVariants,
  springSnappy,
  springSoft,
  springStandard,
} from './variants';

const SPEED_MIN = 0.5;
const SPEED_MAX = 1.6;

const BASE_SPRINGS = {
  snappy: { ...springs.snappy },
  standard: { ...springs.standard },
  soft: { ...springs.soft },
} as const;

const BASE_DURATIONS = {
  fadeIn: 0.16,
  fadeOut: 0.12,
  popOut: 0.12,
  slideOut: 0.14,
  pageIn: 0.2,
  pageOut: 0.16,
  listOut: 0.1,
  launchItem: 0.22,
} as const;

const BASE_STAGGER = {
  list: 0.022,
  launch: 0.045,
  launchDelay: 0.04,
} as const;

interface SpringLike {
  stiffness: number;
  damping: number;
  mass: number;
}

interface DurationTransition {
  transition: { duration?: number; staggerChildren?: number; delayChildren?: number };
}

function clampSpeed(speed: number): number {
  if (Number.isNaN(speed)) {
    return 1;
  }
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

function scaleSpring(target: SpringLike, base: SpringLike, k: number): void {
  target.stiffness = base.stiffness * k * k;
  target.damping = base.damping * k;
  target.mass = base.mass;
}

function stateOf(variants: Variants, key: string): DurationTransition {
  return variants[key] as unknown as DurationTransition;
}

/**
 * Масштабирует мотион-слой приложения (motion/variants + springSnappy/Standard/Soft)
 * под ползунок скорости из настроек. Компоненты, берущие пружины напрямую из
 * `@graphite/ui` (`springs.*`/`springTransition`), этим ползунком не управляются —
 * у них собственный фиксированный тайминг вне этого слоя.
 */
export function applyMotionSpeed(speed: number): void {
  const k = clampSpeed(speed);
  const scaled = (value: number): number => value / k;

  scaleSpring(springSnappy, BASE_SPRINGS.snappy, k);
  scaleSpring(springStandard, BASE_SPRINGS.standard, k);
  scaleSpring(springSoft, BASE_SPRINGS.soft, k);

  stateOf(fadeVariants, 'animate').transition.duration = scaled(BASE_DURATIONS.fadeIn);
  stateOf(fadeVariants, 'exit').transition.duration = scaled(BASE_DURATIONS.fadeOut);
  stateOf(popVariants, 'exit').transition.duration = scaled(BASE_DURATIONS.popOut);
  stateOf(slideUpVariants, 'exit').transition.duration = scaled(BASE_DURATIONS.slideOut);
  stateOf(pageVariants, 'animate').transition.duration = scaled(BASE_DURATIONS.pageIn);
  stateOf(pageVariants, 'exit').transition.duration = scaled(BASE_DURATIONS.pageOut);
  stateOf(listItemVariants, 'exit').transition.duration = scaled(BASE_DURATIONS.listOut);
  stateOf(launchItemVariants, 'animate').transition.duration = scaled(BASE_DURATIONS.launchItem);

  stateOf(listContainerVariants, 'animate').transition.staggerChildren = scaled(BASE_STAGGER.list);
  const launch = stateOf(launchContainerVariants, 'animate').transition;
  launch.staggerChildren = scaled(BASE_STAGGER.launch);
  launch.delayChildren = scaled(BASE_STAGGER.launchDelay);
}
