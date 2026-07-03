import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx';

export type InputProps = ComponentPropsWithRef<'input'>;

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cx(
        'h-8 w-full rounded-s border border-stroke-1 bg-bg-2 px-3 text-ui text-text-0 caret-accent transition-colors duration-[120ms] placeholder:text-text-2 disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}
