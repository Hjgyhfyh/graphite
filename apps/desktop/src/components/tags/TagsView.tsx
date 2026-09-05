import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import type { Variants } from 'motion/react';
import { ArrowUpRight, Hash, RotateCw, Search, SearchX, Tags, Unplug, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { commands, isTauriAvailable } from '@graphite/bindings';
import type { NoteRef, TagInfo, TreeNode } from '@graphite/bindings';
import { cx } from '@graphite/ui';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { titleFromRef } from '../../stores/tabsStore';
import { NoteIcon } from '../tree/NoteIcon';
import {
  Presence,
  REDUCED_CROSSFADE,
  fadeVariants,
  reducedFadeVariants,
  springSnappy,
  springStandard,
  usePrefersReducedMotion,
} from '../../motion';

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

const PANEL_WIDTH = 336;
const SKELETON_THRESHOLD_MS = 150;
const LAYOUT_ANIMATION_CAP = 180;

/** Палитра облака — только токены темы, чтобы «Бумага» не ловила неоновые hex. */
const TAG_PALETTE: readonly string[] = [
  'var(--accent)',
  'var(--ai)',
  'var(--ok)',
  'var(--warn)',
  'var(--danger)',
  'color-mix(in srgb, var(--accent) 55%, var(--ai))',
  'color-mix(in srgb, var(--accent) 50%, var(--warn))',
  'color-mix(in srgb, var(--ai) 60%, var(--ok))',
  'color-mix(in srgb, var(--danger) 45%, var(--accent))',
  'color-mix(in srgb, var(--ok) 55%, var(--accent))',
  'color-mix(in srgb, var(--warn) 55%, var(--danger))',
  'color-mix(in srgb, var(--text-1) 55%, var(--accent))',
];

/** Детерминированный цвет тега: одинаковый оттенок при каждом открытии. */
function tagColor(tag: string): string {
  let hash = 5381;
  for (let i = 0; i < tag.length; i += 1) {
    hash = ((hash << 5) + hash + tag.charCodeAt(i)) | 0;
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

/** Вес тега 0..1 по количеству заметок, лог-шкала — сглаживает выбросы. */
function tagWeight(count: number, min: number, max: number): number {
  if (max <= min) {
    return 0.55;
  }
  const clamped = Math.min(Math.max(count, min), max);
  return (Math.log(clamped) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

function refToPath(ref: string): string | undefined {
  return ref.startsWith('path:') ? ref.slice('path:'.length) : undefined;
}

function parentDir(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return undefined;
  }
  return normalized.slice(0, idx);
}

function jumpToNote(ref: NoteRef): void {
  useVaultStore.getState().openNote(ref);
  useUiStore.getState().setRailView('tree');
}

const chipVariants: Variants = {
  initial: { opacity: 0, scale: 0.82, y: 10 },
  animate: (index: number) => ({
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { ...springSnappy, delay: Math.min(index * 0.014, 0.34) },
  }),
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.1, ease: EASE_IN } },
};

const notesListVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.14, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_IN } },
};

// Каскад заметок с потолком задержки: длинный список не растягивает появление.
const noteItemVariants: Variants = {
  initial: { opacity: 0, y: -6 },
  animate: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...springSnappy, delay: Math.min(index * 0.022, 0.26) },
  }),
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_IN } },
};

type Phase = 'loading' | 'ready' | 'error' | 'unavailable';

interface TagNote {
  ref: NoteRef;
  title: string;
  icon?: string;
  color?: string;
  dir?: string;
}

interface TagChipProps {
  info: TagInfo;
  weight: number;
  selected: boolean;
  reduced: boolean;
  animateLayout: boolean;
  index: number;
  onToggle: () => void;
}

