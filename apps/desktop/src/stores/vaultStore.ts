import { create } from 'zustand';
import { commands, isGraphiteError } from '@graphite/bindings';
import type {
  BundleCreateParams,
  IndexProgressEvent,
  IndexStatus,
  NoteChangedEvent,
  NoteRef,
  NoteType,
  TreeNode,
  VaultInfoResponse,
} from '@graphite/bindings';
import { useTabsStore } from './tabsStore';
import { useUiStore } from './uiStore';

export interface NoteIconInfo {
  icon?: string;
  color?: string;
}

export interface CreateNoteOptions {
  parent?: NoteRef;
  title?: string;
  type?: NoteType;
}

export interface VaultStore {
  info?: VaultInfoResponse;
  tree: TreeNode[];
  childrenByRef: Record<NoteRef, TreeNode[]>;
  expanded: Set<string>;
  currentRef?: NoteRef;
  indexStatus: IndexStatus;
  pinnedNotes: Set<NoteRef>;
  iconByRef: Record<NoteRef, NoteIconInfo>;
  loadInfo(): Promise<void>;
  loadTree(root?: NoteRef): Promise<void>;
  loadChildren(ref: NoteRef): Promise<void>;
  openVault(path: string): Promise<void>;
  createVault(path: string): Promise<void>;
  openNote(ref: NoteRef): void;
  applyNoteChanged(e: NoteChangedEvent): void;
  setIndexStatus(s: IndexProgressEvent): void;
  toggleExpanded(path: string): void;
  createNote(opts?: CreateNoteOptions): Promise<void>;
  createBundle(params: BundleCreateParams): Promise<void>;
  rename(ref: NoteRef, title: string): Promise<void>;
  remove(ref: NoteRef): Promise<void>;
  restore(token?: string, ref?: NoteRef): Promise<void>;
  move(ref: NoteRef, parent: NoteRef): Promise<void>;
  setIcon(ref: NoteRef, icon?: string, color?: string): Promise<void>;
  togglePinNote(ref: NoteRef): Promise<void>;
}

function refFromPath(path: string): NoteRef {
  return `path:${path}`;
}

function reason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

