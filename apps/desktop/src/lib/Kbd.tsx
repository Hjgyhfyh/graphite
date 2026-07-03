import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx';

export type KbdProps = ComponentPropsWithRef<'kbd'>;

export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      className={cx(
        'inline-flex h-[18px] min-w-[18px] select-none items-center justify-center rounded-xs border border-stroke-1 bg-bg-2 px-[5px] font-mono text-micro text-text-1',
        className,
      )}
      {...props}
    />
  );
}
