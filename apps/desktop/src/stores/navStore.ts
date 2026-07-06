import { create } from 'zustand';
import type { NoteRef } from '@graphite/bindings';
import { useVaultStore } from './vaultStore';

const HISTORY_CAP = 100;

export interface NavStore {
  past: NoteRef[];
  future: NoteRef[];
  current?: NoteRef;
  record(ref: NoteRef): void;
  back(): void;
  forward(): void;
  remap(oldRef: NoteRef, nextRef: NoteRef): void;
  drop(ref: NoteRef): void;
}

/**
 * Флаг переживает ре-рендеры (модульный уровень, как таймеры в других сторах):
 * во время программного перехода back/forward вызванный openNote не должен
 * записывать шаг обратно в историю — иначе стек зациклится сам на себе.
 */
let replaying = false;

/** История посещений заметок — эфемерная, живёт только внутри сессии (без persist). */
export const useNavStore = create<NavStore>()((set, get) => ({
  past: [],
  future: [],
  current: undefined,
  record: (ref) => {
    if (replaying) {
      return;
    }
    const { past, current } = get();
    if (current === ref) {
      return;
    }
    set({
      past: current === undefined ? past : [...past, current].slice(-HISTORY_CAP),
      current: ref,
      future: [],
    });
  },
  back: () => {
    const { past, future, current } = get();
    if (past.length === 0) {
      return;
    }
    const target = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      future: current === undefined ? future : [current, ...future].slice(0, HISTORY_CAP),
      current: target,
    });
    replaying = true;
    try {
      useVaultStore.getState().openNote(target);
    } finally {
      replaying = false;
    }
  },
  forward: () => {
    const { past, future, current } = get();
    if (future.length === 0) {
      return;
    }
    const target = future[0];
    set({
      future: future.slice(1),
      past: current === undefined ? past : [...past, current].slice(-HISTORY_CAP),
      current: target,
    });
    replaying = true;
    try {
      useVaultStore.getState().openNote(target);
    } finally {
      replaying = false;
    }
  },
  remap: (oldRef, nextRef) => {
    if (oldRef === nextRef) {
      return;
    }
    const swap = (ref: NoteRef): NoteRef => (ref === oldRef ? nextRef : ref);
    set((s) => ({
      past: s.past.map(swap),
      future: s.future.map(swap),
      current: s.current === undefined ? undefined : swap(s.current),
    }));
  },
  drop: (ref) => {
    set((s) => ({
      past: s.past.filter((entry) => entry !== ref),
      future: s.future.filter((entry) => entry !== ref),
      current: s.current === ref ? undefined : s.current,
    }));
  },
}));
