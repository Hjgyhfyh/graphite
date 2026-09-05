import { Component, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ErrorInfo,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  Clock,
  File as FileIcon,
  FileText,
  FolderClosed,
  FolderKanban,
  Inbox,
  ListChecks,
  LoaderCircle,
  NotebookPen,
  Search,
  SearchX,
  SquareCheck,
  Tag,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef, NoteType, SearchFilters, SearchHit, SearchParams, Status, TreeNode } from '@graphite/bindings';
import { cx } from '@graphite/ui';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { useRecentsStore } from '../../stores/recentsStore';
import { vaultKey } from '../../stores/vaultsStore';
import { NoteIcon } from '../tree/NoteIcon';
import { Fade, Presence, listContainerVariants, listItemVariants, usePrefersReducedMotion } from '../../motion';

export interface SearchPanelProps {
  width: number;
  onWidthChange: (w: number) => void;
}

const SEARCH_LIMIT = 50;
const DEBOUNCE_MS = 40;
const SKELETON_THRESHOLD_MS = 150;
const HIGHLIGHT_TERMS_MAX = 12;
const HIGHLIGHT_TERM_CHARS = 80;

const STATUS_LABEL: Record<Status, string> = {
  inbox: 'Входящие',
  shaping: 'Проработка',
  planned: 'План',
  active: 'В работе',
  done: 'Готово',
  iced: 'Лёд',
};

const STATUS_DOT: Record<Status, string> = {
  inbox: 'bg-status-inbox',
  shaping: 'bg-status-shaping',
  planned: 'bg-status-plan',
  active: 'bg-status-doing',
  done: 'bg-status-done',
  iced: 'bg-status-ice',
};

const STATUS_ALIASES: Record<string, Status> = {
  inbox: 'inbox',
  входящие: 'inbox',
  входящее: 'inbox',
  shaping: 'shaping',
  проработка: 'shaping',
  shape: 'shaping',
  planned: 'planned',
  plan: 'planned',
  план: 'planned',
  active: 'active',
  doing: 'active',
  'в-работе': 'active',
  работа: 'active',
  done: 'done',
  готово: 'done',
  готов: 'done',
  iced: 'iced',
  ice: 'iced',
  лёд: 'iced',
  лед: 'iced',
  заморожено: 'iced',
};

const TYPE_LABEL: Record<NoteType, string> = {
  note: 'Заметка',
  plan: 'План',
  project: 'Проект',
  task: 'Задача',
  journal: 'Дневник',
};

const TYPE_ICON: Record<NoteType, LucideIcon> = {
  note: FileText,
  plan: ListChecks,
  project: FolderKanban,
  task: SquareCheck,
  journal: NotebookPen,
};

const TYPE_ALIASES: Record<string, NoteType> = {
  note: 'note',
  заметка: 'note',
  plan: 'plan',
  план: 'plan',
  project: 'project',
  проект: 'project',
  task: 'task',
  задача: 'task',
  journal: 'journal',
  дневник: 'journal',
  журнал: 'journal',
};

const OPERATOR_HELP: readonly { op: string; desc: string }[] = [
  { op: 'tag:идея', desc: 'заметки с тегом' },
  { op: 'status:в-работе', desc: 'по статусу' },
  { op: 'type:проект', desc: 'по типу заметки' },
  { op: 'path:Проекты', desc: 'внутри папки' },
  { op: 'updated:7д', desc: 'изменённые за период' },
  { op: '"точная фраза"', desc: 'искать фразу целиком' },
  { op: '-слово', desc: 'исключить слово' },
];

const OPERATOR_RE = /(tag|status|type|path|updated)\s*:\s*("[^"]*"|\S+)/gi;

type ChipKind = 'tag' | 'status' | 'type' | 'path' | 'updated';

interface FilterChip {
  id: string;
  kind: ChipKind;
  label: string;
  start: number;
  end: number;
  dot?: string;
}

interface ParsedQuery {
  text: string;
  filters: SearchFilters;
  chips: FilterChip[];
  terms: string[];
  hasFilters: boolean;
  hasQuery: boolean;
}

const CHIP_ICON: Record<ChipKind, LucideIcon> = {
  tag: Tag,
  status: Tag,
  type: FileText,
  path: FolderClosed,
  updated: Clock,
};

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function startOfDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  return d;
}

