import { create } from 'zustand';
import type { NoteRef } from '@graphite/bindings';

export interface Tab {
  id: string;
  noteRef: NoteRef;
  title: string;
  dirty: boolean;
  kind: 'editor' | 'plan' | 'settings';
}

export interface TabsStore {
  tabs: Tab[];
  activeId?: string;
  open(ref: NoteRef, kind?: Tab['kind']): void;
  close(id: string): void;
  activate(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  remapRef(oldRef: NoteRef, next: { ref: NoteRef; title: string }): void;
}

export function titleFromRef(ref: NoteRef): string {
  if (ref.startsWith('path:')) {
    const path = ref.slice('path:'.length);
    const base = path.split('/').pop() ?? path;
    return base.toLowerCase().endsWith('.md') ? base.slice(0, -'.md'.length) : base;
  }
  return 'Заметка';
}

export const useTabsStore = create<TabsStore>()((set, get) => ({
  tabs: [],
  activeId: undefined,
  open: (ref, kind = 'editor') => {
    const existing = get().tabs.find((tab) => tab.noteRef === ref && tab.kind === kind);
    if (existing !== undefined) {
      set({ activeId: existing.id });
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      noteRef: ref,
      title: titleFromRef(ref),
      dirty: false,
      kind,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },
  close: (id) => {
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) {
        return s;
      }
      const tabs = s.tabs.filter((tab) => tab.id !== id);
      const activeId = s.activeId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id) : s.activeId;
      return { tabs, activeId };
    });
  },
  activate: (id) => {
    set((s) => (s.tabs.some((tab) => tab.id === id) ? { activeId: id } : s));
  },
  setDirty: (id, dirty) => {
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)) }));
  },
  remapRef: (oldRef, next) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.noteRef === oldRef ? { ...tab, noteRef: next.ref, title: next.title } : tab)),
    }));
  },
}));
