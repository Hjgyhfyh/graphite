import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Ban, Search, SearchX } from 'lucide-react';
import { STAGGER_CAP, cx } from '@graphite/ui';
import { usePrefersReducedMotion } from '../../motion';
import { ICON_GROUPS, ICON_PALETTE, NoteIcon, resolveIconColor } from './NoteIcon';

export interface IconPickerProps {
  icon?: string;
  color?: string;
  /**
   * Выбор пользователя. Семантика полей: `undefined` — не менять,
   * пустая строка — снять, значение — установить (зеркалит `set_icon`).
   */
  onPick: (icon?: string, color?: string) => void;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorPoint?: { x: number; y: number };
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  mode?: 'full' | 'color';
}

const GROUP_STAGGER_MS = 26;

function matchesQuery(name: string, keywords: string, query: string): boolean {
  return name.toLowerCase().includes(query) || keywords.includes(query);
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
  mode = 'full',
}: IconPickerProps) {
  const reduced = usePrefersReducedMotion();
  const [activeColor, setActiveColor] = useState<string | undefined>(color);
  const [activeIcon, setActiveIcon] = useState<string | undefined>(icon);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setActiveIcon(icon);
  }, [icon]);
  useEffect(() => {
    setActiveColor(color);
  }, [color]);

  const trimmed = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (trimmed.length === 0) {
      return ICON_GROUPS;
    }
    return ICON_GROUPS.map((group) => ({
      ...group,
      icons: group.icons.filter((item) => matchesQuery(item.name, item.keywords, trimmed)),
    })).filter((group) => group.icons.length > 0);
  }, [trimmed]);

  const pickColor = (next: string) => {
    setActiveColor(next);
    onPick(undefined, next);
  };
  const clearColor = () => {
    setActiveColor(undefined);
    onPick(undefined, '');
  };
  const pickIcon = (next: string) => {
    setActiveIcon(next);
    onPick(next, undefined);
  };
  const clearAll = () => {
    setActiveIcon(undefined);
    setActiveColor(undefined);
    onPick('', '');
  };

  const palette = (
    <div className="grid grid-cols-7 gap-1.5">
      <button
        type="button"
        aria-label="Без цвета"
        title="Без цвета"
        onClick={clearColor}
        className={cx(
          'flex size-6 items-center justify-center rounded-full border text-text-2 transition-transform duration-[120ms] hover:scale-110 hover:text-text-0',
          activeColor === undefined ? 'border-text-0' : 'border-stroke-1',
        )}
      >
        <Ban size={12} strokeWidth={1.75} />
      </button>
      {ICON_PALETTE.map((swatch) => {
        const selected = activeColor === swatch.value;
        return (
          <button
            key={swatch.value}
            type="button"
            aria-label={`Цвет «${swatch.label}»`}
            title={swatch.label}
            onClick={() => pickColor(swatch.value)}
            className={cx(
              'relative size-6 rounded-full border transition-transform duration-[120ms] hover:scale-110',
              selected ? 'scale-110 border-text-0' : 'border-stroke-1',
            )}
            style={{ backgroundColor: resolveIconColor(swatch.value) }}
          >
            {selected ? (
              <span aria-hidden className="absolute inset-0 rounded-full border-2 border-bg-2" />
            ) : null}
          </button>
        );
      })}
    </div>
  );

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
            'z-50 origin-(--radix-popover-content-transform-origin) rounded-m border border-stroke-1 bg-bg-2 shadow-3',
            mode === 'color' ? 'w-60 p-3' : 'w-72 p-3',
            reduced ? undefined : 'animate-pop',
          )}
        >
          {mode === 'color' ? (
            <div className="flex flex-col gap-2">
              <p className="text-micro uppercase tracking-wide text-text-3">Цвет папки</p>
              {palette}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-1.5">
                <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-s border border-stroke-1 bg-bg-1 px-2 focus-within:border-accent/50">
                  <Search size={13} strokeWidth={1.75} className="shrink-0 text-text-2" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Поиск иконки…"
                    aria-label="Поиск иконки"
                    className="h-full w-full min-w-0 bg-transparent text-ui text-text-0 outline-none placeholder:text-text-3"
                  />
                </div>
                <button
                  type="button"
                  aria-label="Убрать иконку и цвет"
                  title="Убрать иконку и цвет"
                  onClick={clearAll}
                  className="flex size-7 shrink-0 items-center justify-center rounded-s border border-stroke-1 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-danger"
                >
                  <Ban size={13} strokeWidth={1.75} />
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-micro uppercase tracking-wide text-text-3">Цвет</p>
                {palette}
              </div>

              <div className="relative -mx-1 max-h-60 overflow-y-auto px-1">
                {groups.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                    <SearchX size={18} strokeWidth={1.75} className="text-text-3" />
                    <p className="text-ui text-text-2">Ничего не нашлось</p>
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="rounded-xs px-1.5 py-0.5 text-caption text-accent transition-colors duration-[120ms] hover:bg-bg-3"
                    >
                      Сбросить поиск
                    </button>
                  </div>
                ) : (
                  groups.map((group, index) => (
                    <div
                      key={group.id}
                      className={reduced ? undefined : 'animate-fade-in'}
                      style={
                        reduced
                          ? undefined
                          : { animationDelay: `${Math.min(index, STAGGER_CAP) * GROUP_STAGGER_MS}ms` }
                      }
                    >
                      <p className="sticky top-0 z-10 bg-bg-2 py-1 text-micro uppercase tracking-wide text-text-3">
                        {group.label}
                      </p>
                      <div className="grid grid-cols-8 gap-0.5 pb-1.5">
                        {group.icons.map((item) => {
                          const selected = activeIcon === item.name;
                          return (
                            <button
                              key={item.name}
                              type="button"
                              aria-label={item.name}
                              title={item.keywords.split(' ')[0]}
                              onClick={() => pickIcon(item.name)}
                              className={cx(
                                'flex size-7 items-center justify-center rounded-s transition-[background-color,transform] duration-[120ms] hover:scale-110 hover:bg-bg-3',
                                selected
                                  ? 'bg-accent-dim text-text-0 ring-1 ring-inset ring-accent'
                                  : 'text-text-1',
                              )}
                            >
                              <NoteIcon
                                icon={item.name}
                                color={selected ? activeColor : undefined}
                                size={16}
                              />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
