import type { RailView } from '../stores/uiStore';
import { RAIL_META } from '../components/rail/railItems';

export function graphiteWindowTitle(input: {
  railView: RailView;
  noteTitle: string | undefined;
  focusMode: boolean;
}): string {
  let head: string;
  if (input.railView === 'tree' || input.railView === 'search') {
    head = input.noteTitle !== undefined && input.noteTitle.length > 0 ? input.noteTitle : RAIL_META[input.railView].label;
  } else if (input.railView === 'settings') {
    head = 'Настройки';
  } else {
    head = RAIL_META[input.railView].label;
  }
  const prefix = input.focusMode ? 'Фокус · ' : '';
  return `${prefix}${head} — Graphite`;
}
