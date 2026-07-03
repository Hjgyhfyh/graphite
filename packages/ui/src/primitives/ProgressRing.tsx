import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx';

export interface ProgressRingProps extends Omit<ComponentPropsWithRef<'svg'>, 'children'> {
  value: number;
  size?: number;
  strokeWidth?: number;
}

export function ProgressRing({ value, size = 16, strokeWidth = 2, className, ...props }: ProgressRingProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label="Зрелость"
      className={cx('shrink-0 text-accent', className)}
      {...props}
    >
      <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--stroke-1)" strokeWidth={strokeWidth} />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1"
        strokeDashoffset={1 - clamped}
        transform={`rotate(-90 ${center} ${center})`}
        style={{
          opacity: clamped === 0 ? 0 : 1,
          transition: 'stroke-dashoffset 300ms var(--ease-out), opacity 300ms var(--ease-out)',
        }}
      />
    </svg>
  );
}
