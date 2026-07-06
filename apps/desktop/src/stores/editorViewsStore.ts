import { create } from 'zustand';
import type { EditorView } from '@codemirror/view';
import type { NoteRef } from '@graphite/bindings';

export interface EditorViewEntry {
  noteRef: NoteRef;
  view: EditorView;
}

export interface EditorViewsStore {
  /** Живые CodeMirror-редакторы по id вкладки. */
  views: Record<string, EditorViewEntry>;
  /** Растёт при каждом изменении документа любого редактора — включая внешние setDoc. */
  docVersion: number;
  register(tabId: string, noteRef: NoteRef, view: EditorView): void;
  unregister(tabId: string): void;
  bumpDocVersion(): void;
}

/**
 * Реестр смонтированных редакторов: правая панель и экспорт читают актуальный
 * буфер напрямую из view, не дожидаясь дебаунс-автосейва на диск. Эфемерный,
 * без persist — view живут ровно столько, сколько их вкладки.
 */
export const useEditorViewsStore = create<EditorViewsStore>()((set) => ({
  views: {},
  docVersion: 0,
  register: (tabId, noteRef, view) => {
    set((s) => ({ views: { ...s.views, [tabId]: { noteRef, view } } }));
  },
  unregister: (tabId) => {
    set((s) => {
      if (!(tabId in s.views)) {
        return s;
      }
      const views = { ...s.views };
      delete views[tabId];
      return { views };
    });
  },
  bumpDocVersion: () => {
    set((s) => ({ docVersion: s.docVersion + 1 }));
  },
}));
