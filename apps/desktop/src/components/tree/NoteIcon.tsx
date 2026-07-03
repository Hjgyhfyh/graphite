import {
  Anchor,
  Beaker,
  BookOpen,
  Bookmark,
  Box,
  Brain,
  Bug,
  Calendar,
  Code,
  Compass,
  Database,
  Feather,
  File,
  FileText,
  Flag,
  Flame,
  Folder,
  FolderOpen,
  Globe,
  Hammer,
  Hash,
  Heart,
  Layers,
  Leaf,
  Lightbulb,
  ListTodo,
  Map,
  Moon,
  Package,
  Pencil,
  Rocket,
  Snowflake,
  Sparkles,
  Star,
  Sun,
  Target,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const ICON_CATALOG: Record<string, LucideIcon> = {
  FileText,
  File,
  Folder,
  FolderOpen,
  BookOpen,
  Bookmark,
  Lightbulb,
  Target,
  Flag,
  Rocket,
  Star,
  Heart,
  Zap,
  Flame,
  Snowflake,
  Bug,
  Wrench,
  Hammer,
  Beaker,
  Brain,
  Code,
  Terminal,
  Database,
  Globe,
  Map,
  Compass,
  Calendar,
  ListTodo,
  Hash,
  Layers,
  Box,
  Package,
  Pencil,
  Feather,
  Anchor,
  Leaf,
  Moon,
  Sun,
  Sparkles,
};

export const ICON_NAMES: readonly string[] = Object.keys(ICON_CATALOG);

export const NOTE_COLORS = ['accent', 'ai', 'ok', 'warn', 'danger', 'text-1'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export function resolveIconColor(color?: string): string | undefined {
  if (color === undefined || color.length === 0) {
    return undefined;
  }
  return color.startsWith('#') ? color : `var(--${color})`;
}

export function resolveIconComponent(name?: string): LucideIcon {
  if (name !== undefined && name in ICON_CATALOG) {
    return ICON_CATALOG[name];
  }
  return FileText;
}

export interface NoteIconProps {
  icon?: string;
  color?: string;
  size?: number;
  className?: string;
  fallback?: string;
}

export function NoteIcon({ icon, color, size = 16, className, fallback }: NoteIconProps) {
  const Icon = resolveIconComponent(icon ?? fallback);
  const tint = resolveIconColor(color);
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      className={className}
      style={tint !== undefined ? { color: tint } : undefined}
      aria-hidden
    />
  );
}
