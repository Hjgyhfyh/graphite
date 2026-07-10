import { CheckCircle2, CircleDot, ClipboardList, Inbox, PencilRuler, Snowflake } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { isGraphiteError } from '@graphite/bindings';
import type { NoteType, Status, TreeNode } from '@graphite/bindings';
import { DEFAULT_ORDER } from '../../stores/boardStore';
import type { BoardConfig, ColumnConfig } from '../../stores/boardStore';
import { resolveIconColor, resolveIconComponent } from '../tree/NoteIcon';

export interface KanbanCardData extends TreeNode {
  status: Status;
  sortStamp: number;
  alias?: string;
}

export interface ColumnMeta {
  label: string;
  icon: LucideIcon;
  iconClass: string;
  tintClass: string;
  hint: string;
}

export const DEFAULT_COLUMN_META: Record<Status, ColumnMeta> = {
  inbox: {
    label: 'Входящие',
    icon: Inbox,
    iconClass: 'text-status-inbox',
    tintClass: 'bg-status-inbox/15',
    hint: 'Пусто. Ловите искры на Ctrl+Alt+Space.',
  },
  shaping: {
    label: 'Проработка',
    icon: PencilRuler,
    iconClass: 'text-status-shaping',
    tintClass: 'bg-status-shaping/15',
    hint: 'Нет заметок в проработке.',
  },
  planned: {
    label: 'План',
    icon: ClipboardList,
    iconClass: 'text-status-plan',
    tintClass: 'bg-status-plan/15',
    hint: 'Здесь появятся планы.',
  },
  active: {
    label: 'В работе',
    icon: CircleDot,
    iconClass: 'text-status-doing',
    tintClass: 'bg-status-doing/15',
    hint: 'Ничего в работе.',
  },
  done: {
    label: 'Готово',
    icon: CheckCircle2,
    iconClass: 'text-status-done',
    tintClass: 'bg-status-done/15',
    hint: 'Пока ничего не завершено.',
  },
  iced: {
    label: 'Лёд',
    icon: Snowflake,
    iconClass: 'text-status-ice',
    tintClass: 'bg-status-ice/15',
    hint: 'Заморозки нет.',
  },
};

export interface ResolvedColumn {
  status: Status;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  iconClass?: string;
  iconStyle?: CSSProperties;
  tintClass?: string;
  tintStyle?: CSSProperties;
  hint: string;
  hidden: boolean;
}

/** Колонка с учётом настроек доски: кастомный цвет заменяет штатные токены статуса. */
export function resolveColumn(status: Status, config?: ColumnConfig): ResolvedColumn {
  const meta = DEFAULT_COLUMN_META[status];
  const tint = resolveIconColor(config?.iconColor);
  const customIcon = config?.icon !== undefined && config.icon.length > 0;
  return {
    status,
    label: config?.label !== undefined && config.label.length > 0 ? config.label : meta.label,
    defaultLabel: meta.label,
    icon: customIcon ? resolveIconComponent(config?.icon) : meta.icon,
    iconClass: tint === undefined ? meta.iconClass : undefined,
    iconStyle: tint === undefined ? undefined : { color: tint },
    tintClass: tint === undefined ? meta.tintClass : undefined,
    tintStyle: tint === undefined ? undefined : { backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)` },
    hint: meta.hint,
    hidden: config?.hidden === true,
  };
}

export function resolveColumns(config: BoardConfig, includeHidden = false): ResolvedColumn[] {
  const columns: ResolvedColumn[] = [];
  for (const status of config.order) {
    const column = resolveColumn(status, config.columns[status]);
    if (includeHidden || !column.hidden) {
      columns.push(column);
    }
  }
  return columns;
}

const STATUS_SET: ReadonlySet<Status> = new Set<Status>(DEFAULT_ORDER);

const PIPELINE_TYPES: ReadonlySet<NoteType> = new Set<NoteType>(['note', 'project', 'plan']);

const TYPE_LABEL: Record<NoteType, string> = {
  note: 'Заметка',
  project: 'Проект',
  plan: 'План',
  task: 'Задача',
  journal: 'Журнал',
};

const TYPE_ICON: Record<NoteType, string> = {
  note: 'FileText',
  project: 'Package',
  plan: 'Target',
  task: 'ListTodo',
  journal: 'BookOpen',
};

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function pipelineStatus(node: TreeNode): Status | null {
  if (node.status !== undefined && STATUS_SET.has(node.status)) {
    return node.status;
  }
  return PIPELINE_TYPES.has(node.type) ? 'inbox' : null;
}

export function emptyGroups(): Record<Status, KanbanCardData[]> {
  return { inbox: [], shaping: [], planned: [], active: [], done: [], iced: [] };
}

export function groupByStatus(cards: KanbanCardData[]): Record<Status, KanbanCardData[]> {
  const groups = emptyGroups();
  for (const card of cards) {
    groups[card.status].push(card);
  }
  for (const status of Object.keys(groups) as Status[]) {
    groups[status].sort((a, b) => {
      const pinDiff = Number(b.pinned ?? false) - Number(a.pinned ?? false);
      if (pinDiff !== 0) {
        return pinDiff;
      }
      return b.sortStamp - a.sortStamp;
    });
  }
  return groups;
}

export function typeLabel(type: NoteType): string {
  return TYPE_LABEL[type];
}

export function typeFallbackIcon(type: NoteType): string {
  return TYPE_ICON[type];
}

export function formatUpdated(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const diff = Date.now() - time;
  if (diff < MINUTE_MS) {
    return 'только что';
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)} мин назад`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)} ч назад`;
  }
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) {
    return 'вчера';
  }
  if (days < 7) {
    return `${days} дн назад`;
  }
  if (days < 30) {
    return `${Math.floor(days / 7)} нед назад`;
  }
  const date = new Date(time);
  const label = `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
  return date.getFullYear() === new Date().getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

export function statusReason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}
