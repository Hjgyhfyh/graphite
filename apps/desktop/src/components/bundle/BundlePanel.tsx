import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as Popover from '@radix-ui/react-popover';
import { Crown, Layers, Plus, Search, Sparkles, X } from 'lucide-react';
import { Button } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable, GRAPHITE_EVENT } from '@graphite/bindings';
import type { LinkIn, NoteChangedEvent, NoteRef, RelType, SearchHit } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { springSnappy, springStandard, usePrefersReducedMotion } from '../../motion';
import { titleFromRef } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { NoteIcon } from '../tree/NoteIcon';
import { CopyPageButton } from './CopyPageButton';

export interface BundlePanelProps {
  noteRef?: NoteRef;
}

interface NoteMini {
  title: string;
  icon?: string;
  color?: string;
}

interface Composition {
  refs: NoteRef[];
  types: Record<NoteRef, RelType>;
}

const BUNDLE_RELS: RelType[] = ['part_of', 'collected_in'];

const TYPE_LABEL: Record<string, string> = {
  part_of: 'часть',
  collected_in: 'в бандле',
  related: 'связано',
};

function collectMembers(edges: LinkIn[]): Composition {
  const seen = new Set<NoteRef>();
  const refs: NoteRef[] = [];
  const types: Record<NoteRef, RelType> = {};
  for (const edge of edges) {
    if (!seen.has(edge.from)) {
      seen.add(edge.from);
      refs.push(edge.from);
      types[edge.from] = edge.type;
    }
  }
  return { refs, types };
}

interface MemberRowProps {
  title: string;
  icon?: string;
  color?: string;
  typeLabel: string;
  reduced: boolean;
  onOpen: () => void;
  onPrimary: () => void;
  onRemove: () => void;
}

function MemberRow({ title, icon, color, typeLabel, reduced, onOpen, onPrimary, onRemove }: MemberRowProps) {
  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={springSnappy}
      className="group flex items-center gap-1.5 rounded-s border border-stroke-0 bg-bg-2 px-1.5 py-1.5"
    >
      <NoteIcon
        icon={icon}
        color={color}
        size={15}
        className={color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-ui text-text-1 outline-none hover:text-text-0"
      >
        {title}
      </button>
      <span className="shrink-0 rounded-xs bg-bg-3 px-1 text-micro text-text-2">{typeLabel}</span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100">
        <button
          type="button"
          aria-label="Сделать основным"
          title="Сделать основным"
          onClick={onPrimary}
          className="rounded-xs p-1 text-text-2 outline-none hover:bg-bg-3 hover:text-accent"
        >
          <Crown size={13} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Убрать из бандла"
          title="Убрать из бандла"
          onClick={onRemove}
          className="rounded-xs p-1 text-text-2 outline-none hover:bg-bg-3 hover:text-danger"
        >
          <X size={13} strokeWidth={1.75} />
        </button>
      </div>
    </motion.li>
  );
}

