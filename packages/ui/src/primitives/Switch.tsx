import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx';

export type SwitchProps = ComponentPropsWithRef<typeof SwitchPrimitive.Root>;

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cx(
        'inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-stroke-1 bg-bg-4 p-[2px] transition-colors duration-[160ms] data-[state=checked]:border-transparent data-[state=checked]:bg-accent disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3 rounded-full bg-text-0 shadow-1 transition-transform duration-[160ms] ease-out data-[state=checked]:translate-x-[14px]" />
    </SwitchPrimitive.Root>
  );
}