function resolveMoment(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  const low = value.toLowerCase();
  const now = new Date();
  if (low === 'today' || low === 'сегодня') {
    return startOfDay(now).toISOString();
  }
  if (low === 'yesterday' || low === 'вчера') {
    const d = startOfDay(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  const rel = /^(\d+)(h|d|w|m|y|ч|д|н|нед|мес|г)$/.exec(low.replace(/\s+/g, ''));
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2];
    const d = new Date(now);
    if (unit === 'h' || unit === 'ч') {
      d.setHours(d.getHours() - amount);
    } else if (unit === 'd' || unit === 'д') {
      d.setDate(d.getDate() - amount);
    } else if (unit === 'w' || unit === 'н' || unit === 'нед') {
      d.setDate(d.getDate() - amount * 7);
    } else if (unit === 'm' || unit === 'мес') {
      d.setMonth(d.getMonth() - amount);
    } else {
      d.setFullYear(d.getFullYear() - amount);
    }
    return d.toISOString();
  }
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(low);
  if (ymd) {
    const d = new Date(`${low}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return null;
}

function parseUpdated(raw: string): { after?: string; before?: string; label: string } | null {
  let rest = raw.trim();
  let direction: 'after' | 'before' = 'after';
  if (/^>=?/.test(rest)) {
    direction = 'after';
    rest = rest.replace(/^>=?/, '');
  } else if (/^<=?/.test(rest)) {
    direction = 'before';
    rest = rest.replace(/^<=?/, '');
  }
  const moment = resolveMoment(rest);
  if (moment === null) {
    return null;
  }
  const prefix = direction === 'before' ? 'до ' : 'с ';
  const label = `${prefix}${rest.trim()}`;
  return direction === 'after' ? { after: moment, label } : { before: moment, label };
}

function extractTerms(text: string): string[] {
  const collected: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(text)) !== null) {
    const phrase = match[1].trim();
    if (phrase.length > 0) {
      collected.push(phrase);
    }
  }
  const residual = text.replace(phraseRe, ' ');
  for (const raw of residual.split(/\s+/)) {
    const word = raw.trim();
    if (word.length < 2 || word.startsWith('-')) {
      continue;
    }
    collected.push(word);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of collected) {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(term);
    }
  }
  return unique;
}

function parseQuery(raw: string): ParsedQuery {
  const filters: SearchFilters = {};
  const tags: string[] = [];
  const chips: FilterChip[] = [];
  let chipSeq = 0;

  const text = raw
    .replace(OPERATOR_RE, (match: string, key: string, rawValue: string, offset: number) => {
      const value = unquote(rawValue).trim();
      if (value.length === 0) {
        return match;
      }
      const kind = key.toLowerCase() as ChipKind;
      const start = offset;
      const end = offset + match.length;
      if (kind === 'tag') {
        const tag = value.replace(/^#/, '');
        if (tag.length === 0) {
          return match;
        }
        tags.push(tag);
        chips.push({ id: `chip-${chipSeq++}`, kind, label: tag, start, end });
        return ' ';
      }
      if (kind === 'status') {
        const status = STATUS_ALIASES[value.toLowerCase()];
        if (status === undefined) {
          return match;
        }
        filters.status = status;
        chips.push({ id: `chip-${chipSeq++}`, kind, label: STATUS_LABEL[status], start, end, dot: STATUS_DOT[status] });
        return ' ';
      }
      if (kind === 'type') {
        const type = TYPE_ALIASES[value.toLowerCase()];
        if (type === undefined) {
          return match;
        }
        filters.type = type;
        chips.push({ id: `chip-${chipSeq++}`, kind, label: TYPE_LABEL[type], start, end });
        return ' ';
      }
      if (kind === 'path') {
        filters.path = value;
        chips.push({ id: `chip-${chipSeq++}`, kind, label: value, start, end });
        return ' ';
      }
      const updated = parseUpdated(value);
      if (updated === null) {
        return match;
      }
      if (updated.after !== undefined) {
        filters.updatedAfter = updated.after;
      }
      if (updated.before !== undefined) {
        filters.updatedBefore = updated.before;
      }
      chips.push({ id: `chip-${chipSeq++}`, kind, label: updated.label, start, end });
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  if (tags.length > 0) {
    filters.tags = tags;
  }
  const hasFilters = Object.keys(filters).length > 0;
  return { text, filters, chips, terms: extractTerms(text), hasFilters, hasQuery: text.length > 0 || hasFilters };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Приводит ответ поиска к безопасной форме: любые пропуски, чужие типы,
 * дубли ref и не-массивы деградируют до пустых значений, а не до падения
 * рендера. Единственная точка входа данных бэкенда в список результатов.
 */
function sanitizeHits(response: unknown): SearchHit[] {
  if (typeof response !== 'object' || response === null) {
    return [];
  }
  const rawHits = (response as { hits?: unknown }).hits;
  if (!Array.isArray(rawHits)) {
    return [];
  }
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of rawHits) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const hit = raw as { ref?: unknown; title?: unknown; score?: unknown; snippets?: unknown; updated?: unknown };
    const ref = typeof hit.ref === 'string' ? hit.ref : '';
    if (ref.length === 0 || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push({
      ref,
      title: typeof hit.title === 'string' ? hit.title : '',
      score: typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : 0,
      snippets: Array.isArray(hit.snippets) ? hit.snippets.filter((s): s is string => typeof s === 'string') : [],
      updated: typeof hit.updated === 'string' ? hit.updated : '',
    });
    if (out.length >= SEARCH_LIMIT) {
      break;
    }
  }
  return out;
}

function highlightSnippet(text: string, terms: string[]): ReactNode {
  if (terms.length === 0 || text.length === 0) {
    return text;
  }
  const usable = terms
    .filter((term) => term.length > 0)
    .slice(0, HIGHLIGHT_TERMS_MAX)
    .map((term) => term.slice(0, HIGHLIGHT_TERM_CHARS));
  if (usable.length === 0) {
    return text;
  }
  let parts: string[];
  try {
    const pattern = usable
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    parts = text.split(new RegExp(`(${pattern})`, 'gi'));
  } catch {
    return text;
  }
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded-xs bg-accent-dim px-0.5 text-text-0">
        {part}
      </mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
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

function formatUpdated(iso: string): { short: string; full: string } {
  if (iso.length === 0) {
    return { short: '', full: '' };
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { short: '', full: iso };
  }
  try {
    const full = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(date);
    const diff = Date.now() - date.getTime();
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) {
      return { short: 'только что', full };
    }
    const relative = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' });
    if (diff < hour) {
      return { short: relative.format(-Math.round(diff / minute), 'minute'), full };
    }
    if (diff < day) {
      return { short: relative.format(-Math.round(diff / hour), 'hour'), full };
    }
    if (diff < 7 * day) {
      return { short: relative.format(-Math.round(diff / day), 'day'), full };
    }
    const sameYear = date.getFullYear() === new Date().getFullYear();
    const short = new Intl.DateTimeFormat(
      'ru-RU',
      sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
    ).format(date);
    return { short, full };
  } catch {
    return { short: '', full: iso };
  }
}

function pluralResults(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  let word: string;
  if (mod10 === 1 && mod100 !== 11) {
    word = 'результат';
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    word = 'результата';
  } else {
    word = 'результатов';
  }
  return `${count} ${word}`;
}

function InboxTriageActions({
  busy,
  onShaping,
  onIce,
}: {
  busy: boolean;
  onShaping: () => void;
  onIce: () => void;
}) {
  return (
    <span className="flex shrink-0 flex-col justify-center gap-0.5 py-1.5 pr-1.5">
      <button
        type="button"
        disabled={busy}
        title="Проработка · Ctrl+Enter"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onShaping();
        }}
        className="rounded-xs px-1.5 py-0.5 text-micro font-medium text-accent outline-none hover:bg-accent/10 disabled:opacity-45"
      >
        Проработка
      </button>
      <button
        type="button"
        disabled={busy}
        title="Лёд · Shift+Enter"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onIce();
        }}
        className="rounded-xs px-1.5 py-0.5 text-micro font-medium text-text-2 outline-none hover:bg-bg-4 hover:text-text-0 disabled:opacity-45"
      >
        Лёд
      </button>
    </span>
  );
}

type Phase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
type View = 'idle' | 'skeleton' | 'results' | 'empty' | 'building' | 'error';

function StatusChip({ status }: { status: Status }) {
  const label: string | undefined = STATUS_LABEL[status];
  if (label === undefined) {
    return null;
  }
  const dot: string | undefined = STATUS_DOT[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 py-0.5 pl-1.5 pr-2 text-micro text-text-1">
      <span aria-hidden className={cx('size-1.5 rounded-full', dot ?? 'bg-text-3')} />
      {label}
    </span>
  );
}

function SkeletonRow({ shimmer }: { shimmer: string }) {
  return (
    <div className="flex gap-2.5 rounded-m px-2.5 py-2">
      <div className={cx('mt-0.5 size-7 shrink-0 rounded-s', shimmer)} />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <div className={cx('h-3 w-1/2 rounded-full', shimmer)} />
        <div className={cx('h-2.5 w-full rounded-full', shimmer)} />
        <div className={cx('h-2.5 w-4/5 rounded-full', shimmer)} />
      </div>
    </div>
  );
}

function SkeletonList({ shimmer, rows }: { shimmer: string; rows: number }) {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} shimmer={shimmer} />
      ))}
    </div>
  );
}

function SearchErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full border border-stroke-0 bg-bg-2 text-warn">
        <SearchX size={20} strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-ui text-text-1">Поиск временно недоступен</p>
        <p className="text-caption text-text-2">Не удалось выполнить запрос. Попробуйте ещё раз.</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-s border border-stroke-1 bg-bg-2 px-3 py-1 text-caption text-text-1 transition-colors hover:border-accent hover:text-text-0"
      >
        Повторить
      </button>
    </div>
  );
}

interface SearchBoundaryProps {
  onTrip: () => void;
  onRetry: () => void;
  children: ReactNode;
}

/**
 * Локальный предохранитель списка результатов: любая ошибка рендера
 * деградирует до состояния «Поиск временно недоступен» с повтором,
 * не размонтируя остальное приложение.
 */
class SearchBoundary extends Component<SearchBoundaryProps, { tripped: boolean }> {
  state = { tripped: false };

  static getDerivedStateFromError(): { tripped: boolean } {
    return { tripped: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('search render error', error, info);
    this.props.onTrip();
  }

  render(): ReactNode {
    if (this.state.tripped) {
      return <SearchErrorState onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}

const QUERY_COMMIT_MS = 1200;

function RecentsIdle({
  onPickQuery,
  onOpenNote,
}: {
  onPickQuery: (query: string) => void;
  onOpenNote: (ref: NoteRef) => void;
}) {
  const vaultRoot = useVaultStore((s) => s.info?.root);
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const vault = vaultRoot === undefined ? undefined : vaultKey(vaultRoot);
  const queries = useRecentsStore((s) => (vault === undefined ? [] : s.queriesOf(vault)));
  const noteRefs = useRecentsStore((s) => (vault === undefined ? [] : s.notesOf(vault)));

  const notes = noteRefs
    .map((ref) => tree.find((node) => node.ref === ref))
    .filter((node): node is TreeNode => node !== undefined);

  if (queries.length === 0 && notes.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {queries.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="px-2 pb-0.5 text-micro uppercase tracking-wide text-text-3">Недавние запросы</p>
          {queries.map((item) => (
            <div key={item} className="group flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onPickQuery(item)}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-s px-2 py-1.5 text-left transition-colors hover:bg-bg-2"
              >
                <Clock size={14} strokeWidth={1.75} className="shrink-0 text-text-3" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-1">{item}</span>
              </button>
              <button
                type="button"
                aria-label={`Убрать запрос «${item}»`}
                onClick={() => {
                  if (vault !== undefined) {
                    useRecentsStore.getState().forgetQuery(vault, item);
                  }
                }}
                className="grid size-6 shrink-0 place-items-center rounded-xs text-text-3 opacity-0 transition-opacity hover:bg-bg-3 hover:text-text-0 group-hover:opacity-100"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="px-2 pb-0.5 text-micro uppercase tracking-wide text-text-3">Недавно открытые</p>
          {notes.map((node) => {
            const info = iconByRef[node.ref] ?? { icon: node.icon, color: node.iconColor };
            return (
              <button
                key={node.ref}
                type="button"
                onClick={() => onOpenNote(node.ref)}
                className="flex min-w-0 items-center gap-2.5 rounded-s px-2 py-1.5 text-left transition-colors hover:bg-bg-2"
              >
                <NoteIcon
                  icon={info.icon}
                  color={info.color}
                  size={15}
                  className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                />
                <span className="min-w-0 flex-1 truncate text-caption text-text-1">{node.title}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SearchPanel({ width, onWidthChange }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [unavailableHint, setUnavailableHint] = useState<string | undefined>(undefined);
  const [busyRef, setBusyRef] = useState<NoteRef | undefined>();
  const [nonce, setNonce] = useState(0);
  const [boundaryEpoch, setBoundaryEpoch] = useState(0);

  const openNote = useVaultStore((s) => s.openNote);
  const indexStatus = useVaultStore((s) => s.indexStatus);
  const tree = useVaultStore((s) => s.tree);

  const reduced = usePrefersReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastViewRef = useRef<View>('idle');
  const indexBuildingRef = useRef(false);
  const boundaryTrippedRef = useRef(false);
  const pendingSearch = useUiStore((s) => s.pendingSearch);

  useEffect(() => {
    if (pendingSearch === undefined) {
      return;
    }
    setQuery(pendingSearch);
    useUiStore.getState().consumePendingSearch();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [pendingSearch]);

  const vaultRoot = useVaultStore((s) => s.info?.root);
  const recentsVault = vaultRoot === undefined ? undefined : vaultKey(vaultRoot);
  const parsed = useMemo(() => parseQuery(query), [query]);
  const inboxQueue = parsed.filters.status === 'inbox';

  useEffect(() => {
    if (!parsed.hasQuery || phase !== 'ready' || recentsVault === undefined) {
      return;
    }
    const timer = window.setTimeout(() => {
      useRecentsStore.getState().rememberQuery(recentsVault, query);
    }, QUERY_COMMIT_MS);
    return () => window.clearTimeout(timer);
  }, [query, parsed.hasQuery, phase, recentsVault]);

  const openHit = (ref: string) => {
    if (recentsVault !== undefined && query.trim().length >= 2) {
      useRecentsStore.getState().rememberQuery(recentsVault, query);
    }
    openNote(ref);
  };

  const triageHit = async (ref: NoteRef, status: Extract<Status, 'shaping' | 'iced'>) => {
    if (busyRef !== undefined) {
      return;
    }
    setBusyRef(ref);
    try {
      await commands.setStatus({ ref, status });
      setHits((prev) => {
        const next = prev.filter((hit) => hit.ref !== ref);
        const idx = prev.findIndex((hit) => hit.ref === ref);
        const pick = next.length === 0 ? 0 : idx < 0 ? 0 : Math.min(idx, next.length - 1);
        window.queueMicrotask(() => setSelectedIndex(pick));
        return next;
      });
      void useVaultStore.getState().loadTree();
      void useVaultStore.getState().loadInfo();
      useUiStore.getState().pushToast({
        kind: 'success',
        text: status === 'iced' ? 'На лёд' : 'В проработку',
      });
    } catch (error) {
      useUiStore.getState().pushToast({
        kind: 'error',
        text: isGraphiteError(error) ? error.message : 'Не удалось сменить статус',
      });
    } finally {
      setBusyRef(undefined);
    }
  };

  const nodeByRef = useMemo(() => {
    const map = new Map<string, TreeNode>();
    for (const node of tree) {
      map.set(node.ref, node);
    }
    return map;
  }, [tree]);

  const shimmer = reduced
    ? 'bg-bg-2'
    : 'bg-[length:200%_100%] bg-[image:linear-gradient(90deg,var(--bg-2),var(--bg-3),var(--bg-2))] animate-shimmer';

  const indexBuilding = indexStatus.state === 'scanning' || indexStatus.state === 'indexing';

  useEffect(() => {
    if (!parsed.hasQuery) {
      setPhase('idle');
      setHits([]);
      setShowSkeleton(false);
      return;
    }

    let cancelled = false;
    let skeletonTimer: number | undefined;
    setPhase('loading');
    setShowSkeleton(false);

    const debounce = window.setTimeout(() => {
      skeletonTimer = window.setTimeout(() => {
        if (!cancelled) {
          setShowSkeleton(true);
        }
      }, SKELETON_THRESHOLD_MS);

      const params: SearchParams = { query: parsed.text, mode: 'keyword', limit: SEARCH_LIMIT };
      if (parsed.hasFilters) {
        params.filters = parsed.filters;
      }

      const finishLoading = () => {
        window.clearTimeout(skeletonTimer);
        setShowSkeleton(false);
      };

      const applyHits = (list: SearchHit[]) => {
        finishLoading();
        setHits(list);
        setSelectedIndex(0);
        setPhase('ready');
        if (boundaryTrippedRef.current) {
          boundaryTrippedRef.current = false;
          setBoundaryEpoch((value) => value + 1);
        }
      };

      const applyFailure = (failure: unknown) => {
        finishLoading();
        setHits([]);
        if (isGraphiteError(failure) && failure.code === 'UNAVAILABLE') {
          setUnavailableHint(failure.hint ?? failure.message);
          setPhase('unavailable');
        } else {
          setPhase('error');
        }
      };

      Promise.resolve()
        .then(() => commands.search(params))
        .then(
          (response) => {
            if (!cancelled) {
              applyHits(sanitizeHits(response));
            }
          },
          (failure: unknown) => {
            if (!cancelled) {
              applyFailure(failure);
            }
          },
        )
        .catch((failure: unknown) => {
          if (!cancelled) {
            applyFailure(failure);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      window.clearTimeout(skeletonTimer);
    };
  }, [parsed, nonce]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, hits]);

  useEffect(() => {
    if (indexBuildingRef.current && !indexBuilding && parsed.hasQuery) {
      setNonce((value) => value + 1);
    }
    indexBuildingRef.current = indexBuilding;
  }, [indexBuilding, parsed.hasQuery]);

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const clearQuery = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  const removeChip = (chip: FilterChip) => {
    setQuery((current) => `${current.slice(0, chip.start)} ${current.slice(chip.end)}`.replace(/\s+/g, ' ').trim());
    inputRef.current?.focus();
  };

  const appendOperator = (op: string) => {
    setQuery((current) => (current.trim().length > 0 ? `${current.trim()} ${op}` : op));
    inputRef.current?.focus();
  };

  const retrySearch = () => {
    boundaryTrippedRef.current = false;
    setBoundaryEpoch((value) => value + 1);
    setNonce((value) => value + 1);
  };

  const onBoundaryTrip = () => {
    boundaryTrippedRef.current = true;
    setHits([]);
    setShowSkeleton(false);
    setPhase('error');
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (query.length > 0) {
        event.preventDefault();
        setQuery('');
      }
      return;
    }
    if (phase !== 'ready' || hits.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Home') {
      const input = event.currentTarget;
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        event.preventDefault();
        setSelectedIndex(0);
      }
    } else if (event.key === 'End') {
      const input = event.currentTarget;
      const caretEnd = input.value.length;
      if (input.selectionStart === caretEnd && input.selectionEnd === caretEnd) {
        event.preventDefault();
        setSelectedIndex(hits.length - 1);
      }
    } else if (event.key === 'Enter' && inboxQueue && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const target = hits[selectedIndex] ?? hits[0];
      if (target !== undefined) {
        void triageHit(target.ref, 'shaping');
      }
    } else if (event.key === 'Enter' && inboxQueue && event.shiftKey) {
      event.preventDefault();
      const target = hits[selectedIndex] ?? hits[0];
      if (target !== undefined) {
        void triageHit(target.ref, 'iced');
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = hits[selectedIndex] ?? hits[0];
      if (target !== undefined) {
        openHit(target.ref);
      }
    }
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId } = event;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(startWidth + (moveEvent.clientX - startX));
    };
    const onUp = () => {
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  let view: View;
  if (!parsed.hasQuery) {
    view = 'idle';
  } else if (phase === 'unavailable') {
    view = 'building';
  } else if (phase === 'error') {
    view = 'error';
  } else if (showSkeleton) {
    view = 'skeleton';
  } else if (phase === 'ready') {
    view = hits.length > 0 ? 'results' : indexBuilding ? 'building' : 'empty';
  } else if (hits.length > 0) {
    view = 'results';
  } else if (lastViewRef.current === 'error' || lastViewRef.current === 'empty') {
    view = 'skeleton';
  } else {
    view = lastViewRef.current;
  }
  lastViewRef.current = view;

  const activeOptionId = view === 'results' ? `search-option-${selectedIndex}` : undefined;

  const footerText =
    view === 'results'
      ? inboxQueue
        ? `${hits.length} во входящих`
        : pluralResults(hits.length)
      : indexBuilding
        ? indexStatus.total > 0
          ? `Индекс: ${indexStatus.done} / ${indexStatus.total}`
          : 'Индекс строится'
        : undefined;

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-stroke-0 bg-bg-1"
      style={{ width }}
      aria-label="Поиск"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-stroke-0 px-3">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-text-2" />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Поиск по хранилищу…"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={view === 'results'}
          aria-controls={view === 'results' ? 'search-results-list' : undefined}
          aria-activedescendant={activeOptionId}
          className="h-7 w-full min-w-0 bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
        />
        {phase === 'loading' && !reduced ? (
          <LoaderCircle size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-text-2" aria-hidden />
        ) : null}
        {query.length > 0 ? (
          <button
            type="button"
            onClick={clearQuery}
            aria-label="Очистить поиск"
            className="grid size-5 shrink-0 place-items-center rounded-s text-text-2 transition-colors hover:bg-bg-3 hover:text-text-0"
          >
            <X size={13} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {parsed.chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-stroke-0 px-3 py-2">
          {parsed.chips.map((chip) => {
            const ChipIcon = CHIP_ICON[chip.kind];
            return (
              <span
                key={chip.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-stroke-1 bg-bg-2 py-0.5 pl-2 pr-1 text-micro text-text-1"
              >
                {chip.dot !== undefined ? (
                  <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', chip.dot)} />
                ) : (
                  <ChipIcon size={11} strokeWidth={1.75} className="shrink-0 text-text-2" aria-hidden />
                )}
                <span className="truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={() => removeChip(chip)}
                  aria-label={`Убрать фильтр ${chip.label}`}
                  className="grid size-4 shrink-0 place-items-center rounded-full text-text-3 transition-colors hover:bg-bg-3 hover:text-text-1"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            );
          })}
          <button
            type="button"
            onClick={clearQuery}
            className="ml-auto text-micro text-text-3 transition-colors hover:text-text-1"
          >
            Сбросить
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SearchBoundary key={boundaryEpoch} onTrip={onBoundaryTrip} onRetry={retrySearch}>
          <Presence mode="wait">
            {view === 'results' ? (
              <Fade key="results" className="flex flex-col p-2">
                {inboxQueue ? (
                  <p className="px-1 pb-2 text-micro text-text-3">
                    Разберите входящие: проработка или лёд. Клик открывает заметку. Ctrl+Enter / Shift+Enter.
                  </p>
                ) : null}
                <motion.ul
                  id="search-results-list"
                  role="listbox"
                  aria-label={inboxQueue ? 'Входящие' : 'Результаты поиска'}
                  variants={listContainerVariants}
                  initial="initial"
                  animate="animate"
                  className="flex flex-col gap-1"
                >
                  {hits.map((hit, index) => {
                    const node = nodeByRef.get(hit.ref);
                    const TypeIcon: LucideIcon = (node !== undefined ? TYPE_ICON[node.type] : undefined) ?? FileIcon;
                    const status = node?.status;
                    const dir = node !== undefined ? parentDir(node.path) : parentDir(refToPath(hit.ref));
                    const date = formatUpdated(hit.updated);
                    const snippets = hit.snippets.filter((s) => s.trim().length > 0).slice(0, 3);
                    const selected = index === selectedIndex;
                    return (
                      <motion.li key={hit.ref} variants={listItemVariants}>
                        <div
                          className={cx(
                            'flex items-start rounded-m transition-colors',
                            selected ? 'bg-bg-3' : 'hover:bg-bg-2',
                          )}
                          onMouseMove={() => setSelectedIndex(index)}
                        >
                          <button
                            ref={(el) => {
                              itemRefs.current[index] = el;
                            }}
                            type="button"
                            id={`search-option-${index}`}
                            role="option"
                            aria-selected={selected}
                            onClick={() => openHit(hit.ref)}
                            className="flex min-w-0 flex-1 gap-2.5 px-2.5 py-2 text-left"
                          >
                            <span
                              className={cx(
                                'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-s border bg-bg-2 transition-colors',
                                selected ? 'border-stroke-1 text-accent' : 'border-stroke-0 text-text-2',
                              )}
                            >
                              <TypeIcon size={15} strokeWidth={1.75} />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="flex items-baseline gap-2">
                                <span className="min-w-0 flex-1 truncate text-ui text-text-0">
                                  {hit.title.trim().length > 0 ? hit.title : 'Без названия'}
                                </span>
                                {date.short.length > 0 ? (
                                  <time
                                    dateTime={hit.updated}
                                    title={date.full}
                                    className="shrink-0 text-micro text-text-3"
                                  >
                                    {date.short}
                                  </time>
                                ) : null}
                              </span>
                              {snippets.length > 0 ? (
                                <span className="flex flex-col gap-0.5">
                                  {snippets.map((snippet, snippetIndex) => (
                                    <span
                                      key={snippetIndex}
                                      className="line-clamp-2 text-caption leading-relaxed text-text-2"
                                    >
                                      {highlightSnippet(snippet, parsed.terms)}
                                    </span>
                                  ))}
                                </span>
                              ) : null}
                              {status !== undefined || dir !== undefined ? (
                                <span className="mt-0.5 flex min-w-0 items-center gap-2">
                                  {status !== undefined ? <StatusChip status={status} /> : null}
                                  {dir !== undefined ? (
                                    <span className="min-w-0 flex-1 truncate text-micro text-text-3">{dir}</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {inboxQueue ? (
                            <InboxTriageActions
                              busy={busyRef !== undefined}
                              onShaping={() => void triageHit(hit.ref, 'shaping')}
                              onIce={() => void triageHit(hit.ref, 'iced')}
                            />
                          ) : null}
                        </div>
                      </motion.li>
                    );
                  })}
                </motion.ul>
              </Fade>
            ) : view === 'skeleton' ? (
              <Fade key="skeleton" className="flex flex-col gap-2 p-2">
                {indexBuilding ? (
                  <p className="px-0.5 text-micro text-text-3">Индекс ещё строится — показываю, что уже готово</p>
                ) : null}
                <SkeletonList shimmer={shimmer} rows={6} />
              </Fade>
            ) : view === 'building' ? (
              <Fade key="building" className="flex flex-1 flex-col">
                <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
                  <LoaderCircle
                    size={15}
                    strokeWidth={1.75}
                    className={cx('shrink-0 text-accent', !reduced && 'animate-spin')}
                    aria-hidden
                  />
                  <span className="text-ui text-text-1">Индекс строится</span>
                  {indexStatus.total > 0 ? (
                    <span className="ml-auto text-micro tabular-nums text-text-3">
                      {indexStatus.done} / {indexStatus.total}
                    </span>
                  ) : null}
                </div>
                <p className="px-3 pb-3 text-caption text-text-2">
                  Результаты появятся, как только поиск будет готов.
                  {unavailableHint !== undefined && phase === 'unavailable' ? (
                    <span className="mt-1 block text-micro text-text-3">{unavailableHint}</span>
                  ) : null}
                </p>
                <div className="px-2 opacity-60">
                  <SkeletonList shimmer={shimmer} rows={4} />
                </div>
              </Fade>
            ) : view === 'empty' ? (
              <Fade key="empty" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                <span className="grid size-11 place-items-center rounded-full border border-stroke-0 bg-bg-2 text-text-2">
                  {inboxQueue ? <Inbox size={20} strokeWidth={1.75} /> : <SearchX size={20} strokeWidth={1.75} />}
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-ui text-text-1">{inboxQueue ? 'Входящие пусты' : 'Ничего не найдено'}</p>
                  <p className="text-caption text-text-2">
                    {inboxQueue
                      ? 'Новые искры появятся с Ctrl+Alt+Space.'
                      : 'Уточните запрос или измените операторы.'}
                  </p>
                </div>
                {inboxQueue ? null : (
                <div className="flex flex-wrap justify-center gap-1.5">
                  {(['tag:', 'status:', 'type:', 'path:', 'updated:'] as const).map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => appendOperator(op)}
                      className="rounded-full border border-stroke-1 bg-bg-2 px-2 py-0.5 font-mono text-micro text-text-1 transition-colors hover:border-accent hover:text-text-0"
                    >
                      {op}
                    </button>
                  ))}
                </div>
                )}
              </Fade>
            ) : view === 'error' ? (
              <Fade key="error" className="flex flex-1 flex-col">
                <SearchErrorState onRetry={retrySearch} />
              </Fade>
            ) : (
              <Fade key="idle" className="flex flex-1 flex-col gap-4 px-3 py-5">
                {indexBuilding ? (
                  <div className="flex items-center gap-2 rounded-m border border-stroke-0 bg-bg-2 px-3 py-2">
                    <span
                      aria-hidden
                      className={cx('size-1.5 shrink-0 rounded-full bg-accent', !reduced && 'animate-pulse-mcp')}
                    />
                    <span className="text-caption text-text-2">
                      Индекс строится{indexStatus.total > 0 ? ` · ${indexStatus.done}/${indexStatus.total}` : ''}
                    </span>
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <p className="text-ui text-text-1">Поиск по хранилищу</p>
                  <p className="text-caption text-text-2">
                    Введите запрос или используйте операторы. Навигация — стрелками, открытие — Enter.
                  </p>
                </div>
                <RecentsIdle
                  onPickQuery={(value) => {
                    setQuery(value);
                    window.requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  onOpenNote={(ref) => openNote(ref)}
                />
                <div className="flex flex-col gap-1">
                  {OPERATOR_HELP.map((item) => (
                    <button
                      key={item.op}
                      type="button"
                      onClick={() => appendOperator(item.op)}
                      className="group flex items-center gap-2.5 rounded-s px-2 py-1.5 text-left transition-colors hover:bg-bg-2"
                    >
                      <code className="shrink-0 rounded-xs border border-stroke-1 bg-bg-2 px-1.5 py-0.5 font-mono text-micro text-text-1 transition-colors group-hover:border-accent group-hover:text-text-0">
                        {item.op}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-caption text-text-2">{item.desc}</span>
                    </button>
                  ))}
                </div>
              </Fade>
            )}
          </Presence>
        </SearchBoundary>
      </div>

      {footerText !== undefined ? (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-stroke-0 px-3 text-micro text-text-3">
          {indexBuilding ? (
            <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full bg-accent', !reduced && 'animate-pulse-mcp')} />
          ) : null}
          <span className="truncate">{footerText}</span>
        </div>
      ) : null}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину панели"
        className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize hover:bg-stroke-1 active:bg-stroke-1"
        onPointerDown={onHandlePointerDown}
      />
    </aside>
  );
}