export function BundlePanel({ noteRef }: BundlePanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const pushToast = useUiStore((s) => s.pushToast);
  const reduced = usePrefersReducedMotion();

  const [primaryRef, setPrimaryRef] = useState<NoteRef | undefined>(noteRef);
  const [members, setMembers] = useState<NoteRef[]>([]);
  const [typeByRef, setTypeByRef] = useState<Record<NoteRef, RelType>>({});
  const [suggestions, setSuggestions] = useState<NoteRef[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  const nodeByRef = useMemo(() => {
    const map: Record<NoteRef, NoteMini> = {};
    for (const node of tree) {
      map[node.ref] = { title: node.title, icon: node.icon, color: node.iconColor };
    }
    return map;
  }, [tree]);

  const titleOf = (ref: NoteRef): string => nodeByRef[ref]?.title ?? titleFromRef(ref);
  const iconOf = (ref: NoteRef): { icon?: string; color?: string } =>
    iconByRef[ref] ?? { icon: nodeByRef[ref]?.icon, color: nodeByRef[ref]?.color };

  useEffect(() => {
    setPrimaryRef(noteRef);
    setMembers([]);
    setTypeByRef({});
    setSuggestions([]);
    if (noteRef === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const links = await commands.linksGet({ ref: noteRef, direction: 'in', types: BUNDLE_RELS });
        if (!cancelled) {
          const composition = collectMembers(links.in);
          setMembers(composition.refs);
          setTypeByRef(composition.types);
        }
      } catch {
        // ядро ещё не подключено — начинаем с пустого состава
      }
      try {
        const distilled = await commands.distillContext({ ref: noteRef });
        if (!cancelled) {
          setSuggestions(distilled.bundle.filter((item) => item.role !== 'source').map((item) => item.ref));
        }
      } catch {
        if (!cancelled) {
          setSuggestions([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteRef]);

  useEffect(() => {
    if (!isTauriAvailable() || primaryRef === undefined) {
      return;
    }
    let alive = true;
    const reload = async () => {
      try {
        const links = await commands.linksGet({ ref: primaryRef, direction: 'in', types: BUNDLE_RELS });
        if (!alive) {
          return;
        }
        const composition = collectMembers(links.in);
        setMembers(composition.refs);
        setTypeByRef(composition.types);
      } catch {
        // связь недоступна — оставляем текущий состав
      }
    };
    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      if (event.payload.ref === primaryRef) {
        void reload();
      }
    });
    return () => {
      alive = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, [primaryRef]);

  useEffect(() => {
    const text = query.trim();
    if (text.length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      commands.search({ query: text, limit: 8 }).then(
        (response) => {
          if (!cancelled) {
            setHits(response.hits);
          }
        },
        () => {
          if (!cancelled) {
            setHits([]);
          }
        },
      );
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const inBundle = useMemo(
    () => new Set<NoteRef>([primaryRef, ...members].filter((r): r is NoteRef => r !== undefined)),
    [primaryRef, members],
  );

  const syncLink = async (kind: 'add' | 'remove', from: NoteRef, to: NoteRef, type: RelType) => {
    try {
      if (kind === 'add') {
        await commands.linkAdd({ from, to, type });
      } else {
        await commands.linkRemove({ from, to, type });
      }
    } catch (error) {
      if (isGraphiteError(error) && error.code === 'UNAVAILABLE') {
        return;
      }
      pushToast({ kind: 'error', text: isGraphiteError(error) ? error.message : 'Не удалось обновить бандл' });
    }
  };

  const attach = (ref: NoteRef) => {
    if (primaryRef === undefined || inBundle.has(ref)) {
      return;
    }
    setMembers((prev) => [...prev, ref]);
    setTypeByRef((prev) => ({ ...prev, [ref]: 'collected_in' }));
    setAddOpen(false);
    setQuery('');
    setHits([]);
    void syncLink('add', ref, primaryRef, 'collected_in');
  };

  const detach = (ref: NoteRef) => {
    if (primaryRef === undefined) {
      return;
    }
    const type = typeByRef[ref] ?? 'collected_in';
    setMembers((prev) => prev.filter((r) => r !== ref));
    void syncLink('remove', ref, primaryRef, type);
  };

  const makePrimary = (ref: NoteRef) => {
    if (primaryRef === undefined || ref === primaryRef) {
      return;
    }
    const previous = primaryRef;
    const previousType = typeByRef[ref] ?? 'collected_in';
    const others = members.filter((r) => r !== ref);
    setPrimaryRef(ref);
    setMembers([previous, ...others]);
    setTypeByRef((prev) => {
      const next = { ...prev };
      delete next[ref];
      next[previous] = 'collected_in';
      for (const member of others) {
        next[member] = 'collected_in';
      }
      return next;
    });
    void syncLink('remove', ref, previous, previousType);
    void syncLink('add', previous, ref, 'collected_in');
    for (const member of others) {
      void syncLink('remove', member, previous, typeByRef[member] ?? 'collected_in');
      void syncLink('add', member, ref, 'collected_in');
    }
  };

  const saveCollection = () => {
    if (primaryRef === undefined) {
      return;
    }
    void useVaultStore.getState().createBundle({
      title: `${titleOf(primaryRef)} — бандл`,
      members: [primaryRef, ...members],
      instruction: 'Основной файл — инструкция для остальных.',
    });
  };

  const candidates = useMemo(() => {
    if (query.trim().length === 0) {
      return tree
        .filter((node) => !inBundle.has(node.ref))
        .slice(0, 24)
        .map((node) => ({ ref: node.ref, title: node.title }));
    }
    return hits.filter((hit) => !inBundle.has(hit.ref)).map((hit) => ({ ref: hit.ref, title: hit.title }));
  }, [query, tree, hits, inBundle]);

  const suggestable = useMemo(
    () => suggestions.filter((ref) => !inBundle.has(ref)).slice(0, 4),
    [suggestions, inBundle],
  );

  if (noteRef === undefined || primaryRef === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-ui text-text-2">
        Откройте заметку, чтобы собрать бандл
      </div>
    );
  }

  const primaryIcon = iconOf(primaryRef);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-ui text-text-1">
          <Layers size={16} strokeWidth={1.75} className="shrink-0 text-accent" />
          <span>Бандл</span>
          <span className="rounded-full bg-bg-3 px-1.5 py-0.5 text-micro text-text-2">{members.length + 1}</span>
        </div>
        <CopyPageButton noteRef={primaryRef} label="Copy" />
      </div>
      <p className="text-caption text-text-2">Основной файл — инструкция для остальных.</p>

      <div className="flex items-center gap-2 rounded-m border border-accent/30 bg-accent-dim px-2.5 py-2">
        <NoteIcon
          icon={primaryIcon.icon}
          color={primaryIcon.color}
          size={16}
          className={primaryIcon.color === undefined ? 'shrink-0 text-accent' : 'shrink-0'}
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => useVaultStore.getState().openNote(primaryRef)}
            className="block w-full truncate text-left text-ui text-text-0 outline-none"
          >
            {titleOf(primaryRef)}
          </button>
          <span className="text-micro text-accent">Основной · инструкция</span>
        </div>
        <Crown size={14} strokeWidth={1.75} className="shrink-0 text-accent" />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-caption text-text-2">Второстепенные</span>
          <span className="text-micro text-text-3">{members.length}</span>
        </div>
        {members.length > 0 ? (
          <ul className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {members.map((ref) => {
                const info = iconOf(ref);
                return (
                  <MemberRow
                    key={ref}
                    title={titleOf(ref)}
                    icon={info.icon}
                    color={info.color}
                    typeLabel={TYPE_LABEL[typeByRef[ref] ?? 'collected_in'] ?? 'связано'}
                    reduced={reduced}
                    onOpen={() => useVaultStore.getState().openNote(ref)}
                    onPrimary={() => makePrimary(ref)}
                    onRemove={() => detach(ref)}
                  />
                );
              })}
            </AnimatePresence>
          </ul>
        ) : (
          <p className="rounded-s border border-dashed border-stroke-0 px-2.5 py-3 text-center text-caption text-text-2">
            Пока только основной файл. Добавьте связанные заметки ниже.
          </p>
        )}
      </div>

      <Popover.Root
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setQuery('');
            setHits([]);
          }
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-s border border-dashed border-stroke-1 text-ui text-text-1 outline-none transition-colors duration-[120ms] hover:bg-bg-2 hover:text-text-0 data-[state=open]:bg-bg-2 data-[state=open]:text-text-0"
          >
            <Plus size={15} strokeWidth={1.75} />
            Добавить файл
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            className="z-50 w-72 origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2 shadow-3"
          >
            <div className="flex items-center gap-2 rounded-s border border-stroke-1 bg-bg-1 px-2">
              <Search size={14} strokeWidth={1.75} className="shrink-0 text-text-2" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти заметку…"
                className="h-8 w-full bg-transparent text-ui text-text-0 caret-accent outline-none placeholder:text-text-2"
              />
            </div>
            <div className="mt-2 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {candidates.length > 0 ? (
                candidates.map((item) => {
                  const info = iconOf(item.ref);
                  return (
                    <button
                      key={item.ref}
                      type="button"
                      onClick={() => attach(item.ref)}
                      className="flex items-center gap-2 rounded-s px-2 py-1.5 text-left outline-none transition-colors duration-[120ms] hover:bg-bg-3"
                    >
                      <NoteIcon
                        icon={info.icon}
                        color={info.color}
                        size={15}
                        className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                      />
                      <span className="min-w-0 flex-1 truncate text-ui text-text-1">{item.title}</span>
                      <Plus size={13} strokeWidth={1.75} className="shrink-0 text-text-3" />
                    </button>
                  );
                })
              ) : (
                <p className="px-2 py-3 text-center text-caption text-text-2">
                  {query.trim().length > 0 ? 'Ничего не найдено' : 'Нет доступных заметок'}
                </p>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {suggestable.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 px-0.5 text-caption text-text-2">
            <Sparkles size={13} strokeWidth={1.75} className="text-ai" />
            Связанные по смыслу
          </div>
          <AnimatePresence initial={false}>
            {suggestable.map((ref) => {
              const info = iconOf(ref);
              return (
                <motion.button
                  key={ref}
                  type="button"
                  layout
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={springStandard}
                  onClick={() => attach(ref)}
                  className="flex items-center gap-2 rounded-s border border-stroke-0 bg-bg-1 px-1.5 py-1.5 text-left outline-none transition-colors duration-[120ms] hover:border-stroke-1 hover:bg-bg-2"
                >
                  <NoteIcon
                    icon={info.icon}
                    color={info.color}
                    size={15}
                    className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui text-text-1">{titleOf(ref)}</span>
                  <Plus size={13} strokeWidth={1.75} className="shrink-0 text-ai" />
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      ) : null}

      <Button variant="ghost" size="sm" onClick={saveCollection} className="justify-center">
        Сохранить как коллекцию
      </Button>
    </div>
  );
}
