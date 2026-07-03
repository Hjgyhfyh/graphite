import { useState } from 'react';
import type { ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Ban } from 'lucide-react';
import { cx } from '@graphite/ui';
import { usePrefersReducedMotion } from '../../motion';
import { ICON_NAMES, NOTE_COLORS, NoteIcon, resolveIconColor } from './NoteIcon';

export interface IconPickerProps {
  icon?: string;
  color?: string;
  onPick: (icon?: string, color?: string) => void;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorPoint?: { x: number; y: number };
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

export function IconPicker({
  icon,
  color,
  onPick,
  children,
  open,
  onOpenChange,
  anchorPoint,
  side = 'right',
  align = 'start',
}: IconPickerProps) {
  const reduced = usePrefersReducedMotion();
  const [activeColor, setActiveColor] = useState<string | undefined>(color);
  const [activeIcon, setActiveIcon] = useState<string | undefined>(icon);

  const pickColor = (next: string) => {
    setActiveColor(next);
    onPick(activeIcon, next);
  };
  const pickIcon = (next: string) => {
    setActiveIcon(next);
    onPick(next, activeColor);
  };
  const clear = () => {
    setActiveIcon(undefined);
    setActiveColor(undefined);
    onPick(undefined, undefined);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {children !== undefined ? <Popover.Trigger asChild>{children}</Popover.Trigger> : null}
      {anchorPoint !== undefined ? (
        <Popover.Anchor asChild>
          <div
            aria-hidden
            style={{ position: 'fixed', left: anchorPoint.x, top: anchorPoint.y, width: 1, height: 1 }}
          />
        </Popover.Anchor>
      ) : null}
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className={cx(
            'z-50 w-64 origin-(--radix-popover-content-transform-origin) rounded-m border border-stroke-1 bg-bg-2 p-3 shadow-3',
            reduced ? undefined : 'animate-pop',
          )}
        >
          <div className="mb-2.5 flex items-center gap-1.5">
            {NOTE_COLORS.map((token) => (
              <button
                key={token}
                type="button"
                aria-label={`Цвет ${token}`}
                onClick={() => pickColor(token)}
                className={cx(
                  'size-5 rounded-full border transition-transform duration-[120ms] hover:scale-110',
                  activeColor === token ? 'border-text-0' : 'border-stroke-1',
                )}
                style={{ backgroundColor: resolveIconColor(token) }}
              />
            ))}
            <button
              type="button"
              aria-label="Убрать иконку и цвет"
              onClick={clear}
              className="ml-auto flex size-5 items-center justify-center rounded-full border border-stroke-1 text-text-2 hover:text-text-0"
            >
              <Ban size={12} strokeWidth={1.75} />
            </button>
          </div>
          <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
            {ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                onClick={() => pickIcon(name)}
                className={cx(
                  'flex size-7 items-center justify-center rounded-s transition-colors duration-[120ms] hover:bg-bg-3',
                  activeIcon === name ? 'bg-bg-3 text-text-0' : 'text-text-1',
                )}
              >
                <NoteIcon icon={name} color={activeIcon === name ? activeColor : undefined} size={16} />
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
