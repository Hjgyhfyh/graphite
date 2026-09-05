import { create } from 'zustand';
import { noteStats } from '../lib/noteStats';
import type { NoteStats } from '../lib/noteStats';

export interface EditorMetaStore extends NoteStats {
  setFromDoc(doc: string | undefined): void;
}

const EMPTY: NoteStats = { words: 0, chars: 0, readingMin: 0 };

export const useEditorMetaStore = create<EditorMetaStore>((set) => ({
  ...EMPTY,
  setFromDoc: (doc) => {
    if (doc === undefined || doc.length === 0) {
      set(EMPTY);
      return;
    }
    set(noteStats(doc));
  },
}));
