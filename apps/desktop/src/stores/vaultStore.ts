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
import { parseFrontmatter, splitFrontmatter } from '@graphite/editor';
import { useNavStore } from './navStore';
import { useRecentsStore } from './recentsStore';
import { useTabsStore } from './tabsStore';
import { useUiStore } from './uiStore';
import { useVaultsStore, vaultKey } from './vaultsStore';
import { WELCOME_NOTE_REF, flushPendingSaves, pendingSaveFor } from '../components/editor/editorSession';
import { fetchVaultTreeAll } from '../lib/vaultTreePages';

function recentsVault(root: string | undefined): string | undefined {
  return root === undefined ? undefined : vaultKey(root);
}

export interface NoteIconInfo {
  icon?: string;
  color?: string;
}

export interface CreateNoteOptions {
  parent?: NoteRef;
  /** Создать рядом с этой заметкой (в той же папке), а не как дочернюю. */
  beside?: NoteRef;
  title?: string;
  type?: NoteType;
}

export interface VaultStore {
  info?: VaultInfoResponse;
  tree: TreeNode[];
  childrenByRef: Record<NoteRef, TreeNode[]>;
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
  flashNote(ref: NoteRef): void;
  applyNoteChanged(e: NoteChangedEvent): void;
  setIndexStatus(s: IndexProgressEvent): void;
  createNote(opts?: CreateNoteOptions): Promise<NoteRef | undefined>;
  duplicateNote(ref: NoteRef): Promise<void>;
  createFolder(parent?: NoteRef, title?: string): Promise<NoteRef | undefined>;
  addPathNotes(paths: string[], parent?: NoteRef): Promise<number>;
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

/** Каталог-родитель по ссылке: folder-note и лист сводятся к своей папке. */
function dirFromRef(ref: NoteRef): string {
  const raw = ref.startsWith('path:') ? ref.slice('path:'.length) : ref;
  const rel = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.endsWith('/_index.md')) {
    return rel.slice(0, -'/_index.md'.length);
  }
  if (rel.toLowerCase() === '_index.md') {
    return '';
  }
  if (rel.toLowerCase().endsWith('.md')) {
    return rel.slice(0, -'.md'.length);
  }
  return rel;
}

/** Зеркало `writer::sanitize_file_name`: безопасное имя файла/папки под Windows. */
function sanitizeFileName(title: string): string {
  const forbidden = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
  let mapped = '';
  for (const ch of title) {
    mapped += forbidden.has(ch) || ch.charCodeAt(0) < 0x20 ? '—' : ch;
  }
  let stem = mapped.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  const budget = 117;
  const chars = [...stem];
  if (chars.length > budget) {
    stem = `${chars
      .slice(0, budget - 1)
      .join('')
      .replace(/[ .]+$/, '')}…`;
  }
  if (stem.length === 0) {
    stem = 'Без названия';
  }
  if (stem === '_index') {
    stem = '_index—';
  }
  return stem;
}

/** Каталог, в котором лежит заметка (сосед, не «дети этой заметки»). */
function siblingDirFromRef(ref: NoteRef): string {
  const raw = ref.startsWith('path:') ? ref.slice('path:'.length) : ref;
  const rel = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.endsWith('/_index.md')) {
    const folder = rel.slice(0, -'/_index.md'.length);
    const slash = folder.lastIndexOf('/');
    return slash < 0 ? '' : folder.slice(0, slash);
  }
  if (rel.toLowerCase() === '_index.md') {
    return '';
  }
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? '' : rel.slice(0, slash);
}

function siblingParentRef(ref: NoteRef): NoteRef {
  const dir = siblingDirFromRef(ref);
  return dir === '' ? 'path:' : `path:${dir}`;
}

function copyNoteTitle(title: string, taken: Set<string>): string {
  const base = title.trim().length > 0 ? title.trim() : 'Без названия';
  for (let n = 1; n < 500; n += 1) {
    const next = n === 1 ? `${base} (копия)` : `${base} (копия ${n})`;
    if (!taken.has(sanitizeFileName(next).toLowerCase())) {
      return next;
    }
  }
  return `${base} (копия)`;
}

