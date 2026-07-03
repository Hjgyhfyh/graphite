import type { IndexProgressEvent, JournalOpEvent, McpSessionEvent, NoteChangedEvent, NoteRef } from './types';

export interface UiOpenNoteEvent {
  ref: NoteRef;
}

export interface UiFlashNoteEvent {
  ref: NoteRef;
}

export interface GraphiteEventMap {
  note_changed: NoteChangedEvent;
  index_progress: IndexProgressEvent;
  journal_op: JournalOpEvent;
  mcp_session: McpSessionEvent;
  ui_open_note: UiOpenNoteEvent;
  ui_flash_note: UiFlashNoteEvent;
}

export type GraphiteEventName = keyof GraphiteEventMap;

export const GRAPHITE_EVENT = {
  noteChanged: 'note_changed',
  indexProgress: 'index_progress',
  journalOp: 'journal_op',
  mcpSession: 'mcp_session',
  uiOpenNote: 'ui_open_note',
  uiFlashNote: 'ui_flash_note',
} as const satisfies Record<string, GraphiteEventName>;
