import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, PointerEvent as ReactPointerEvent, Ref, RefObject } from 'react';
import { motion } from 'motion/react';
import { Pin } from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { NoteIcon } from '../tree/NoteIcon';
import { REDUCED_CROSSFADE, springSnappy, springStandard } from '../../motion';
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
  ref?: Ref<HTMLDivElement>;
}

export function CardSurface({ card, tags, className, ref, ...rest }: CardSurfaceProps) {
  const updatedLabel = formatUpdated(card.updated);
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
        <h3 className="line-clamp-2 min-w-0 flex-1 text-ui text-text-0">{card.title}</h3>
        {card.pinned === true ? (
          <Pin size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text-3" aria-hidden />
        ) : null}
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

export interface KanbanCardProps {
  card: KanbanCardData;
  reduced: boolean;
  dragging: boolean;
  settling: boolean;
  onLift(event: ReactPointerEvent<HTMLElement>, card: KanbanCardData, tags: string[]): void;
  onOpen(ref: NoteRef): void;
  consumeDropClick(): boolean;
  registerCard(ref: NoteRef, el: HTMLElement): void;
  unregisterCard(ref: NoteRef, el: HTMLElement): void;
}

export function KanbanCard({
  card,
  reduced,
  dragging,
  settling,
  onLift,
  onOpen,
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
