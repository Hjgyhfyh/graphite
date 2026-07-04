import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'motion/react';
import { Tree } from 'react-arborist';
import type {
  CursorProps,
  MoveHandler,
  NodeApi,
  NodeRendererProps,
  RenameHandler,
  RowRendererProps,
  TreeApi,
} from 'react-arborist';
import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  ChevronRight,
  Columns2,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderSymlink,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react';
import type { NoteRef, TreeNode } from '@graphite/bindings';
import { commands } from '@graphite/bindings';
import { Kbd, STAGGER_CAP, cx } from '@graphite/ui';
import { useActionHandler } from '../../app/Keymap';
import { springSnappy, springStandard, usePrefersReducedMotion } from '../../motion';
import { usePanesStore } from '../../stores/panesStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import type { NoteIconInfo } from '../../stores/vaultStore';
import { IconPicker } from './IconPicker';
import { NoteIcon } from './NoteIcon';

export interface TreePanelProps {
  width: number;
  onWidthChange: (w: number) => void;
}

const ROW_HEIGHT = 30;
const INDENT = 14;
const INDEX_SUFFIX = '/_index.md';
const ROOT_REF: NoteRef = 'path:';
const STAGGER_STEP = 0.018;

const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';

interface ArNode {
  id: string;
  ref: NoteRef;
  path: string;
  name: string;
  isFolder: boolean;
  virtual?: boolean;
  updated: string;
  children: ArNode[] | null;
}

interface IconRequest {
  ref: NoteRef;
  icon?: string;
  color?: string;
  point: { x: number; y: number };
}

interface NodeTreeContext {
  activeRef?: NoteRef;
  pinnedNotes: Set<NoteRef>;
  iconByRef: Record<NoteRef, NoteIconInfo>;
  justOpened?: string;
  justMoved?: string;
  reduced: boolean;
  openNote: (ref: NoteRef) => void;
  openInNewPane: (ref: NoteRef) => void;
  startRename: (node: NodeApi<ArNode>) => void;
  requestIcon: (request: IconRequest) => void;
  togglePin: (ref: NoteRef) => void;
  remove: (ref: NoteRef) => void;
}

const NodeCtx = createContext<NodeTreeContext | null>(null);

function useNodeCtx(): NodeTreeContext {
  const ctx = useContext(NodeCtx);
  if (ctx === null) {
    throw new Error('NodeCtx недоступен');
  }
  return ctx;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function buildForest(nodes: readonly TreeNode[]): ArNode[] {
  const folderByKey = new Map<string, ArNode>();
  const fileNodes: ArNode[] = [];

  for (const node of nodes) {
    const isFolder = node.path.endsWith(INDEX_SUFFIX);
    const ar: ArNode = {
      id: node.ref,
      ref: node.ref,
      path: node.path,
      name: node.title,
      isFolder,
      updated: node.updated,
      children: isFolder ? [] : null,
    };
    if (isFolder) {
      folderByKey.set(node.path.slice(0, -INDEX_SUFFIX.length), ar);
    } else {
      fileNodes.push(ar);
    }
  }

  const ensureChain = (dir: string) => {
    let cur = dir;
    while (cur !== '' && !folderByKey.has(cur)) {
      folderByKey.set(cur, {
        id: `path:${cur}`,
        ref: `path:${cur}`,
        path: cur,
        name: baseName(cur),
        isFolder: true,
        virtual: true,
        updated: '',
        children: [],
      });
      cur = dirOf(cur);
    }
  };

  for (const key of [...folderByKey.keys()]) {
    ensureChain(dirOf(key));
  }
  for (const file of fileNodes) {
    ensureChain(dirOf(file.path));
  }

  const parentFor = (dir: string): ArNode | undefined => {
    let cur = dir;
    while (cur !== '') {
      const found = folderByKey.get(cur);
      if (found !== undefined) {
        return found;
      }
      cur = dirOf(cur);
    }
    return undefined;
  };

  const roots: ArNode[] = [];
  const attach = (ar: ArNode, dir: string) => {
    const parent = parentFor(dir);
    if (parent !== undefined && parent.children !== null) {
      parent.children.push(ar);
    } else {
      roots.push(ar);
    }
  };
  for (const [key, ar] of folderByKey) {
    attach(ar, dirOf(key));
  }
  for (const file of fileNodes) {
    attach(file, dirOf(file.path));
  }

  const sortRec = (list: ArNode[]) => {
    list.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, 'ru'));
    for (const child of list) {
      if (child.children !== null) {
        sortRec(child.children);
      }
    }
  };
  sortRec(roots);
  return roots;
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <NoteIcon icon="FileText" size={24} className="text-text-3" />
      <p className="text-ui text-text-1">Создайте первую заметку</p>
      <div className="flex items-center gap-1 text-caption text-text-2">
        <span>или</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>Alt</Kbd>
        <Kbd>Space</Kbd>
      </div>
    </div>
  );
}

function useElementSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const callbackRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (el === null) {
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observerRef.current = observer;
  }, []);
  return [callbackRef, size] as const;
}

function RenameInput({ node }: { node: NodeApi<ArNode> }) {
  const [value, setValue] = useState(node.data.name);
  const stop = (event: ReactPointerEvent<HTMLInputElement>) => event.stopPropagation();
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={stop}
      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          node.submit(value.trim());
        } else if (event.key === 'Escape') {
          event.preventDefault();
          node.reset();
        }
      }}
      onBlur={() => {
        const next = value.trim();
        if (next.length > 0 && next !== node.data.name) {
          node.submit(next);
        } else {
          node.reset();
        }
      }}
      className="h-6 w-full min-w-0 flex-1 rounded-xs border border-stroke-1 bg-bg-2 px-1.5 text-ui text-text-0 outline-none"
    />
  );
}

function Cursor({ top, left, indent }: CursorProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div
      className="pointer-events-none absolute z-10 flex items-center gap-1"
      style={{ top: top - 2, left, right: indent }}
    >
      <span className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-dim)]" />
      <motion.span
        className="h-0.5 flex-1 rounded-full bg-accent"
        style={{ transformOrigin: 'left center' }}
        initial={reduced ? false : { scaleX: 0, opacity: 0.5 }}
        animate={{ scaleX: 1, opacity: 1 }}
        transition={reduced ? { duration: 0 } : { duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

function Row({ node, attrs, innerRef, children }: RowRendererProps<ArNode>) {
  const ctx = useNodeCtx();
  return (
    <div
      {...attrs}
      ref={innerRef}
      onClick={node.handleClick}
      onFocus={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (node.isEditing) {
          return;
        }
        if (
          event.key === 'Enter' &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          if (node.data.virtual === true) {
            node.toggle();
          } else {
            ctx.openNote(node.data.ref);
          }
        } else if (event.key === 'Delete') {
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          if (node.data.virtual !== true) {
            ctx.remove(node.data.ref);
          }
        }
      }}
      className="flex items-center px-1 outline-none"
    >
      {children}
    </div>
  );
}

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ArNode>) {
  const ctx = useNodeCtx();
  const data = node.data;
  const iconInfo = ctx.iconByRef[data.ref] ?? {};
  const pinned = ctx.pinnedNotes.has(data.ref);
  const active = ctx.activeRef === data.ref;
  const editing = node.isEditing;
  const menuPoint = useRef({ x: 0, y: 0 });

  const isReveal = !ctx.reduced && node.parent !== null && node.parent.id === ctx.justOpened;
  const isLand = !ctx.reduced && data.id === ctx.justMoved;
  const enter = isReveal || isLand;
  const pad = (typeof style.paddingLeft === 'number' ? style.paddingLeft : 0) + 6;

  const folderFallback = data.isFolder ? (node.isOpen ? 'FolderOpen' : 'Folder') : 'FileText';

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <motion.div
          ref={dragHandle}
          style={{ ...style, paddingLeft: pad }}
          onContextMenu={(event) => {
            menuPoint.current = { x: event.clientX, y: event.clientY };
          }}
          initial={enter ? { opacity: 0, y: isLand ? 4 : -6 } : false}
          animate={{ opacity: node.isDragging ? 0.45 : 1, y: 0 }}
          transition={
            isReveal
              ? { ...springSnappy, delay: Math.min(node.childIndex, STAGGER_CAP) * STAGGER_STEP }
              : isLand
                ? springStandard
                : ctx.reduced
                  ? { duration: 0 }
                  : springSnappy
          }
          className={cx(
            'group/node relative flex h-[26px] w-full items-center gap-1.5 rounded-s pr-2 text-ui outline-none transition-colors',
            active ? 'bg-accent-dim text-text-0' : 'text-text-1',
            !active && !node.willReceiveDrop ? 'hover:bg-bg-3 hover:text-text-0' : undefined,
            node.willReceiveDrop ? 'bg-accent-dim ring-1 ring-inset ring-accent' : undefined,
            node.isFocused && !active && !node.willReceiveDrop ? 'ring-1 ring-inset ring-stroke-1' : undefined,
          )}
        >
          {data.isFolder ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={node.isOpen ? 'Свернуть' : 'Развернуть'}
              onClick={(event) => {
                event.stopPropagation();
                node.toggle();
              }}
              className="flex size-3.5 shrink-0 items-center justify-center rounded-xs text-text-2 hover:text-text-0"
            >
              <motion.span
                className="flex"
                animate={{ rotate: node.isOpen ? 90 : 0 }}
                transition={ctx.reduced ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              >
                <ChevronRight size={13} strokeWidth={1.75} />
              </motion.span>
            </button>
          ) : (
            <span className="size-3.5 shrink-0" />
          )}

          <NoteIcon
            icon={iconInfo.icon}
            color={iconInfo.color}
            fallback={folderFallback}
            size={15}
            className={cx('shrink-0', iconInfo.color === undefined ? 'text-text-2' : undefined)}
          />

          {editing ? (
            <RenameInput node={node} />
          ) : (
            <span className="min-w-0 flex-1 truncate text-left">{data.name}</span>
          )}

          {pinned && !editing ? (
            <Pin size={11} strokeWidth={1.75} className="shrink-0 text-text-2" />
          ) : null}
        </motion.div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-56 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3">
          {data.virtual === true ? (
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => node.toggle()}>
              {node.isOpen ? (
                <FolderOpen size={15} strokeWidth={1.75} className="text-text-2" />
              ) : (
                <Folder size={15} strokeWidth={1.75} className="text-text-2" />
              )}
              {node.isOpen ? 'Свернуть' : 'Развернуть'}
            </ContextMenu.Item>
          ) : (
            <>
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => ctx.openNote(data.ref)}>
            <FileText size={15} strokeWidth={1.75} className="text-text-2" />
            Открыть
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => ctx.openInNewPane(data.ref)}>
            <Columns2 size={15} strokeWidth={1.75} className="text-text-2" />
            Открыть в новой панели
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => ctx.startRename(node)}>
            <Pencil size={15} strokeWidth={1.75} className="text-text-2" />
            <span className="flex-1">Переименовать</span>
            <Kbd>F2</Kbd>
          </ContextMenu.Item>
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() =>
              ctx.requestIcon({ ref: data.ref, icon: iconInfo.icon, color: iconInfo.color, point: menuPoint.current })
            }
          >
            <Palette size={15} strokeWidth={1.75} className="text-text-2" />
            Иконка и цвет
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => ctx.togglePin(data.ref)}>
            {pinned ? (
              <PinOff size={15} strokeWidth={1.75} className="text-text-2" />
            ) : (
              <Pin size={15} strokeWidth={1.75} className="text-text-2" />
            )}
            {pinned ? 'Открепить' : 'Закрепить'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
          <ContextMenu.Item
            className={cx(MENU_ITEM, 'text-danger data-[highlighted]:text-danger')}
            onSelect={() => ctx.remove(data.ref)}
          >
            <Trash2 size={15} strokeWidth={1.75} />
            Удалить
          </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              void commands
                .revealInExplorer(data.ref)
                .catch(() => useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось открыть проводник' }));
            }}
          >
            <FolderSymlink size={15} strokeWidth={1.75} className="text-text-2" />
            Перейти в проводник
          </ContextMenu.Item>
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              void commands.noteAbsPath(data.ref).then(
                (path) => {
                  void navigator.clipboard.writeText(path);
                  useUiStore.getState().pushToast({ kind: 'success', text: 'Путь скопирован' });
                },
                () => useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось получить путь' }),
              );
            }}
          >
            <Copy size={15} strokeWidth={1.75} className="text-text-2" />
            Скопировать путь
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TreePanel({ width, onWidthChange }: TreePanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const currentRef = useVaultStore((s) => s.currentRef);
  const vaultReady = useVaultStore((s) => s.info !== undefined);
  const pinnedNotes = useVaultStore((s) => s.pinnedNotes);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();

  const treeRef = useRef<TreeApi<ArNode> | undefined>(undefined);
  const [listRef, size] = useElementSize();
  const [justOpened, setJustOpened] = useState<string | undefined>(undefined);
  const [justMoved, setJustMoved] = useState<string | undefined>(undefined);
  const [iconRequest, setIconRequest] = useState<IconRequest | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const moveTimer = useRef<number | undefined>(undefined);

  const forest = useMemo(() => buildForest(tree), [tree]);
  const pinned = useMemo(
    () =>
      tree
        .filter((node) => pinnedNotes.has(node.ref))
        .map((node) => ({ ref: node.ref, title: node.title, isFolder: node.path.endsWith(INDEX_SUFFIX) }))
        .sort((a, b) => a.title.localeCompare(b.title, 'ru')),
    [tree, pinnedNotes],
  );

  useEffect(() => {
    return () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(moveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (currentRef === undefined) {
      return;
    }
    const api = treeRef.current;
    if (api === undefined) {
      return;
    }
    try {
      api.openParents(currentRef);
      void api.scrollTo(currentRef)?.catch(() => undefined);
    } catch {
      /* узел ещё не в дереве */
    }
  }, [currentRef]);

  const flagOpened = useCallback((id: string) => {
    setJustOpened(id);
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setJustOpened(undefined), 480);
  }, []);

  const openNote = useCallback((ref: NoteRef) => {
    useVaultStore.getState().openNote(ref);
  }, []);

  const openInNewPane = useCallback((ref: NoteRef) => {
    const paneId = usePanesStore.getState().addPane();
    if (paneId === undefined) {
      useUiStore.getState().pushToast({ kind: 'info', text: 'Больше панелей открыть нельзя' });
    }
    useVaultStore.getState().openNote(ref);
  }, []);

  const startRename = useCallback((node: NodeApi<ArNode>) => {
    window.setTimeout(() => {
      void node.edit();
    }, 0);
  }, []);

  const requestIcon = useCallback((request: IconRequest) => {
    setIconRequest(request);
  }, []);

  const togglePin = useCallback((ref: NoteRef) => {
    void useVaultStore.getState().togglePinNote(ref);
  }, []);

  const remove = useCallback((ref: NoteRef) => {
    void useVaultStore.getState().remove(ref);
  }, []);

  const handleActivate = useCallback((node: NodeApi<ArNode>) => {
    if (node.data.virtual === true) {
      node.toggle();
      return;
    }
    useVaultStore.getState().openNote(node.data.ref);
  }, []);

  const handleToggle = useCallback(
    (id: string) => {
      if (treeRef.current?.isOpen(id) === true) {
        flagOpened(id);
      }
    },
    [flagOpened],
  );

  const handleRename = useCallback<RenameHandler<ArNode>>(({ node, name }) => {
    if (node.data.virtual === true) {
      return;
    }
    const next = name.trim();
    if (next.length > 0 && next !== node.data.name) {
      void useVaultStore.getState().rename(node.data.ref, next);
    }
  }, []);

  const handleMove = useCallback<MoveHandler<ArNode>>((args) => {
    const parentRef: NoteRef = args.parentId ?? ROOT_REF;
    const stripped = parentRef.slice(ROOT_REF.length);
    const targetDir = stripped.endsWith(INDEX_SUFFIX)
      ? stripped.slice(0, -INDEX_SUFFIX.length)
      : stripped;
    void (async () => {
      for (const dragged of args.dragNodes) {
        const currentParent =
          dragged.parent !== null && !dragged.parent.isRoot ? dragged.parent.id : ROOT_REF;
        if (currentParent === parentRef) {
          continue;
        }
        const base = baseName(dragged.data.path);
        const movedRef: NoteRef = `path:${targetDir === '' ? base : `${targetDir}/${base}`}`;
        setJustMoved(movedRef);
        window.clearTimeout(moveTimer.current);
        moveTimer.current = window.setTimeout(() => setJustMoved(undefined), 520);
        await useVaultStore.getState().move(dragged.data.ref, parentRef);
      }
    })();
  }, []);

  const disableDrop = useCallback(
    (args: { parentNode: NodeApi<ArNode>; dragNodes: NodeApi<ArNode>[]; index: number }) => {
      if (!args.parentNode.isRoot && !args.parentNode.data.isFolder) {
        return true;
      }
      const targetParent: NoteRef = args.parentNode.isRoot ? ROOT_REF : args.parentNode.data.ref;
      return args.dragNodes.every((dragged) => {
        const current =
          dragged.parent !== null && !dragged.parent.isRoot ? dragged.parent.id : ROOT_REF;
        return current === targetParent;
      });
    },
    [],
  );

  useActionHandler('note.rename', () => {
    const focused = treeRef.current?.focusedNode;
    if (focused?.data.virtual === true) {
      return;
    }
    const target = focused?.data.ref ?? currentRef;
    if (target !== undefined) {
      void treeRef.current?.edit(target);
    }
  });

  const ctxValue = useMemo<NodeTreeContext>(
    () => ({
      activeRef: currentRef,
      pinnedNotes,
      iconByRef,
      justOpened,
      justMoved,
      reduced,
      openNote,
      openInNewPane,
      startRename,
      requestIcon,
      togglePin,
      remove,
    }),
    [
      currentRef,
      pinnedNotes,
      iconByRef,
      justOpened,
      justMoved,
      reduced,
      openNote,
      openInNewPane,
      startRename,
      requestIcon,
      togglePin,
      remove,
    ],
  );

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(startWidth + (moveEvent.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-stroke-0 bg-bg-1"
      style={{ width }}
      aria-label="Дерево заметок"
    >
      <header className="flex h-9 shrink-0 items-center justify-between px-4 text-caption text-text-2">
        <span>Заметки</span>
        {vaultReady ? (
          <button
            type="button"
            aria-label="Новая заметка"
            onClick={() => void useVaultStore.getState().createNote()}
            className="rounded-xs p-1 text-text-2 hover:bg-bg-3 hover:text-text-0"
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        ) : null}
      </header>

      {forest.length === 0 && pinned.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {pinned.length > 0 ? (
            <div className="shrink-0 border-b border-stroke-0 px-2 pb-2 pt-1">
              <p className="px-2 pb-1 text-micro uppercase tracking-wide text-text-3">Закреплённое</p>
              <ul className="animate-fade-in space-y-0.5">
                {pinned.map((item) => {
                  const info = iconByRef[item.ref] ?? {};
                  const active = currentRef === item.ref;
                  return (
                    <li key={item.ref}>
                      <div
                        className={cx(
                          'group/pin flex h-7 items-center gap-1.5 rounded-s px-2 text-ui',
                          active ? 'bg-accent-dim text-text-0' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => openNote(item.ref)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
                        >
                          <NoteIcon
                            icon={info.icon}
                            color={info.color}
                            fallback={item.isFolder ? 'Folder' : 'FileText'}
                            size={15}
                            className={cx('shrink-0', info.color === undefined ? 'text-text-2' : undefined)}
                          />
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        </button>
                        <button
                          type="button"
                          aria-label="Открепить"
                          onClick={() => togglePin(item.ref)}
                          className="shrink-0 text-text-2 hover:text-danger"
                        >
                          <Pin size={11} strokeWidth={1.75} className="group-hover/pin:hidden" />
                          <PinOff size={12} strokeWidth={1.75} className="hidden group-hover/pin:block" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div ref={listRef} className="min-h-0 flex-1">
            <NodeCtx.Provider value={ctxValue}>
              {forest.length > 0 ? (
                <Tree<ArNode>
                  ref={treeRef}
                  data={forest}
                  idAccessor="id"
                  childrenAccessor="children"
                  openByDefault
                  width={size.width > 0 ? size.width : width}
                  height={size.height > 0 ? size.height : 600}
                  indent={INDENT}
                  rowHeight={ROW_HEIGHT}
                  overscanCount={8}
                  paddingTop={4}
                  paddingBottom={8}
                  selection={currentRef}
                  disableDrop={disableDrop}
                  onMove={handleMove}
                  onRename={handleRename}
                  onToggle={handleToggle}
                  onActivate={handleActivate}
                  renderRow={Row}
                  renderCursor={Cursor}
                  aria-label="Дерево заметок"
                >
                  {NodeRow}
                </Tree>
              ) : null}
            </NodeCtx.Provider>
          </div>
        </div>
      )}

      {iconRequest !== undefined ? (
        <IconPicker
          open
          onOpenChange={(next) => {
            if (!next) {
              setIconRequest(undefined);
            }
          }}
          icon={iconRequest.icon}
          color={iconRequest.color}
          anchorPoint={iconRequest.point}
          onPick={(icon, color) => void useVaultStore.getState().setIcon(iconRequest.ref, icon, color)}
        />
      ) : null}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину дерева"
        className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize hover:bg-stroke-1 active:bg-stroke-1"
        onPointerDown={onHandlePointerDown}
      />
    </aside>
  );
}
