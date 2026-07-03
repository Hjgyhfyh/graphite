import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Search, X } from 'lucide-react';
import { Tooltip, TooltipProvider, cx } from '@graphite/ui';
import {
  ACTIONS,
  eventToChord,
  formatBinding,
  formatChord,
  useKeybindingsStore,
} from '../../stores/keybindingsStore';
import type { ActionGroup, ActionId } from '../../stores/keybindingsStore';

const GROUP_ORDER: readonly ActionGroup[] = ['Навигация', 'Заметки', 'Редактор', 'Вкладки и панели', 'Прочее'];

const MAX_CHORDS = 3;

const ACTION_TITLE = Object.fromEntries(
  ACTIONS.map((action) => [action.id, action.title] as const),
) as Record<ActionId, string>;

interface Recording {
  id: ActionId;
  index: number;
}

export function KeybindingsEditor() {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const resetBinding = useKeybindingsStore((s) => s.resetBinding);
  const resetAll = useKeybindingsStore((s) => s.resetAll);
  const [recording, setRecording] = useState<Recording | undefined>(undefined);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (recording === undefined) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setRecording(undefined);
        return;
      }
      const chord = eventToChord(event);
      if (chord === null) {
        return;
      }
      const current = useKeybindingsStore.getState().bindings[recording.id] ?? [];
      const next = [...current];
      next[recording.index] = chord;
      const deduped = next.filter((value, index) => value !== undefined && next.indexOf(value) === index);
      setBinding(recording.id, deduped);
      setRecording(undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [recording, setBinding]);

  const chordOwners = useMemo(() => {
    const map = new Map<string, ActionId[]>();
    for (const action of ACTIONS) {
      for (const chord of bindings[action.id] ?? []) {
        const owners = map.get(chord) ?? [];
        owners.push(action.id);
        map.set(chord, owners);
      }
    }
    return map;
  }, [bindings]);

  const conflictCount = useMemo(() => {
    let total = 0;
    for (const owners of chordOwners.values()) {
      if (owners.length > 1) {
        total += 1;
      }
    }
    return total;
  }, [chordOwners]);

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (id: ActionId, title: string): boolean =>
    normalizedQuery === '' ||
    title.toLowerCase().includes(normalizedQuery) ||
    formatBinding(bindings[id] ?? []).toLowerCase().includes(normalizedQuery);

  const toggleRecording = (id: ActionId, index: number) => {
    setRecording((current) =>
      current !== undefined && current.id === id && current.index === index ? undefined : { id, index },
    );
  };

  const removeChord = (id: ActionId, index: number) => {
    setBinding(
      id,
      (bindings[id] ?? []).filter((_, itemIndex) => itemIndex !== index),
    );
  };

  const groups = GROUP_ORDER.map((group) => ({
    group,
    rows: ACTIONS.filter((action) => action.group === group && matches(action.id, action.title)),
  })).filter((entry) => entry.rows.length > 0);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-text-2">
            {recording !== undefined
              ? 'Нажмите сочетание клавиш…  ·  Esc — отмена'
              : 'Нажмите на сочетание, чтобы переназначить'}
          </p>
          <button
            type="button"
            onClick={() => resetAll()}
            className="inline-flex items-center gap-1.5 text-caption text-text-1 transition-colors duration-[120ms] hover:text-text-0"
          >
            <RotateCcw size={12} strokeWidth={1.75} />
            Сбросить всё
          </button>
        </div>

        <div className="relative">
          <Search
            size={14}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-2"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск действия или сочетания…"
            className="h-8 w-full rounded-s border border-stroke-1 bg-bg-2 pl-8 pr-3 text-ui text-text-0 caret-accent transition-colors duration-[120ms] placeholder:text-text-2"
          />
        </div>

        {conflictCount > 0 ? (
          <div className="flex items-center gap-2 rounded-s border border-warn/40 bg-warn/10 px-3 py-2 text-caption text-text-1">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
            {conflictCount === 1
              ? 'Есть пересечение: одно сочетание назначено на два действия'
              : `Пересечений: ${conflictCount} — сочетания заняты несколькими действиями`}
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="rounded-s border border-dashed border-stroke-1 px-4 py-6 text-center text-caption text-text-2">
            Ничего не найдено
          </div>
        ) : (
          groups.map(({ group, rows }) => (
            <section key={group} className="flex flex-col gap-0.5">
              <h3 className="px-2 pb-1 pt-1 text-micro uppercase tracking-wide text-text-2">{group}</h3>
              {rows.map((action) => {
                const chords = bindings[action.id] ?? [];
                const appending = recording?.id === action.id && recording.index >= chords.length;
                return (
                  <div
                    key={action.id}
                    className="group flex min-h-9 items-center gap-3 rounded-s px-2 py-1 transition-colors duration-[120ms] hover:bg-bg-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-ui text-text-1">{action.title}</span>
                    <div className="flex items-center gap-1.5">
                      {chords.length === 0 && recording?.id !== action.id ? (
                        <button
                          type="button"
                          onClick={() => toggleRecording(action.id, 0)}
                          className="inline-flex h-7 items-center rounded-s border border-dashed border-stroke-1 px-2.5 text-micro text-text-2 transition-colors duration-[120ms] hover:border-stroke-1 hover:text-text-0"
                        >
                          Назначить
                        </button>
                      ) : null}

                      {chords.map((chord, index) => {
                        const isRecording = recording?.id === action.id && recording.index === index;
                        const owners = chordOwners.get(chord) ?? [];
                        const conflicted = owners.length > 1;
                        const pill = (
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleRecording(action.id, index)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleRecording(action.id, index);
                              }
                            }}
                            className={cx(
                              'group/pill relative inline-flex h-7 cursor-pointer select-none items-center gap-1 rounded-s border pl-2 pr-1 transition-colors duration-[120ms]',
                              isRecording
                                ? 'border-accent bg-accent-dim'
                                : conflicted
                                  ? 'border-warn/60 bg-warn/10 hover:border-warn'
                                  : 'border-stroke-1 bg-bg-2 hover:bg-bg-3',
                            )}
                          >
                            {isRecording ? (
                              <span className="px-0.5 text-micro text-text-2">Нажмите…</span>
                            ) : (
                              <span className="whitespace-nowrap px-0.5 font-mono text-micro text-text-1">
                                {formatChord(chord)}
                              </span>
                            )}
                            {!isRecording ? (
                              <button
                                type="button"
                                aria-label="Убрать сочетание"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeChord(action.id, index);
                                }}
                                className="flex size-4 items-center justify-center rounded-xs text-text-3 opacity-0 transition-opacity duration-[120ms] hover:text-text-0 group-hover/pill:opacity-100"
                              >
                                <X size={11} strokeWidth={2} />
                              </button>
                            ) : null}
                          </div>
                        );
                        return conflicted && !isRecording ? (
                          <Tooltip
                            key={`${action.id}-${index}`}
                            content={`Также назначено: ${owners
                              .filter((owner) => owner !== action.id)
                              .map((owner) => ACTION_TITLE[owner])
                              .join(', ')}`}
                          >
                            {pill}
                          </Tooltip>
                        ) : (
                          <span key={`${action.id}-${index}`}>{pill}</span>
                        );
                      })}

                      {appending ? (
                        <span className="inline-flex h-7 items-center rounded-s border border-accent bg-accent-dim px-2.5 text-micro text-text-2">
                          Нажмите…
                        </span>
                      ) : null}

                      {recording?.id !== action.id && chords.length > 0 && chords.length < MAX_CHORDS ? (
                        <button
                          type="button"
                          aria-label="Добавить сочетание"
                          onClick={() => toggleRecording(action.id, chords.length)}
                          className="flex size-7 items-center justify-center rounded-s border border-dashed border-stroke-1 text-text-3 opacity-0 transition-[opacity,color] duration-[120ms] hover:text-text-1 group-hover:opacity-100"
                        >
                          <Plus size={13} strokeWidth={1.75} />
                        </button>
                      ) : null}

                      <button
                        type="button"
                        aria-label="Сбросить по умолчанию"
                        onClick={() => resetBinding(action.id)}
                        className="flex size-7 items-center justify-center rounded-s text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-1"
                      >
                        <RotateCcw size={13} strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>
    </TooltipProvider>
  );
}
