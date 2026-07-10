import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';

export interface TreeStateStore {
  expandedByVault: Record<string, string[]>;
  getExpanded(vault: string): string[];
  setExpanded(vault: string, ids: string[]): void;
  toggle(vault: string, id: string, open: boolean): void;
}

const WRITE_DELAY_MS = 250;

/**
 * localStorage с отложенной записью: каждый клик по папке дёргает persist, а
 * «Развернуть все» на большом дереве — тысячи id за раз. Синхронный setItem на
 * каждое изменение здесь ни к чему, поэтому пишем хвостом с задержкой, а при
 * закрытии или сворачивании окна сбрасываем его досрочно, чтобы не потерять
 * последний клик.
 */
function createLazyLocalStorage(): StateStorage {
  let timer: number | undefined;
  let pending: { key: string; value: string } | undefined;
  const flush = () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) {
      return;
    }
    const { key, value } = pending;
    pending = undefined;
    try {
      localStorage.setItem(key, value);
    } catch {
      // квота или приватный режим — состояние доживёт до конца сессии в памяти
    }
  };
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  });
  return {
    getItem: (key) => (pending !== undefined && pending.key === key ? pending.value : localStorage.getItem(key)),
    setItem: (key, value) => {
      pending = { key, value };
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, WRITE_DELAY_MS);
    },
    removeItem: (key) => {
      if (pending !== undefined && pending.key === key) {
        pending = undefined;
        window.clearTimeout(timer);
        timer = undefined;
      }
      localStorage.removeItem(key);
    },
  };
}

function sanitizeExpandedMap(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [vault, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    if (unique.length > 0) {
      result[vault] = unique;
    }
  }
  return result;
}

/**
 * Раскрытые папки дерева заметок per-vault; ключ — канонический `vaultKey`
 * корня хранилища. Храним именно раскрытые, а не свёрнутые: по умолчанию всё
 * свёрнуто, и новые или незнакомые папки стартуют закрытыми без миграций.
 */
export const useTreeStateStore = create<TreeStateStore>()(
  persist(
    (set, get) => ({
      expandedByVault: {},
      getExpanded: (vault) => get().expandedByVault[vault] ?? [],
      setExpanded: (vault, ids) => {
        set((s) => ({ expandedByVault: { ...s.expandedByVault, [vault]: [...new Set(ids)] } }));
      },
      toggle: (vault, id, open) => {
        set((s) => {
          const current = s.expandedByVault[vault] ?? [];
          if (current.includes(id) === open) {
            return s;
          }
          const next = open ? [...current, id] : current.filter((item) => item !== id);
          return { expandedByVault: { ...s.expandedByVault, [vault]: next } };
        });
      },
    }),
    {
      name: 'graphite.treeState',
      storage: createJSONStorage(createLazyLocalStorage),
      partialize: (s) => ({ expandedByVault: s.expandedByVault }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Pick<TreeStateStore, 'expandedByVault'>>;
        return { ...current, expandedByVault: sanitizeExpandedMap(saved.expandedByVault) };
      },
    },
  ),
);
