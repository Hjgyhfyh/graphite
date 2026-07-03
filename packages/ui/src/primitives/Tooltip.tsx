import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cx } from '../cx';
import { TOOLTIP_DELAY_MS } from '../motion';

export interface TooltipProviderProps {
  children: ReactNode;
  delayMs?: number;
  skipDelayMs?: number;
}

export function TooltipProvider({ children, delayMs = TOOLTIP_DELAY_MS, skipDelayMs = 250 }: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayMs} skipDelayDuration={skipDelayMs}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayMs?: number;
  sideOffset?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delayMs = TOOLTIP_DELAY_MS,
  sideOffset = 6,
  className,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={delayMs}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cx(
            'z-50 max-w-[260px] origin-(--radix-tooltip-content-transform-origin) animate-pop select-none rounded-s border border-stroke-1 bg-bg-2 px-2.5 py-1 text-caption text-text-0 shadow-2',
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
