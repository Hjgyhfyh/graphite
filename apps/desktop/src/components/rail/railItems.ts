import {
  CalendarDays,
  FileText,
  ListChecks,
  Network,
  Search,
  Sparkles,
  SquareKanban,
  Tag,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RailItemView } from '../../stores/uiStore';

export interface RailItemMeta {
  label: string;
  icon: LucideIcon;
}

export const RAIL_META: Record<RailItemView, RailItemMeta> = {
  tree: { label: 'Заметки', icon: FileText },
  search: { label: 'Поиск', icon: Search },
  tasks: { label: 'Задачи', icon: ListChecks },
  brief: { label: 'Бриф для Claude', icon: Sparkles },
  plan: { label: 'Канбан', icon: SquareKanban },
  graph: { label: 'Граф связей', icon: Network },
  daily: { label: 'Дневник', icon: CalendarDays },
  tags: { label: 'Теги', icon: Tag },
};
