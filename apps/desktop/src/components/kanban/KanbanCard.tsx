import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref, RefObject } from 'react';
import { motion } from 'motion/react';
import * as Popover from '@radix-ui/react-popover';
import { PenLine, Pin } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { NoteIcon } from '../tree/NoteIcon';
import { highlightNameParts } from '../../lib/treeFilter';
import { REDUCED_CROSSFADE, springSnappy, springStandard } from '../../motion';
import { CARD_ALIAS_MAX } from '../../stores/boardStore';
import { formatUpdated, typeFallbackIcon, typeLabel } from './columns';
import type { KanbanCardData } from './columns';

interface TagCacheEntry {
  updated: string;
  tags: string[];
}

const tagCache = new Map<string, TagCacheEntry>();
const CORE_RETRY_MS = 15_000;
let coreOfflineUntil = 0;

function cachedTags(ref: string, updated: string): string[] | undefined {
  const entry = tagCache.get(ref);
  return entry !== undefined && entry.updated === updated ? entry.tags : undefined;
}

function useCardTags(ref: string, updated: string, elementRef: RefObject<HTMLElement | null>): string[] {
  const [tags, setTags] = useState<string[]>(() => cachedTags(ref, updated) ?? []);

  useEffect(() => {
    const cached = cachedTags(ref, updated);
    if (cached !== undefined) {
      setTags(cached);
      return;
    }
    if (Date.now() < coreOfflineUntil) {
      return;
    }
    const element = elementRef.current;
    if (element === null) {
      return;
    }
    let cancelled = false;
    let started = false;

    const load = async () => {
      if (started || Date.now() < coreOfflineUntil) {
        return;
      }
      started = true;
      try {
        const response = await commands.noteRead({ ref, maxChars: 1 });
        const raw = response.frontmatter.tags;
        const list = Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === 'string') : [];
        tagCache.set(ref, { updated, tags: list });
        if (!cancelled) {
          setTags(list);
        }
      } catch (error) {
        if (isGraphiteError(error) && error.code === 'UNAVAILABLE') {
          coreOfflineUntil = Date.now() + CORE_RETRY_MS;
        } else {
          tagCache.set(ref, { updated, tags: [] });
        }
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            void load();
            break;
          }
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ref, updated, elementRef]);

  return tags;
}

export interface CardSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  card: KanbanCardData;
  tags: string[];
  titleAction?: ReactNode;
  filterNeedle?: string;
  ref?: Ref<HTMLDivElement>;
}

