import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { basename } from '../components/explorer/explorerFormat';

// Состояние раздела «Проводник»: открытые панели (папки/файлы) и закладки путей.
// Персист локальный (localStorage, ключ graphite.explorer), на сервер не синкается.
// Загруженные списки файлов в сторе НЕ держим — панель хранит только путь и
// историю навигации, содержимое перечитывается через fs_list_dir при монтировании.

export type ExplorerPaneKind = 'folder' | 'file';

export interface ExplorerPane {
  id: string;
  kind: ExplorerPaneKind;
  path: string;
  /** Пути, куда можно вернуться (стек «назад»). */
  back: string[];
  /** Пути «вперёд» после «назад». */
  forward: string[];
}

export interface SavedPath {
  id: string;
  path: string;
  name: string;
  order: number;
}

export interface ExplorerStore {
  panes: ExplorerPane[];
  saved: SavedPath[];
  showHidden: boolean;
  openFolderPane(path: string): void;
  openFilePane(path: string): void;
  closePane(id: string): void;
  navigate(id: string, path: string): void;
  back(id: string): void;
  forward(id: string): void;
  addSaved(path: string, name?: string): void;
  removeSaved(id: string): void;
  renameSaved(id: string, name: string): void;
  reorderSaved(ids: string[]): void;
  toggleHidden(): void;
}

const SAVED_NAME_MAX = 40;
const MAX_HISTORY = 100;

function newId(): string {
  return crypto.randomUUID();
}

function sanitizePathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(-MAX_HISTORY);
}

function sanitizePanes(raw: unknown): ExplorerPane[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ExplorerPane[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const pane = item as Partial<ExplorerPane>;
    if (typeof pane.path !== 'string' || pane.path.length === 0) {
      continue;
    }
    out.push({
      id: typeof pane.id === 'string' && pane.id.length > 0 ? pane.id : newId(),
      kind: pane.kind === 'file' ? 'file' : 'folder',
      path: pane.path,
      back: sanitizePathList(pane.back),
      forward: sanitizePathList(pane.forward),
    });
  }
  return out;
}

function sanitizeSaved(raw: unknown): SavedPath[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SavedPath[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const saved = item as Partial<SavedPath>;
    if (typeof saved.path !== 'string' || saved.path.length === 0) {
      continue;
    }
    const name =
      typeof saved.name === 'string' && saved.name.trim().length > 0
        ? saved.name.trim().slice(0, SAVED_NAME_MAX)
        : basename(saved.path);
    out.push({
      id: typeof saved.id === 'string' && saved.id.length > 0 ? saved.id : newId(),
      path: saved.path,
      name,
      order: typeof saved.order === 'number' && Number.isFinite(saved.order) ? saved.order : out.length,
    });
  }
  out.sort((a, b) => a.order - b.order);
  return out.map((saved, index) => ({ ...saved, order: index }));
}

export const useExplorerStore = create<ExplorerStore>()(
  persist(
    (set) => ({
      panes: [],
      saved: [],
      showHidden: false,
      openFolderPane: (path) => {
        set((s) => ({ panes: [...s.panes, { id: newId(), kind: 'folder', path, back: [], forward: [] }] }));
      },
      openFilePane: (path) => {
        set((s) => ({ panes: [...s.panes, { id: newId(), kind: 'file', path, back: [], forward: [] }] }));
      },
      closePane: (id) => {
        set((s) => ({ panes: s.panes.filter((pane) => pane.id !== id) }));
      },
      navigate: (id, path) => {
        set((s) => ({
          panes: s.panes.map((pane) => {
            if (pane.id !== id || pane.path === path) {
              return pane;
            }
            return { ...pane, path, back: [...pane.back, pane.path].slice(-MAX_HISTORY), forward: [] };
          }),
        }));
      },
      back: (id) => {
        set((s) => ({
          panes: s.panes.map((pane) => {
            if (pane.id !== id || pane.back.length === 0) {
              return pane;
            }
            const back = pane.back.slice();
            const prev = back.pop() as string;
            return { ...pane, path: prev, back, forward: [pane.path, ...pane.forward].slice(0, MAX_HISTORY) };
          }),
        }));
      },
      forward: (id) => {
        set((s) => ({
          panes: s.panes.map((pane) => {
            if (pane.id !== id || pane.forward.length === 0) {
              return pane;
            }
            const forward = pane.forward.slice();
            const next = forward.shift() as string;
            return { ...pane, path: next, back: [...pane.back, pane.path].slice(-MAX_HISTORY), forward };
          }),
        }));
      },
      addSaved: (path, name) => {
        set((s) => {
          if (s.saved.some((saved) => saved.path.toLowerCase() === path.toLowerCase())) {
            return s;
          }
          const order = s.saved.reduce((max, saved) => Math.max(max, saved.order), -1) + 1;
          const label = (name ?? basename(path)).trim().slice(0, SAVED_NAME_MAX);
          return {
            saved: [
              ...s.saved,
              { id: newId(), path, name: label.length > 0 ? label : basename(path), order },
            ],
          };
        });
      },
      removeSaved: (id) => {
        set((s) => ({ saved: s.saved.filter((saved) => saved.id !== id) }));
      },
      renameSaved: (id, name) => {
        const label = name.trim().slice(0, SAVED_NAME_MAX);
        if (label.length === 0) {
          return;
        }
        set((s) => ({ saved: s.saved.map((saved) => (saved.id === id ? { ...saved, name: label } : saved)) }));
      },
      reorderSaved: (ids) => {
        set((s) => {
          const byId = new Map(s.saved.map((saved) => [saved.id, saved]));
          const next: SavedPath[] = [];
          ids.forEach((id) => {
            const saved = byId.get(id);
            if (saved !== undefined) {
              next.push({ ...saved, order: next.length });
              byId.delete(id);
            }
          });
          for (const saved of byId.values()) {
            next.push({ ...saved, order: next.length });
          }
          return { saved: next };
        });
      },
      toggleHidden: () => {
        set((s) => ({ showHidden: !s.showHidden }));
      },
    }),
    {
      name: 'graphite.explorer',
      partialize: (s) => ({ panes: s.panes, saved: s.saved, showHidden: s.showHidden }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<ExplorerStore>;
        return {
          ...current,
          panes: sanitizePanes(saved.panes),
          saved: sanitizeSaved(saved.saved),
          showHidden: saved.showHidden === true,
        };
      },
    },
  ),
);