function tagsFromContent(content: string): string[] | undefined {
  const parsed = parseFrontmatter(content);
  if (parsed === null) {
    return undefined;
  }
  const entry = parsed.entries.find((item) => item.key === 'tags');
  if (entry === undefined) {
    return undefined;
  }
  const items = entry.items.length > 0 ? [...entry.items] : entry.value.length > 0 ? [entry.value] : [];
  return items.length > 0 ? items : undefined;
}

/** Имена прямых детей каталога (файлы без `.md` и подпапки), в нижнем регистре. */
function childNames(tree: readonly TreeNode[], parentDir: string): Set<string> {
  const prefix = parentDir === '' ? '' : `${parentDir}/`;
  const names = new Set<string>();
  for (const node of tree) {
    if (prefix !== '' && !node.path.startsWith(prefix)) {
      continue;
    }
    const segment = node.path.slice(prefix.length).split('/')[0] ?? '';
    if (segment.length === 0) {
      continue;
    }
    const name = segment.toLowerCase();
    names.add(name.endsWith('.md') ? name.slice(0, -'.md'.length) : name);
  }
  return names;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isoNowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(): string {
  const chars = new Array<string>(26);
  let time = Date.now();
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = ULID_ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  for (let i = 0; i < 16; i += 1) {
    chars[10 + i] = ULID_ALPHABET[random[i] % 32];
  }
  return chars.join('');
}

/** Итог слияния keep/clear/set-семантики `set_icon` поверх прежних значений. */
function mergeIconField(next: string | undefined, prev: string | undefined): string | undefined {
  if (next === undefined) {
    return prev;
  }
  return next === '' ? undefined : next;
}

const NOTE_CHANGED_DEBOUNCE_MS = 180;
/** Автосейв тела (`bufferbody`) не меняет структуру vault, поэтому дерево и
 *  счётчики догоняют ленивым дебаунсом — иначе каждые ~600 мс печати запускали
 *  бы два полных скана хранилища. */
const BUFFER_BODY_DEBOUNCE_MS = 2000;

let treeLoadSeq = 0;
let noteChangedTimer: ReturnType<typeof setTimeout> | undefined;
let bufferBodyTimer: ReturnType<typeof setTimeout> | undefined;

export const useVaultStore = create<VaultStore>()((set, get) => ({
  info: undefined,
  tree: [],
  childrenByRef: {},
  currentRef: undefined,
  indexStatus: { state: 'idle', done: 0, total: 0 },
  pinnedNotes: new Set<NoteRef>(),
  iconByRef: {},
  loadInfo: async () => {
    try {
      set({ info: await commands.vaultInfo() });
    } catch {
      // сохраняем прежние сведения: разовый сбой обновления не должен ронять UI в экран выбора хранилища
    }
  },
  loadTree: async (root) => {
    const seq = (treeLoadSeq += 1);
    const full = root === undefined;
    try {
      const nodes = await fetchVaultTreeAll({ root });
      if (seq !== treeLoadSeq) {
        return;
      }
      set((s) => {
        const iconByRef: Record<NoteRef, NoteIconInfo> = full ? {} : { ...s.iconByRef };
        const pinnedNotes = full ? new Set<NoteRef>() : new Set(s.pinnedNotes);
        for (const node of nodes) {
          if (node.icon !== undefined || node.iconColor !== undefined) {
            iconByRef[node.ref] = { icon: node.icon, color: node.iconColor };
          }
          if (node.pinned === true) {
            pinnedNotes.add(node.ref);
          }
        }
        // Полная перезагрузка от вотчера/автосейва часто приносит идентичный набор
        // узлов. Сохраняем прежние ссылки tree и pinnedNotes, если ничего рендеримого
        // не изменилось, — иначе каждый no-op пересобирает forest и все useMemo([tree]).
        const same =
          full &&
          s.tree.length === nodes.length &&
          nodes.every((n, i) => {
            const p = s.tree[i];
            return (
              p !== undefined &&
              p.ref === n.ref &&
              p.path === n.path &&
              p.title === n.title &&
              p.type === n.type &&
              p.status === n.status &&
              p.childrenCount === n.childrenCount &&
              p.updated === n.updated &&
              p.icon === n.icon &&
              p.iconColor === n.iconColor &&
              p.pinned === n.pinned
            );
          });
        const pinnedSame =
          pinnedNotes.size === s.pinnedNotes.size &&
          [...pinnedNotes].every((ref) => s.pinnedNotes.has(ref));
        return {
          tree: same ? s.tree : nodes,
          iconByRef,
          pinnedNotes: pinnedSame ? s.pinnedNotes : pinnedNotes,
        };
      });
    } catch {
      if (seq === treeLoadSeq) {
        set({ tree: [] });
      }
    }
  },
  loadChildren: async (ref) => {
    try {
      const nodes = await fetchVaultTreeAll({ root: ref, depth: 1 });
      set((s) => ({ childrenByRef: { ...s.childrenByRef, [ref]: nodes } }));
    } catch {
      set((s) => ({ childrenByRef: { ...s.childrenByRef, [ref]: [] } }));
    }
  },
  openVault: async (path) => {
    const info = await commands.vaultOpen(path);
    set({ info });
    useVaultsStore.getState().remember(info.root);
    await get().loadTree();
  },
  createVault: async (path) => {
    const info = await commands.vaultCreate(path);
    set({ info });
    useVaultsStore.getState().remember(info.root);
    await get().loadTree();
  },
  openNote: (ref) => {
    useTabsStore.getState().open(ref);
    if (get().currentRef !== ref) {
      set({ currentRef: ref });
      useNavStore.getState().record(ref);
    }
    const vault = recentsVault(get().info?.root);
    if (vault !== undefined && ref !== WELCOME_NOTE_REF) {
      useRecentsStore.getState().rememberNote(vault, ref);
      useUiStore.getState().setLastNoteRef(ref);
    }
  },
  flashNote: (ref) => {
    set({ currentRef: ref });
  },
  applyNoteChanged: (e) => {
    if (e.kind === 'bufferbody') {
      if (noteChangedTimer !== undefined) {
        return;
      }
      if (bufferBodyTimer !== undefined) {
        clearTimeout(bufferBodyTimer);
      }
      bufferBodyTimer = setTimeout(() => {
        bufferBodyTimer = undefined;
        void get().loadTree();
        void get().loadInfo();
      }, BUFFER_BODY_DEBOUNCE_MS);
      return;
    }
    if (bufferBodyTimer !== undefined) {
      clearTimeout(bufferBodyTimer);
      bufferBodyTimer = undefined;
    }
    if (noteChangedTimer !== undefined) {
      clearTimeout(noteChangedTimer);
    }
    noteChangedTimer = setTimeout(() => {
      noteChangedTimer = undefined;
      void get().loadTree();
      void get().loadInfo();
    }, NOTE_CHANGED_DEBOUNCE_MS);
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
  createNote: async (opts) => {
    try {
      const parent =
        opts?.beside !== undefined && opts.beside !== WELCOME_NOTE_REF
          ? siblingParentRef(opts.beside)
          : opts?.parent;
      const created = await commands.noteCreate({
        title: opts?.title ?? 'Новая заметка',
        parent,
        type: opts?.type,
      });
      await get().loadTree();
      void get().loadInfo();
      get().openNote(created.ref);
      return created.ref;
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось создать заметку') });
      return undefined;
    }
  },
  duplicateNote: async (ref) => {
    if (ref === WELCOME_NOTE_REF) {
      useUiStore.getState().pushToast({ kind: 'info', text: 'Стартовую страницу нельзя дублировать' });
      return;
    }
    const source = get().tree.find((node) => node.ref === ref);
    const icon = get().iconByRef[ref];
    try {
      await flushPendingSaves();
      await pendingSaveFor(ref);
      const read = await commands.noteRead({ ref });
      const body = splitFrontmatter(read.content)?.body ?? read.content;
      const taken = childNames(get().tree, siblingDirFromRef(ref));
      const fmTitle = parseFrontmatter(read.content)?.entries.find((entry) => entry.key === 'title')?.value;
      const title = copyNoteTitle(
        source?.title ?? (fmTitle !== undefined && fmTitle.length > 0 ? fmTitle : 'Заметка'),
        taken,
      );
      const created = await commands.noteCreate({
        title,
        parent: siblingParentRef(ref),
        type: source?.type,
        tags: tagsFromContent(read.content),
        content: body,
      });
      await get().loadTree();
      void get().loadInfo();
      if (icon?.icon !== undefined || icon?.color !== undefined) {
        await get().setIcon(created.ref, icon.icon, icon.color);
      }
      get().openNote(created.ref);
      useUiStore.getState().pushToast({ kind: 'success', text: `Создана копия «${title}»` });
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось дублировать заметку') });
    }
  },
  createFolder: async (parent, title) => {
    const name = sanitizeFileName(title ?? 'Новая папка');
    const parentDir = parent === undefined ? '' : dirFromRef(parent);
    const taken = childNames(get().tree, parentDir);
    let stem = name;
    for (let n = 2; taken.has(stem.toLowerCase()); n += 1) {
      stem = `${name} ${n}`;
    }
    const dirRel = parentDir === '' ? stem : `${parentDir}/${stem}`;
    const ref = refFromPath(`${dirRel}/_index.md`);
    const now = isoNowUtc();
    const content = `---\nid: ${ulid()}\ntype: note\ntitle: ${yamlQuote(stem)}\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
    try {
      await commands.bufferSave({ ref, baseRev: '', content });
      await get().loadTree();
      void get().loadInfo();
      return ref;
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось создать папку') });
      return undefined;
    }
  },
  addPathNotes: async (paths, parent) => {
    if (paths.length === 0) {
      return 0;
    }
    try {
      const response = await commands.addPathNote({ paths, parent });
      await get().loadTree();
      void get().loadInfo();
      const count = response.notes.length;
      if (count === 1) {
        get().openNote(response.notes[0].ref);
        useUiStore.getState().pushToast({ kind: 'success', text: 'Файл записан во «Входящие»' });
      } else {
        useUiStore.getState().pushToast({ kind: 'success', text: `Записано во «Входящие»: ${count}` });
      }
      return count;
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось добавить файлы') });
      return 0;
    }
  },
  createBundle: async (params) => {
    try {
      const created = await commands.bundleCreate(params);
      await get().loadTree();
      void get().loadInfo();
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
      useNavStore.getState().remap(ref, nextRef);
      const vault = recentsVault(get().info?.root);
      if (vault !== undefined) {
        useRecentsStore.getState().remapNote(vault, ref, nextRef);
      }
      set((s) => ({ currentRef: s.currentRef === ref ? nextRef : s.currentRef }));
      if (useUiStore.getState().lastNoteRef === ref) {
        useUiStore.getState().setLastNoteRef(nextRef);
      }
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
      useNavStore.getState().drop(ref);
      const vault = recentsVault(get().info?.root);
      if (vault !== undefined) {
        useRecentsStore.getState().dropNote(vault, ref);
      }
      set((s) => ({ currentRef: s.currentRef === ref ? undefined : s.currentRef }));
      if (useUiStore.getState().lastNoteRef === ref) {
        useUiStore.getState().setLastNoteRef(undefined);
      }
      await get().loadTree();
      void get().loadInfo();
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
      void get().loadInfo();
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
      useNavStore.getState().remap(ref, nextRef);
      const vault = recentsVault(get().info?.root);
      if (vault !== undefined) {
        useRecentsStore.getState().remapNote(vault, ref, nextRef);
      }
      set((s) => ({ currentRef: s.currentRef === ref ? nextRef : s.currentRef }));
      await get().loadTree();
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось переместить') });
    }
  },
  setIcon: async (ref, icon, color) => {
    const previous = get().iconByRef[ref];
    const applyEverywhere = (info: NoteIconInfo) => {
      set((s) => ({ iconByRef: { ...s.iconByRef, [ref]: info } }));
      for (const tab of useTabsStore.getState().tabs.filter((t) => t.noteRef === ref)) {
        useTabsStore.getState().setTabIcon(tab.id, info.icon, info.color);
      }
    };
    applyEverywhere({
      icon: mergeIconField(icon, previous?.icon),
      color: mergeIconField(color, previous?.color),
    });
    try {
      const result = await commands.setIcon({ ref, icon, color });
      applyEverywhere({ icon: result.icon, color: result.color });
    } catch (error) {
      applyEverywhere(previous ?? {});
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
