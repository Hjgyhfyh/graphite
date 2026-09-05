import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NoteRef } from '@graphite/bindings';

const QUERY_CAP = 8;
const NOTE_CAP = 8;

export interface VaultRecents {
  queries: string[];
  notes: NoteRef[];
}

export interface RecentsStore {
  byVault: Record<string, VaultRecents>;
  rememberQuery(vault: string, query: string): void;
  forgetQuery(vault: string, query: string): void;
  rememberNote(vault: string, ref: NoteRef): void;
  forgetNote(vault: string, ref: NoteRef): void;
  remapNote(vault: string, oldRef: NoteRef, nextRef: NoteRef): void;
  dropNote(vault: string, ref: NoteRef): void;
  queriesOf(vault: string): string[];
  notesOf(vault: string): NoteRef[];
}

function foldQuery(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е');
}

function slotOf(byVault: Record<string, VaultRecents>, vault: string): VaultRecents {
  return byVault[vault] ?? { queries: [], notes: [] };
}

function writeSlot(
  byVault: Record<string, VaultRecents>,
  vault: string,
  next: VaultRecents,
): Record<string, VaultRecents> {
  if (next.queries.length === 0 && next.notes.length === 0) {
    const { [vault]: _, ...rest } = byVault;
    return rest;
  }
  return { ...byVault, [vault]: next };
}

function sanitizeRecents(value: unknown): Record<string, VaultRecents> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const result: Record<string, VaultRecents> = {};
  for (const [vault, slot] of Object.entries(value as Record<string, unknown>)) {
    if (typeof slot !== 'object' || slot === null) {
      continue;
    }
    const raw = slot as Partial<VaultRecents>;
    const queries = Array.isArray(raw.queries)
      ? [...new Set(raw.queries.filter((item): item is string => typeof item === 'string' && item.trim().length >= 2))]
          .slice(0, QUERY_CAP)
      : [];
    const notes = Array.isArray(raw.notes)
      ? [...new Set(raw.notes.filter((item): item is NoteRef => typeof item === 'string' && item.length > 0))].slice(
          0,
          NOTE_CAP,
        )
      : [];
    if (queries.length > 0 || notes.length > 0) {
      result[vault] = { queries, notes };
    }
  }
  return result;
}

export const useRecentsStore = create<RecentsStore>()(
  persist(
    (set, get) => ({
      byVault: {},
      queriesOf: (vault) => get().byVault[vault]?.queries ?? [],
      notesOf: (vault) => get().byVault[vault]?.notes ?? [],
      rememberQuery: (vault, query) => {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
          return;
        }
        const folded = foldQuery(trimmed);
        set((s) => {
          const current = slotOf(s.byVault, vault);
          const rest = current.queries.filter((item) => foldQuery(item) !== folded);
          return { byVault: writeSlot(s.byVault, vault, { ...current, queries: [trimmed, ...rest].slice(0, QUERY_CAP) }) };
        });
      },
      forgetQuery: (vault, query) => {
        const folded = foldQuery(query);
        set((s) => {
          const current = slotOf(s.byVault, vault);
          return {
            byVault: writeSlot(s.byVault, vault, {
              ...current,
              queries: current.queries.filter((item) => foldQuery(item) !== folded),
            }),
          };
        });
      },
      rememberNote: (vault, ref) => {
        set((s) => {
          const current = slotOf(s.byVault, vault);
          const rest = current.notes.filter((item) => item !== ref);
          return { byVault: writeSlot(s.byVault, vault, { ...current, notes: [ref, ...rest].slice(0, NOTE_CAP) }) };
        });
      },
      forgetNote: (vault, ref) => {
        set((s) => {
          const current = slotOf(s.byVault, vault);
          return { byVault: writeSlot(s.byVault, vault, { ...current, notes: current.notes.filter((item) => item !== ref) }) };
        });
      },
      remapNote: (vault, oldRef, nextRef) => {
        set((s) => {
          const current = slotOf(s.byVault, vault);
          if (!current.notes.includes(oldRef)) {
            return s;
          }
          const notes = current.notes.map((item) => (item === oldRef ? nextRef : item));
          const unique = [...new Set(notes)];
          return { byVault: writeSlot(s.byVault, vault, { ...current, notes: unique }) };
        });
      },
      dropNote: (vault, ref) => {
        get().forgetNote(vault, ref);
      },
    }),
    {
      name: 'graphite.recents',
      partialize: (s) => ({ byVault: s.byVault }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Pick<RecentsStore, 'byVault'>>;
        return { ...current, byVault: sanitizeRecents(saved.byVault) };
      },
    },
  ),
);