export const useVaultStore = create<VaultStore>()((set, get) => ({
  info: undefined,
  tree: [],
  childrenByRef: {},
  expanded: new Set<string>(),
  currentRef: undefined,
  indexStatus: { state: 'idle', done: 0, total: 0 },
  pinnedNotes: new Set<NoteRef>(),
  iconByRef: {},
  loadInfo: async () => {
    try {
      set({ info: await commands.vaultInfo() });
    } catch {
      set({ info: undefined });
    }
  },
  loadTree: async (root) => {
    try {
      const response = await commands.vaultTree({ root });
      set((s) => {
        const iconByRef = { ...s.iconByRef };
        const pinnedNotes = new Set(s.pinnedNotes);
        for (const node of response.nodes) {
          if (node.icon !== undefined || node.iconColor !== undefined) {
            iconByRef[node.ref] = { icon: node.icon, color: node.iconColor };
          }
          if (node.pinned === true) {
            pinnedNotes.add(node.ref);
          }
        }
        return { tree: response.nodes, iconByRef, pinnedNotes };
      });
    } catch {
      set({ tree: [] });
    }
  },
  loadChildren: async (ref) => {
    try {
      const response = await commands.vaultTree({ root: ref, depth: 1 });
      set((s) => ({ childrenByRef: { ...s.childrenByRef, [ref]: response.nodes } }));
    } catch {
      set((s) => ({ childrenByRef: { ...s.childrenByRef, [ref]: [] } }));
    }
  },
  openVault: async (path) => {
    const info = await commands.vaultOpen(path);
    set({ info });
    await get().loadTree();
  },
  createVault: async (path) => {
    const info = await commands.vaultCreate(path);
    set({ info });
    await get().loadTree();
  },
  openNote: (ref) => {
    useTabsStore.getState().open(ref);
    set({ currentRef: ref });
  },
  applyNoteChanged: () => {
    void get().loadTree();
  },
  setIndexStatus: (e) => {
    set({
      indexStatus: {
        state: e.done >= e.total ? 'idle' : 'indexing',
        done: e.done,
        total: e.total,
      },
    });
  },
  toggleExpanded: (path) => {
    set((s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(path)) {
        expanded.delete(path);
      } else {
        expanded.add(path);
      }
      return { expanded };
    });
  },
  createNote: async (opts) => {
    try {
      const created = await commands.noteCreate({
        title: opts?.title ?? 'Новая заметка',
        parent: opts?.parent,
        type: opts?.type,
      });
      await get().loadTree();
      get().openNote(created.ref);
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось создать заметку') });
    }
  },
  createBundle: async (params) => {
    try {
      const created = await commands.bundleCreate(params);
      await get().loadTree();
      get().openNote(created.ref);
      useUiStore.getState().pushToast({ kind: 'success', text: 'Коллекция создана' });
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось собрать коллекцию') });
    }
  },
  rename: async (ref, title) => {
    try {
      const result = await commands.noteRename({ ref, newTitle: title });
      const nextRef = refFromPath(result.pathNew);
      useTabsStore.getState().remapRef(ref, { ref: nextRef, title });
      set((s) => ({ currentRef: s.currentRef === ref ? nextRef : s.currentRef }));
      await get().loadTree();
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось переименовать') });
    }
  },
  remove: async (ref) => {
    try {
      const result = await commands.noteDelete({ ref });
      for (const tab of useTabsStore.getState().tabs.filter((t) => t.noteRef === ref)) {
        useTabsStore.getState().close(tab.id);
      }
      set((s) => ({ currentRef: s.currentRef === ref ? undefined : s.currentRef }));
      await get().loadTree();
      useUiStore.getState().pushToast({
        kind: 'info',
        text: 'Заметка перемещена в корзину',
        action: { label: 'Отменить', run: () => void get().restore(result.restoreToken) },
      });
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось удалить') });
    }
  },
  restore: async (token, ref) => {
    try {
      await commands.noteRestore({ restoreToken: token, ref });
      await get().loadTree();
      useUiStore.getState().pushToast({ kind: 'success', text: 'Заметка восстановлена' });
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось восстановить') });
    }
  },
  move: async (ref, parent) => {
    try {
      const result = await commands.noteMove({ ref, newParent: parent });
      const nextRef = refFromPath(result.pathNew);
      const title = useTabsStore.getState().tabs.find((t) => t.noteRef === ref)?.title ?? '';
      useTabsStore.getState().remapRef(ref, { ref: nextRef, title });
      set((s) => ({ currentRef: s.currentRef === ref ? nextRef : s.currentRef }));
      await get().loadTree();
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось переместить') });
    }
  },
  setIcon: async (ref, icon, color) => {
    const previous = get().iconByRef[ref];
    set((s) => ({ iconByRef: { ...s.iconByRef, [ref]: { icon, color } } }));
    for (const tab of useTabsStore.getState().tabs.filter((t) => t.noteRef === ref)) {
      useTabsStore.getState().setTabIcon(tab.id, icon, color);
    }
    try {
      await commands.setIcon({ ref, icon, color });
    } catch (error) {
      set((s) => ({ iconByRef: { ...s.iconByRef, [ref]: previous ?? {} } }));
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось задать иконку') });
    }
  },
  togglePinNote: async (ref) => {
    const nextPinned = !get().pinnedNotes.has(ref);
    set((s) => {
      const pinnedNotes = new Set(s.pinnedNotes);
      if (nextPinned) {
        pinnedNotes.add(ref);
      } else {
        pinnedNotes.delete(ref);
      }
      return { pinnedNotes };
    });
    try {
      await commands.notePin({ ref, pinned: nextPinned });
    } catch (error) {
      set((s) => {
        const pinnedNotes = new Set(s.pinnedNotes);
        if (nextPinned) {
          pinnedNotes.delete(ref);
        } else {
          pinnedNotes.add(ref);
        }
        return { pinnedNotes };
      });
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось закрепить') });
    }
  },
}));
