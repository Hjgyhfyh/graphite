import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Crosshair, Search, X } from 'lucide-react';
import type { NoteRef } from '@graphite/bindings';
import { cx } from '@graphite/ui';
import { rankGraphHits } from '../../lib/graphFind';

export interface GraphCatalogItem {
  ref: NoteRef;
  title: string;
}

interface GraphFindProps {
  catalog: readonly GraphCatalogItem[];
  currentRef: NoteRef | undefined;
  onFocus: (ref: NoteRef) => void;
}

export function GraphFind({ catalog, currentRef, onFocus }: GraphFindProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const hits = useMemo(() => rankGraphHits(query, catalog), [catalog, query]);
  const currentInGraph = currentRef !== undefined && catalog.some((item) => item.ref === currentRef);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      if (wrapRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const pick = (ref: NoteRef): void => {
    onFocus(ref);
    const hit = catalog.find((item) => item.ref === ref);
    if (hit !== undefined) {
      setQuery(hit.title);
    }
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (query.length > 0) {
        setQuery('');
        setOpen(false);
        return;
      }
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowDown' && hits.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === 'ArrowUp' && hits.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (hits.length > 0) {
        pick(hits[Math.min(active, hits.length - 1)].ref);
        return;
      }
      if (currentInGraph && currentRef !== undefined) {
        pick(currentRef);
      }
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5">
      <div className="relative w-56 max-w-[min(16rem,calc(100vw-8rem))]">
        <Search
          size={14}
          strokeWidth={1.75}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
          aria-hidden
        />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Найти на графе…"
          aria-label="Найти заметку на графе"
          aria-expanded={showList}
          aria-autocomplete="list"
          spellCheck={false}
          autoCorrect="off"
          autoComplete="off"
          className="h-8 w-full rounded-full border border-stroke-0 bg-bg-1 pl-8.5 pr-8 text-ui text-text-0 caret-accent transition-colors duration-[120ms] placeholder:text-text-3 hover:border-stroke-1 focus:border-accent/60 focus:bg-bg-2"
        />
        {query.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpen(false);
            }}
            aria-label="Очистить поиск на графе"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-1"
          >
            <X size={12} strokeWidth={2} />
          </button>
        ) : null}
        {showList ? (
          <div
            role="listbox"
            className="absolute right-0 top-[calc(100%+6px)] z-20 w-72 max-w-[min(18rem,calc(100vw-3rem))] overflow-hidden rounded-m border border-stroke-1 bg-bg-2 shadow-3"
          >
            {hits.length === 0 ? (
              <p className="px-3 py-2.5 text-caption text-text-2">Нет узлов с таким названием</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-1">
                {hits.map((hit, index) => (
                  <li key={hit.ref}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(hit.ref)}
                      className={cx(
                        'flex w-full items-center rounded-s px-2.5 py-1.5 text-left text-ui text-text-1',
                        index === active ? 'bg-bg-3 text-text-0' : 'hover:bg-bg-3 hover:text-text-0',
                      )}
                    >
                      <span className="min-w-0 truncate">{hit.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
      {currentInGraph ? (
        <button
          type="button"
          title="Подлететь к открытой заметке"
          aria-label="Показать текущую заметку на графе"
          onClick={() => {
            if (currentRef !== undefined) {
              pick(currentRef);
            }
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-stroke-0 text-text-2 transition-colors duration-[120ms] hover:border-stroke-1 hover:bg-bg-2 hover:text-text-0"
        >
          <Crosshair size={14} strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
