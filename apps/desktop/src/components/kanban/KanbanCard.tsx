import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, RefObject } from 'react';
import { motion } from 'motion/react';
import { Pin } from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import { NoteIcon } from '../tree/NoteIcon';
import { REDUCED_CROSSFADE, springStandard } from '../../motion';
import { formatUpdated, typeFallbackIcon, typeLabel } from './columns';
import type { KanbanCardData } from './columns';

const tagCache = new Map<string, string[]>();
let coreOffline = false;

function tagKey(ref: string, updated: string): string {
  return `${ref}@${updated}`;
}

function useCardTags(ref: string, updated: string, elementRef: RefObject<HTMLElement | null>): string[] {
  const key = tagKey(ref, updated);
  const [tags, setTags] = useState<string[]>(() => tagCache.get(key) ?? []);

  useEffect(() => {
    const cached = tagCache.get(key);
    if (cached !== undefined) {
      setTags(cached);
      return;
    }
    if (coreOffline) {
      return;
    }
    const element = elementRef.current;
    if (element === null) {
      return;
    }
    let cancelled = false;
    let started = false;

    const load = async () => {
      if (started || coreOffline) {
        return;
      }
      started = true;
      try {
        const response = await commands.noteRead({ ref, maxChars: 1 });
        const raw = response.frontmatter.tags;
        const list = Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === 'string') : [];
        tagCache.set(key, list);
        if (!cancelled) {
          setTags(list);
        }
      } catch (error) {
        if (isGraphiteError(error) && error.code === 'UNAVAILABLE') {
          coreOffline = true;
        } else {
          tagCache.set(key, []);
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
  }, [key, ref, elementRef]);

  return tags;
}

export interface KanbanCardProps {
  card: KanbanCardData;
  reduced: boolean;
  dragging: boolean;
  onDragStart: (ref: string) => void;
  onDragEnd: () => void;
  onOpen: (ref: string) => void;
}

export function KanbanCard({ card, reduced, dragging, onDragStart, onDragEnd, onOpen }: KanbanCardProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const tags = useCardTags(card.ref, card.updated, surfaceRef);
  const updatedLabel = formatUpdated(card.updated);

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.ref);
    onDragStart(card.ref);
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
      layoutId={reduced ? undefined : card.ref}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={reduced ? REDUCED_CROSSFADE : springStandard}
    >
      <div
        ref={surfaceRef}
        role="button"
        tabIndex={0}
        aria-label={`Открыть «${card.title}»`}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
        onClick={() => onOpen(card.ref)}
        onKeyDown={handleKeyDown}
        className={cx(
          'group flex cursor-grab flex-col gap-2 rounded-m border border-stroke-0 bg-bg-1 p-3 shadow-1 outline-none transition-colors duration-[120ms] hover:border-stroke-1 hover:bg-bg-2 focus-visible:border-accent/60 active:cursor-grabbing',
          dragging ? 'opacity-40' : 'opacity-100',
        )}
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
    </motion.div>
  );
}