function TagChip({ info, weight, selected, reduced, animateLayout, index, onToggle }: TagChipProps) {
  const color = tagColor(info.tag);
  const fontSize = 12 + weight * 8;
  const style: CSSProperties = {
    fontSize: `${fontSize.toFixed(1)}px`,
    paddingInline: `${(10 + weight * 5).toFixed(1)}px`,
    paddingBlock: `${(4.5 + weight * 3.5).toFixed(1)}px`,
    color: selected ? color : `color-mix(in srgb, ${color} ${Math.round(52 + weight * 46)}%, var(--text-1))`,
    backgroundColor: selected
      ? `color-mix(in srgb, ${color} 20%, var(--bg-2))`
      : `color-mix(in srgb, ${color} ${Math.round(7 + weight * 9)}%, var(--bg-1))`,
    borderColor: selected
      ? `color-mix(in srgb, ${color} 62%, var(--stroke-0))`
      : `color-mix(in srgb, ${color} ${Math.round(16 + weight * 26)}%, var(--stroke-0))`,
    ['--chip-glow' as string]: `color-mix(in srgb, ${color} ${selected ? 34 : 22}%, transparent)`,
  };
  return (
    <motion.button
      type="button"
      layout={animateLayout ? 'position' : false}
      custom={index}
      variants={reduced ? reducedFadeVariants : chipVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      whileHover={reduced ? undefined : { y: -3, scale: 1.04 }}
      whileTap={reduced ? undefined : { scale: 0.96, y: -1 }}
      transition={springSnappy}
      onClick={onToggle}
      aria-pressed={selected}
      title={`#${info.tag} — ${info.count} ${plural(info.count, 'заметка', 'заметки', 'заметок')}`}
      className={cx(
        'flex select-none items-center gap-[0.45em] rounded-full border font-medium leading-none',
        'transition-[box-shadow,border-color,background-color,color] duration-200',
        selected ? 'shadow-[0_10px_28px_var(--chip-glow)]' : 'shadow-none hover:shadow-[0_8px_22px_var(--chip-glow)]',
      )}
      style={style}
    >
      <Hash size={Math.round(fontSize * 0.82)} strokeWidth={2.25} style={{ color }} className="shrink-0 opacity-80" aria-hidden />
      <span className="max-w-64 truncate">{info.tag}</span>
      <span
        className="rounded-full px-[0.5em] py-[0.22em] text-[0.68em] font-semibold leading-none tabular-nums"
        style={{
          backgroundColor: `color-mix(in srgb, ${color} 16%, var(--bg-0))`,
          color: `color-mix(in srgb, ${color} 75%, var(--text-1))`,
        }}
      >
        {info.count}
      </span>
    </motion.button>
  );
}

interface CloudStateProps {
  icon: LucideIcon;
  title: string;
  hint: ReactNode;
  action?: ReactNode;
}

function CloudState({ icon: Icon, title, hint, action }: CloudStateProps) {
  return (
    <div className="flex h-full min-h-70 flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-stroke-0 bg-bg-1 text-text-2">
        <Icon size={22} strokeWidth={1.6} />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-ui text-text-1">{title}</p>
        <p className="text-caption text-text-2">{hint}</p>
      </div>
      {action}
    </div>
  );
}

function CloudSkeleton({ reduced }: { reduced: boolean }) {
  const widths = [88, 64, 116, 72, 96, 58, 128, 80, 68, 104, 76, 92, 60, 112, 84, 70];
  return (
    <div className="flex flex-wrap content-start items-center gap-2.5 pt-1" aria-hidden>
      {widths.map((width, index) => (
        <motion.span
          key={index}
          className="h-8 rounded-full bg-bg-2"
          style={{ width }}
          animate={reduced ? undefined : { opacity: [0.45, 0.85, 0.45] }}
          transition={reduced ? undefined : { duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: index * 0.05 }}
        />
      ))}
    </div>
  );
}

interface TagNotesPanelProps {
  info: TagInfo;
  notes: TagNote[];
  reduced: boolean;
  onClose: () => void;
}

function TagNotesPanel({ info, notes, reduced, onClose }: TagNotesPanelProps) {
  const color = tagColor(info.tag);
  return (
    <motion.aside
      aria-label={`Заметки с тегом ${info.tag}`}
      initial={reduced ? { opacity: 0 } : { width: 0, opacity: 0 }}
      animate={
        reduced
          ? { opacity: 1, transition: REDUCED_CROSSFADE }
          : { width: PANEL_WIDTH, opacity: 1, transition: { width: springStandard, opacity: { duration: 0.18, ease: EASE_OUT } } }
      }
      exit={
        reduced
          ? { opacity: 0, transition: REDUCED_CROSSFADE }
          : {
              width: 0,
              opacity: 0,
              transition: { width: { duration: 0.18, ease: EASE_IN }, opacity: { duration: 0.14, ease: EASE_IN } },
            }
      }
      className="relative shrink-0 overflow-hidden border-l border-stroke-0 bg-bg-1/40"
    >
      <div className="flex h-full flex-col" style={{ width: PANEL_WIDTH }}>
        <div className="flex items-center gap-2.5 border-b border-stroke-0 px-4 py-3">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-s border"
            style={{
              color,
              backgroundColor: `color-mix(in srgb, ${color} 16%, var(--bg-2))`,
              borderColor: `color-mix(in srgb, ${color} 38%, var(--stroke-0))`,
            }}
          >
            <Hash size={14} strokeWidth={2.25} aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui font-medium text-text-0">#{info.tag}</span>
            <span className="text-micro text-text-3">
              {notes.length} {plural(notes.length, 'заметка', 'заметки', 'заметок')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть список заметок"
            className="rounded-s p-1.5 text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-1"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <Presence mode="wait">
          <motion.ul
            key={info.tag}
            variants={reduced ? reducedFadeVariants : notesListVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
          >
            {notes.length === 0 ? (
              <li className="px-2.5 py-3 text-caption text-text-3">Заметки этого тега не нашлись в дереве.</li>
            ) : (
              notes.map((note, index) => (
                <motion.li key={note.ref} custom={index} variants={reduced ? reducedFadeVariants : noteItemVariants}>
                  <button
                    type="button"
                    onClick={() => jumpToNote(note.ref)}
                    title={refToPath(note.ref) ?? note.title}
                    className="group flex w-full items-center gap-2.5 rounded-m px-2.5 py-2 text-left transition-colors duration-[120ms] hover:bg-bg-2"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 text-text-2">
                      <NoteIcon icon={note.icon} color={note.color} size={15} fallback="FileText" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-ui text-text-0">{note.title}</span>
                      {note.dir !== undefined ? <span className="truncate text-micro text-text-3">{note.dir}</span> : null}
                    </span>
                    <ArrowUpRight
                      size={14}
                      strokeWidth={1.75}
                      className="shrink-0 text-text-3 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                      aria-hidden
                    />
                  </button>
                </motion.li>
              ))
            )}
          </motion.ul>
        </Presence>
      </div>
    </motion.aside>
  );
}

export function TagsView() {
  const reduced = usePrefersReducedMotion();
  const tree = useVaultStore((s) => s.tree);
  const childrenByRef = useVaultStore((s) => s.childrenByRef);
  const iconByRef = useVaultStore((s) => s.iconByRef);

  const [tags, setTags] = useState<TagInfo[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [skeletonVisible, setSkeletonVisible] = useState(false);
  const seqRef = useRef(0);
  const pendingTag = useUiStore((s) => s.pendingTag);

  const load = useCallback(async () => {
    if (!isTauriAvailable()) {
      setPhase('unavailable');
      return;
    }
    const seq = (seqRef.current += 1);
    setPhase((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    try {
      const list = await commands.tagsList();
      if (seq !== seqRef.current) {
        return;
      }
      setTags(list);
      setPhase('ready');
    } catch {
      if (seq !== seqRef.current) {
        return;
      }
      // Данные уже были — тихо оставляем облако; иначе показываем экран ошибки.
      setPhase((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  // Первичная загрузка + перезагрузка после каждого обновления дерева (note_changed → loadTree).
  useEffect(() => {
    void load();
  }, [load, tree]);

  // Гард от сеттеров после размонтирования: «протухают» все запросы в полёте.
  useEffect(
    () => () => {
      seqRef.current += 1;
    },
    [],
  );

  const loadingFirst = phase === 'loading' && tags.length === 0;
  useEffect(() => {
    if (!loadingFirst) {
      setSkeletonVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setSkeletonVisible(true), SKELETON_THRESHOLD_MS);
    return () => window.clearTimeout(timer);
  }, [loadingFirst]);

  // Если после перезагрузки выбранный тег исчез (заметки переразметили) — мягко закрываем панель.
  useEffect(() => {
    if (selected !== undefined && phase === 'ready' && !tags.some((t) => t.tag === selected)) {
      setSelected(undefined);
    }
  }, [tags, phase, selected]);

  useEffect(() => {
    if (pendingTag === undefined || phase === 'loading') {
      return;
    }
    const raw = useUiStore.getState().consumePendingTag();
    if (raw === undefined) {
      return;
    }
    const needle = raw.replace(/^#+/, '').trim();
    if (needle.length === 0) {
      return;
    }
    const hit = tags.find((t) => t.tag.toLocaleLowerCase('ru') === needle.toLocaleLowerCase('ru'));
    if (hit !== undefined) {
      setSelected(hit.tag);
      setQuery('');
    } else {
      setSelected(undefined);
      setQuery(needle);
    }
  }, [pendingTag, phase, tags]);

  const nodeByRef = useMemo(() => {
    const map = new Map<NoteRef, TreeNode>();
    for (const node of tree) {
      map.set(node.ref, node);
    }
    for (const nodes of Object.values(childrenByRef)) {
      for (const node of nodes) {
        map.set(node.ref, node);
      }
    }
    return map;
  }, [tree, childrenByRef]);

  const filtered = useMemo(() => {
    const q = query.trim().replace(/^#+/, '').toLowerCase();
    const base = q.length === 0 ? tags : tags.filter((t) => t.tag.toLowerCase().includes(q));
    return [...base].sort((a, b) => a.tag.localeCompare(b.tag, 'ru'));
  }, [tags, query]);

  // Диапазон весов считаем по всем тегам, а не по отфильтрованным:
  // размеры чипов не «дышат» при наборе фильтра.
  const [minCount, maxCount] = useMemo(() => {
    let min = Infinity;
    let max = 1;
    for (const t of tags) {
      min = Math.min(min, t.count);
      max = Math.max(max, t.count);
    }
    return [min === Infinity ? 1 : Math.max(1, min), Math.max(1, max)];
  }, [tags]);

  const taggedTotal = useMemo(() => {
    const set = new Set<NoteRef>();
    for (const t of tags) {
      for (const ref of t.refs) {
        set.add(ref);
      }
    }
    return set.size;
  }, [tags]);

  const selectedInfo = useMemo(
    () => (selected === undefined ? undefined : tags.find((t) => t.tag === selected)),
    [tags, selected],
  );

  const selectedNotes = useMemo<TagNote[]>(() => {
    if (selectedInfo === undefined) {
      return [];
    }
    return selectedInfo.refs
      .map((ref) => {
        const node = nodeByRef.get(ref);
        const iconInfo = iconByRef[ref];
        const rawTitle = node?.title ?? titleFromRef(ref);
        return {
          ref,
          title: rawTitle.trim().length > 0 ? rawTitle : 'Без названия',
          icon: iconInfo?.icon ?? node?.icon,
          color: iconInfo?.color ?? node?.iconColor,
          dir: node !== undefined ? parentDir(node.path) : parentDir(refToPath(ref)),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  }, [selectedInfo, nodeByRef, iconByRef]);

  const toggleTag = useCallback((tag: string) => {
    setSelected((prev) => (prev === tag ? undefined : tag));
  }, []);

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        const first = filtered[0];
        if (first !== undefined) {
          setSelected(first.tag);
        }
      } else if (event.key === 'Escape') {
        if (query.length > 0) {
          setQuery('');
        } else if (selected !== undefined) {
          setSelected(undefined);
        }
      }
    },
    [filtered, query, selected],
  );

  const animateLayout = !reduced && filtered.length <= LAYOUT_ANIMATION_CAP;

  let cloudKey: string;
  let cloudNode: ReactNode;
  if (phase === 'unavailable') {
    cloudKey = 'unavailable';
    cloudNode = (
      <CloudState
        icon={Unplug}
        title="Ядро ещё не подключено"
        hint="Запустите Graphite как приложение — теги подтянутся из хранилища."
      />
    );
  } else if (phase === 'error' && tags.length === 0) {
    cloudKey = 'error';
    cloudNode = (
      <CloudState
        icon={Tags}
        title="Не удалось загрузить теги"
        hint="Что-то пошло не так при чтении индекса. Попробуйте ещё раз."
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-stroke-1 bg-bg-2 px-3 py-1.5 text-ui text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
          >
            <RotateCw size={13} strokeWidth={1.75} />
            Повторить
          </button>
        }
      />
    );
  } else if (loadingFirst) {
    cloudKey = 'skeleton';
    cloudNode = skeletonVisible ? <CloudSkeleton reduced={reduced} /> : <div aria-hidden />;
  } else if (tags.length === 0) {
    cloudKey = 'empty';
    cloudNode = (
      <CloudState
        icon={Tags}
        title="Пока нет тегов"
        hint={
          <>
            Добавьте в frontmatter{' '}
            <code className="rounded-xs bg-bg-2 px-1 py-0.5 font-mono text-[11px] text-text-1">tags: [..]</code> или{' '}
            <code className="rounded-xs bg-bg-2 px-1 py-0.5 font-mono text-[11px] text-text-1">#тег</code> в тексте — и
            здесь расцветёт облако.
          </>
        }
        action={
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2" aria-hidden>
            {['идея', 'проект', 'книги'].map((example) => (
              <span
                key={example}
                className="rounded-full border border-dashed border-stroke-1 px-3 py-1 text-caption text-text-3"
              >
                #{example}
              </span>
            ))}
          </div>
        }
      />
    );
  } else if (filtered.length === 0) {
    cloudKey = 'no-results';
    cloudNode = (
      <CloudState
        icon={SearchX}
        title="Ничего не нашлось"
        hint={`По запросу «${query.trim()}» тегов нет.`}
        action={
          <button
            type="button"
            onClick={() => setQuery('')}
            className="mt-1 rounded-full border border-stroke-1 bg-bg-2 px-3 py-1.5 text-ui text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
          >
            Сбросить фильтр
          </button>
        }
      />
    );
  } else {
    cloudKey = 'cloud';
    cloudNode = (
      <div className="flex flex-wrap content-start items-center gap-2.5 pt-1">
        <Presence mode="popLayout" initial>
          {filtered.map((info, index) => (
            <TagChip
              key={info.tag}
              info={info}
              weight={tagWeight(info.count, minCount, maxCount)}
              selected={info.tag === selected}
              reduced={reduced}
              animateLayout={animateLayout}
              index={index}
              onToggle={() => toggleTag(info.tag)}
            />
          ))}
        </Presence>
      </div>
    );
  }

  return (
    <main aria-label="Браузер тегов" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-8 pb-5 pt-8">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-h2 text-text-0">Теги</h1>
          {phase === 'ready' && tags.length > 0 ? (
            <span className="text-caption text-text-3">
              {tags.length} {plural(tags.length, 'тег', 'тега', 'тегов')} · {taggedTotal}{' '}
              {plural(taggedTotal, 'заметка', 'заметки', 'заметок')}
            </span>
          ) : null}
        </div>
        <div className="relative w-72 max-w-full">
          <Search
            size={14}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Фильтр тегов…"
            aria-label="Фильтр тегов"
            spellCheck={false}
            autoCorrect="off"
            autoComplete="off"
            className="h-8 w-full rounded-full border border-stroke-0 bg-bg-1 pl-8.5 pr-8 text-ui text-text-0 caret-accent transition-colors duration-[120ms] placeholder:text-text-3 hover:border-stroke-1 focus:border-accent/60 focus:bg-bg-2"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Очистить фильтр"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-1"
            >
              <X size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-10">
          <Presence mode="wait">
            <motion.div
              key={cloudKey}
              variants={reduced ? reducedFadeVariants : fadeVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="h-full"
            >
              {cloudNode}
            </motion.div>
          </Presence>
        </div>
        <Presence>
          {selectedInfo !== undefined ? (
            <TagNotesPanel
              key="tag-notes-panel"
              info={selectedInfo}
              notes={selectedNotes}
              reduced={reduced}
              onClose={() => setSelected(undefined)}
            />
          ) : null}
        </Presence>
      </div>
    </main>
  );
}