function HighlightText({ text, needle }: { text: string; needle: string }) {
  if (needle.length === 0) {
    return text;
  }
  return highlightNameParts(text, needle).map((part, index) =>
    part.hit ? (
      <mark key={index} className="rounded-xs bg-accent/20 text-inherit">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

export function CardSurface({ card, tags, titleAction, filterNeedle = '', className, ref, ...rest }: CardSurfaceProps) {
  const updatedLabel = formatUpdated(card.updated);
  const shown = card.alias ?? card.title;
  return (
    <div
      ref={ref}
      className={cx(
        'group flex select-none flex-col gap-2 rounded-m border border-stroke-0 bg-bg-1 p-3 shadow-1 outline-none',
        className,
      )}
      {...rest}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0">
          <NoteIcon icon={card.icon} color={card.iconColor} size={15} fallback={typeFallbackIcon(card.type)} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-ui text-text-0">
            <HighlightText text={shown} needle={filterNeedle} />
          </h3>
          {card.alias !== undefined ? (
            <p className="mt-0.5 line-clamp-1 text-micro text-text-3">
              <HighlightText text={card.title} needle={filterNeedle} />
            </p>
          ) : null}
        </div>
        {card.pinned === true ? (
          <Pin size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text-3" aria-hidden />
        ) : null}
        {titleAction}
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="inline-flex max-w-full items-center truncate rounded-full bg-bg-3 px-1.5 py-0.5 text-micro text-text-2"
            >
              #{tag}
            </span>
          ))}
          {tags.length > 4 ? <span className="text-micro text-text-3">+{tags.length - 4}</span> : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-0.5 text-micro text-text-3">
        <span className="truncate">{typeLabel(card.type)}</span>
        {updatedLabel.length > 0 ? <span className="shrink-0">{updatedLabel}</span> : null}
      </div>
    </div>
  );
}

interface CardAliasButtonProps {
  card: KanbanCardData;
  onAliasChange(ref: NoteRef, alias: string): void;
}

function CardAliasButton({ card, onAliasChange }: CardAliasButtonProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(card.alias ?? '');
    }
    setOpen(next);
  };

  const commit = () => {
    onAliasChange(card.ref, draft);
    setOpen(false);
  };

  const clear = () => {
    onAliasChange(card.ref, '');
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip content="Подпись на доске">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Подпись для «${card.title}»`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className={cx(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs transition-[color,opacity,background-color] duration-[120ms] hover:bg-bg-3 hover:text-text-0',
              open
                ? 'bg-bg-3 text-text-0 opacity-100'
                : 'text-text-3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
            )}
          >
            <PenLine size={12} strokeWidth={1.75} />
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        {/* Портал рендерится в body, но React-события всплывают по дереву компонентов
            до кликабельной карточки — гасим их, чтобы ввод не открывал заметку. */}
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="z-50 w-64 origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2.5 shadow-3"
        >
          <p className="text-micro uppercase tracking-wide text-text-3">Подпись на доске</p>
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit();
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
            maxLength={CARD_ALIAS_MAX}
            placeholder={card.title}
            aria-label="Подпись карточки"
            className="mt-1.5 h-7 w-full rounded-s border border-stroke-1 bg-bg-1 px-2 text-ui text-text-0 outline-none placeholder:text-text-3 focus:border-accent/50"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-micro text-text-3">Видна только на доске</span>
            <div className="flex items-center gap-1">
              {card.alias !== undefined ? (
                <button
                  type="button"
                  onClick={clear}
                  className="rounded-xs px-1.5 py-0.5 text-caption text-text-2 transition-colors duration-[120ms] hover:bg-danger/10 hover:text-danger"
                >
                  Убрать
                </button>
              ) : null}
              <button
                type="button"
                onClick={commit}
                className="rounded-xs px-1.5 py-0.5 text-caption text-accent transition-colors duration-[120ms] hover:bg-accent/10"
              >
                Сохранить
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export interface KanbanCardProps {
  card: KanbanCardData;
  reduced: boolean;
  dragging: boolean;
  settling: boolean;
  filterNeedle?: string;
  onLift(event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]): void;
  onOpen(ref: NoteRef): void;
  onAliasChange(ref: NoteRef, alias: string): void;
  consumeDropClick(): boolean;
  registerCard(ref: NoteRef, el: HTMLElement): void;
  unregisterCard(ref: NoteRef, el: HTMLElement): void;
}

export function KanbanCard({
  card,
  reduced,
  dragging,
  settling,
  filterNeedle = '',
  onLift,
  onOpen,
  onAliasChange,
  consumeDropClick,
  registerCard,
  unregisterCard,
}: KanbanCardProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const tags = useCardTags(card.ref, card.updated, surfaceRef);

  const attachSurface = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        return;
      }
      surfaceRef.current = node;
      registerCard(card.ref, node);
      return () => {
        unregisterCard(card.ref, node);
        if (surfaceRef.current === node) {
          surfaceRef.current = null;
        }
      };
    },
    [card.ref, registerCard, unregisterCard],
  );

  const handleClick = () => {
    if (!consumeDropClick()) {
      onOpen(card.ref);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(card.ref);
    }
  };

  return (
    <motion.div
      layout={!reduced}
      initial={settling ? false : reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={reduced ? REDUCED_CROSSFADE : { ...springStandard, layout: springSnappy }}
      style={settling ? { visibility: 'hidden' } : undefined}
    >
      <CardSurface
        ref={attachSurface}
        card={card}
        tags={tags}
        filterNeedle={filterNeedle}
        titleAction={<CardAliasButton card={card} onAliasChange={onAliasChange} />}
        role="button"
        tabIndex={0}
        aria-label={`Открыть «${card.title}»`}
        onPointerDown={(event) => onLift(event, card, tags)}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cx(
          'cursor-grab touch-none transition-[border-color,background-color,opacity] duration-[120ms] hover:border-stroke-1 hover:bg-bg-2 focus-visible:border-accent/60 active:cursor-grabbing',
          dragging ? 'opacity-40' : 'opacity-100',
        )}
      />
    </motion.div>
  );
}
