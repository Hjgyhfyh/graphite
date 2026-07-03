import { create } from 'zustand';
import { commands } from '@graphite/bindings';
import type {
  IndexProgressEvent,
  IndexStatus,
  NoteChangedEvent,
  NoteRef,
  TreeNode,
  VaultInfoResponse,
} from '@graphite/bindings';
import { useTabsStore } from './tabsStore';

export interface VaultStore {
  info?: VaultInfoResponse;
  tree: TreeNode[];
  expanded: Set<string>;
  currentRef?: NoteRef;
  indexStatus: IndexStatus;
  loadInfo(): Promise<void>;
  loadTree(root?: NoteRef): Promise<void>;
  openVault(path: string): Promise<void>;
  createVault(path: string): Promise<void>;
  openNote(ref: NoteRef): void;
  applyNoteChanged(e: NoteChangedEvent): void;
  setIndexStatus(s: IndexProgressEvent): void;
  toggleExpanded(path: string): void;
}

export const useVaultStore = create<VaultStore>()((set, get) => ({
  info: undefined,
  tree: [],
  expanded: new Set<string>(),
  currentRef: undefined,
  indexStatus: { state: 'idle', done: 0, total: 0 },
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
      set({ tree: response.nodes });
    } catch {
      set({ tree: [] });
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
}));
