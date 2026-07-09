import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NoteRef } from '@graphite/bindings';
import type { RailView } from './uiStore';
import { useUiStore } from './uiStore';

export interface BriefNoteFile {
  kind: 'note';
  id: string;
  ref: NoteRef;
  title: string;
  path: string;
  why: string;
  chars?: number;
}

export interface BriefExternalFile {
  kind: 'external';
  id: string;
  path: string;
  why: string;
}

export type BriefFile = BriefNoteFile | BriefExternalFile;

export interface BriefDirection {
  id: string;
  text: string;
}

export interface BriefSnapshot {
  idea: string;
  description: string;
  files: BriefFile[];
  directions: BriefDirection[];
}

export interface BriefStore extends BriefSnapshot {
  returnView: RailView;
  notePickerOpen: boolean;
  setIdea(v: string): void;
  setDescription(v: string): void;
  addNoteFile(file: Omit<BriefNoteFile, 'kind' | 'id'>): boolean;
  addExternalFiles(paths: string[]): number;
  setFileWhy(id: string, why: string): void;
  setNoteChars(id: string, chars: number): void;
  removeFile(id: string): void;
  addDirection(): string;
  setDirection(id: string, text: string): void;
  removeDirection(id: string): void;
  setNotePickerOpen(open: boolean): void;
  snapshot(): BriefSnapshot;
  restore(s: BriefSnapshot): void;
  clear(): void;
}

/** Ключ дедупликации внешних путей: регистр и вид слэшей не различаем. */
export function normalizeExternalPath(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function hydrateFiles(value: unknown): BriefFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: BriefFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.path !== 'string') {
      continue;
    }
    const why = typeof raw.why === 'string' ? raw.why : '';
    if (raw.kind === 'note' && typeof raw.ref === 'string' && typeof raw.title === 'string') {
      files.push({
        kind: 'note',
        id: raw.id,
        ref: raw.ref,
        title: raw.title,
        path: raw.path,
        why,
        chars: typeof raw.chars === 'number' && Number.isFinite(raw.chars) ? raw.chars : undefined,
      });
    } else if (raw.kind === 'external') {
      files.push({ kind: 'external', id: raw.id, path: raw.path, why });
    }
  }
  return files;
}

function hydrateDirections(value: unknown): BriefDirection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const directions: BriefDirection[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.id === 'string' && raw.id.length > 0 && typeof raw.text === 'string') {
      directions.push({ id: raw.id, text: raw.text });
    }
  }
  return directions;
}

export const useBriefStore = create<BriefStore>()(
  persist(
    (set, get) => ({
      idea: '',
      description: '',
      files: [],
      directions: [],
      returnView: 'tree',
      notePickerOpen: false,
      setIdea: (v) => {
        set({ idea: v });
      },
      setDescription: (v) => {
        set({ description: v });
      },
      addNoteFile: (file) => {
        if (get().files.some((f) => f.kind === 'note' && f.ref === file.ref)) {
          return false;
        }
        set((s) => ({ files: [...s.files, { ...file, kind: 'note', id: crypto.randomUUID() }] }));
        return true;
      },
      addExternalFiles: (paths) => {
        const current = get().files;
        const seen = new Set(
          current
            .filter((f): f is BriefExternalFile => f.kind === 'external')
            .map((f) => normalizeExternalPath(f.path)),
        );
        const added: BriefExternalFile[] = [];
        for (const raw of paths) {
          const path = raw.trim();
          if (path.length === 0) {
            continue;
          }
          const key = normalizeExternalPath(path);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          added.push({ kind: 'external', id: crypto.randomUUID(), path, why: '' });
        }
        if (added.length > 0) {
          set({ files: [...current, ...added] });
        }
        return added.length;
      },
      setFileWhy: (id, why) => {
        set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, why } : f)) }));
      },
      setNoteChars: (id, chars) => {
        set((s) => ({
          files: s.files.map((f) => (f.id === id && f.kind === 'note' ? { ...f, chars } : f)),
        }));
      },
      removeFile: (id) => {
        set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
      },
      addDirection: () => {
        const id = crypto.randomUUID();
        set((s) => ({ directions: [...s.directions, { id, text: '' }] }));
        return id;
      },
      setDirection: (id, text) => {
        set((s) => ({ directions: s.directions.map((d) => (d.id === id ? { ...d, text } : d)) }));
      },
      removeDirection: (id) => {
        set((s) => ({ directions: s.directions.filter((d) => d.id !== id) }));
      },
      setNotePickerOpen: (open) => {
        set({ notePickerOpen: open });
      },
      snapshot: () => {
        const s = get();
        return {
          idea: s.idea,
          description: s.description,
          files: s.files.map((f) => ({ ...f })),
          directions: s.directions.map((d) => ({ ...d })),
        };
      },
      restore: (snap) => {
        set({
          idea: snap.idea,
          description: snap.description,
          files: snap.files.map((f) => ({ ...f })),
          directions: snap.directions.map((d) => ({ ...d })),
        });
      },
      clear: () => {
        set({ idea: '', description: '', files: [], directions: [] });
      },
    }),
    {
      name: 'graphite.brief',
      partialize: (s) => ({
        idea: s.idea,
        description: s.description,
        files: s.files,
        directions: s.directions,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<BriefSnapshot>;
        return {
          ...current,
          idea: typeof saved.idea === 'string' ? saved.idea : '',
          description: typeof saved.description === 'string' ? saved.description : '',
          files: hydrateFiles(saved.files),
          directions: hydrateDirections(saved.directions),
        };
      },
    },
  ),
);

/** Открыть вид брифа, запомнив, куда возвращаться по Esc. */
export function openBriefView(): void {
  const ui = useUiStore.getState();
  if (ui.railView !== 'brief') {
    useBriefStore.setState({ returnView: ui.railView });
  }
  ui.setRailView('brief');
}

export function closeBriefView(): void {
  useUiStore.getState().setRailView(useBriefStore.getState().returnView);
}
