import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, useVelocity } from 'motion/react';
import { Tree } from 'react-arborist';
import type {
  CursorProps,
  DragPreviewProps,
  MoveHandler,
  NodeApi,
  NodeRendererProps,
  RenameHandler,
  RowRendererProps,
  TreeApi,
} from 'react-arborist';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Import,
  LayoutTemplate,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareKanban,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NoteRef, TreeNode } from '@graphite/bindings';
import { commands, isTauriAvailable } from '@graphite/bindings';
import { Button, Kbd, STAGGER_CAP, Tooltip, cx } from '@graphite/ui';
import { useActionHandler } from '../../app/Keymap';
import { springSnappy, springStandard, usePrefersReducedMotion } from '../../motion';
import { usePanesStore } from '../../stores/panesStore';
import { useTemplatePickerStore } from '../../stores/templatePickerStore';
import { useTreeStateStore } from '../../stores/treeStateStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import type { NoteIconInfo } from '../../stores/vaultStore';
import { vaultKey } from '../../stores/vaultsStore';
import { IconPicker } from './IconPicker';
import { NoteIcon } from './NoteIcon';
import { consumeTreeDropClick, treeDndBackend } from './treeDndBackend';

export interface TreePanelProps {
  width: number;
  onWidthChange: (w: number) => void;
}

const ROW_HEIGHT = 30;
const INDENT = 14;
const INDEX_SUFFIX = '/_index.md';
const ROOT_REF: NoteRef = 'path:';
const STAGGER_STEP = 0.018;
const SPRING_OPEN_MS = 650;

const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';
const MENU_CONTENT =
  'z-50 min-w-56 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const DD_CONTENT =
  'z-50 min-w-52 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';

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
  mode: 'full' | 'color';
}

interface NodeTreeContext {
  activeRef?: NoteRef;
  pinnedNotes: Set<NoteRef>;
  iconByRef: Record<NoteRef, NoteIconInfo>;
  justOpened?: string;
  justMoved?: string;
  reduced: boolean;
  getNode: (id: string) => ArNode | undefined;
  openNote: (ref: NoteRef) => void;
  openInNewPane: (ref: NoteRef) => void;
  startRename: (node: NodeApi<ArNode>) => void;
  renameByRef: (ref: NoteRef) => void;
  requestIcon: (request: IconRequest) => void;
  newNoteInside: (parent: NoteRef) => void;
  newFolderInside: (parent: NoteRef) => void;
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

/** Ссылка на folder-note папки: у виртуальной — будущий `_index.md`. */
function folderNoteRef(data: ArNode): NoteRef {
  return data.virtual === true ? `path:${data.path}${INDEX_SUFFIX}` : data.ref;
}

function filesPhrase(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} файл станет заметкой`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} файла станут заметками`;
  }
  return `${count} файлов станут заметками`;
}

function buildForest(nodes: readonly TreeNode[], pinned: ReadonlySet<NoteRef>): ArNode[] {
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
    list.sort(
      (a, b) =>
        Number(pinned.has(b.ref)) - Number(pinned.has(a.ref)) ||
        Number(b.isFolder) - Number(a.isFolder) ||
        a.name.localeCompare(b.name, 'ru'),
    );
    for (const child of list) {
      if (child.children !== null) {
        sortRec(child.children);
      }
    }
  };
  sortRec(roots);
  return roots;
}

function collectFolderIds(nodes: readonly ArNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly ArNode[]) => {
    for (const node of list) {
      if (node.children !== null) {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-l border border-stroke-0 bg-bg-1 text-text-3">
        <NoteIcon icon="FileText" size={22} />
      </span>
      <p className="text-ui text-text-1">Создайте первую заметку</p>
      <div className="flex items-center gap-1 text-caption text-text-2">
        <span>или</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>Alt</Kbd>
        <Kbd>Space</Kbd>
      </div>
      <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().createNote()}>
        Новая заметка
      </Button>
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

const CHIP_SHIFT_X = 14;
const CHIP_SHIFT_Y = 10;
const CHIP_TILT_DEG = 1.5;
const CHIP_DRIFT_MAX_DEG = 4;
const CHIP_DRIFT_VELOCITY_PX = 1600;

interface TreeDragChipProps {
  node: ArNode;
  count: number;
  mouse: { x: number; y: number };
}

/** Призрак переноса: чип «иконка + название» летит за курсором с инерционным наклоном. */
function TreeDragChip({ node, count, mouse }: TreeDragChipProps) {
  const ctx = useNodeCtx();
  const iconInfo = ctx.iconByRef[node.ref] ?? {};
  const x = useMotionValue(mouse.x + CHIP_SHIFT_X);
  const y = useMotionValue(mouse.y + CHIP_SHIFT_Y);
  const velocityX = useVelocity(x);
  const drift = useSpring(
    useTransform(
      velocityX,
      [-CHIP_DRIFT_VELOCITY_PX, CHIP_DRIFT_VELOCITY_PX],
      [-CHIP_DRIFT_MAX_DEG, CHIP_DRIFT_MAX_DEG],
      { clamp: true },
    ),
    { stiffness: 320, damping: 26, mass: 0.7 },
  );
  const rotate = useTransform(drift, (deg) => (ctx.reduced ? 0 : deg + CHIP_TILT_DEG));

  useLayoutEffect(() => {
    x.set(mouse.x + CHIP_SHIFT_X);
    y.set(mouse.y + CHIP_SHIFT_Y);
  }, [mouse, x, y]);

  return createPortal(
    <motion.div className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform" style={{ x, y }}>
      <motion.div
        className="flex max-w-64 items-center gap-1.5 rounded-m border border-stroke-1 bg-bg-2 px-2.5 py-1.5 text-ui text-text-0 shadow-3"
        style={{ rotate }}
        initial={ctx.reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
        animate={ctx.reduced ? { opacity: 1 } : { opacity: 1, scale: 1.04 }}
        exit={
          ctx.reduced
            ? { opacity: 0, transition: { duration: 0.08 } }
            : { opacity: 0, scale: 0.9, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }
        }
        transition={ctx.reduced ? { duration: 0.08 } : springSnappy}
      >
        <NoteIcon
          icon={iconInfo.icon}
          color={iconInfo.color}
          fallback={node.isFolder ? 'Folder' : 'FileText'}
          size={15}
          className={cx('shrink-0', iconInfo.color === undefined ? 'text-text-2' : undefined)}
        />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {count > 1 ? (
          <span className="shrink-0 rounded-full bg-accent-dim px-1.5 text-caption tabular-nums text-accent">
            {count}
          </span>
        ) : null}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function TreeDragPreview({ mouse, id, dragIds, isDragging }: DragPreviewProps) {
  const ctx = useNodeCtx();
  const node = id === null ? undefined : ctx.getNode(id);
  return (
    <AnimatePresence>
      {isDragging && node !== undefined && mouse !== null ? (
        <TreeDragChip key={node.id} node={node} count={dragIds.length} mouse={mouse} />
      ) : null}
    </AnimatePresence>
  );
}

interface MenuItemProps {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  danger?: boolean;
  onSelect: () => void;
}

function MenuItem({ icon: Icon, label, kbd, danger, onSelect }: MenuItemProps) {
  return (
    <ContextMenu.Item
      className={cx(MENU_ITEM, danger === true ? 'text-danger data-[highlighted]:text-danger' : undefined)}
      onSelect={onSelect}
    >
      <Icon size={15} strokeWidth={1.75} className={danger === true ? undefined : 'text-text-2'} />
      <span className="flex-1">{label}</span>
      {kbd !== undefined ? <Kbd>{kbd}</Kbd> : null}
    </ContextMenu.Item>
  );
}

function MenuSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />;
}

interface ExplorerItemsProps {
  refId: NoteRef;
}

function ExplorerItems({ refId }: ExplorerItemsProps) {
  return (
    <>
      <MenuItem
        icon={FolderSymlink}
        label="Перейти в проводник"
        onSelect={() => {
          void commands
            .revealInExplorer(refId)
            .catch(() => useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось открыть проводник' }));
        }}
      />
      <MenuItem
        icon={Copy}
        label="Скопировать путь"
        onSelect={() => {
          void commands.noteAbsPath(refId).then(
            (path) => {
              void navigator.clipboard.writeText(path);
              useUiStore.getState().pushToast({ kind: 'success', text: 'Путь скопирован' });
            },
            () => useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось получить путь' }),
          );
        }}
      />
    </>
  );
}

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ArNode>) {
  const ctx = useNodeCtx();
  const data = node.data;
  const iconInfo = ctx.iconByRef[data.ref] ?? {};
  const pinned = ctx.pinnedNotes.has(data.ref);
  const active = ctx.activeRef === data.ref;
  const editing = node.isEditing;
  const willReceiveDrop = node.willReceiveDrop;
  const menuPoint = useRef({ x: 0, y: 0 });

  // Spring-loaded папки: если при переносе задержаться над свёрнутой папкой,
  // она раскрывается — так можно дропнуть вглубь закрытой ветки.
  useEffect(() => {
    if (!willReceiveDrop || !data.isFolder || node.isOpen) {
      return;
    }
    const timer = window.setTimeout(() => node.open(), SPRING_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [willReceiveDrop, data.isFolder, node]);

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
          animate={{ opacity: node.isDragging ? 0.45 : 1, y: 0, scale: willReceiveDrop ? 1.01 : 1 }}
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
            !active && !willReceiveDrop ? 'hover:bg-bg-3 hover:text-text-0' : undefined,
            willReceiveDrop ? 'bg-accent-dim ring-1 ring-inset ring-accent' : undefined,
            node.isFocused && !active && !willReceiveDrop ? 'ring-1 ring-inset ring-stroke-1' : undefined,
          )}
        >
          {data.isFolder ? (
            <button
              type="button"
              tabIndex={-1}
              draggable={false}
              aria-label={node.isOpen ? 'Свернуть' : 'Развернуть'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (consumeTreeDropClick()) {
                  return;
                }
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
        <ContextMenu.Content className={MENU_CONTENT}>
          {data.isFolder ? (
            <>
              <MenuItem
                icon={node.isOpen ? Folder : FolderOpen}
                label={node.isOpen ? 'Свернуть' : 'Развернуть'}
                onSelect={() => node.toggle()}
              />
              {data.virtual !== true ? (
                <>
                  <MenuItem icon={FileText} label="Открыть заметку" onSelect={() => ctx.openNote(data.ref)} />
                  <MenuItem
                    icon={Columns2}
                    label="Открыть в новой панели"
                    onSelect={() => ctx.openInNewPane(data.ref)}
                  />
                </>
              ) : null}
              <MenuSeparator />
              <MenuItem icon={FilePlus} label="Новая заметка" onSelect={() => ctx.newNoteInside(data.ref)} />
              <MenuItem icon={FolderPlus} label="Новая папка" onSelect={() => ctx.newFolderInside(data.ref)} />
              <MenuSeparator />
              {data.virtual !== true ? (
                <MenuItem icon={Pencil} label="Переименовать" kbd="F2" onSelect={() => ctx.startRename(node)} />
              ) : null}
              <MenuItem
                icon={Palette}
                label="Цвет папки"
                onSelect={() =>
                  ctx.requestIcon({
                    ref: folderNoteRef(data),
                    icon: iconInfo.icon,
                    color: iconInfo.color,
                    point: menuPoint.current,
                    mode: 'color',
                  })
                }
              />
              {data.virtual !== true ? (
                <MenuItem
                  icon={pinned ? PinOff : Pin}
                  label={pinned ? 'Открепить' : 'Закрепить'}
                  onSelect={() => ctx.togglePin(data.ref)}
                />
              ) : null}
              {data.virtual !== true ? (
                <>
                  <MenuSeparator />
                  <MenuItem icon={Trash2} label="Удалить" danger onSelect={() => ctx.remove(data.ref)} />
                </>
              ) : null}
            </>
          ) : (
            <>
              <MenuItem icon={FileText} label="Открыть" onSelect={() => ctx.openNote(data.ref)} />
              <MenuItem icon={Columns2} label="Открыть в новой панели" onSelect={() => ctx.openInNewPane(data.ref)} />
              <MenuSeparator />
              <MenuItem icon={Pencil} label="Переименовать" kbd="F2" onSelect={() => ctx.startRename(node)} />
              <MenuItem
                icon={Palette}
                label="Иконка и цвет"
                onSelect={() =>
                  ctx.requestIcon({
                    ref: data.ref,
                    icon: iconInfo.icon,
                    color: iconInfo.color,
                    point: menuPoint.current,
                    mode: 'full',
                  })
                }
              />
              <MenuItem
                icon={pinned ? PinOff : Pin}
                label={pinned ? 'Открепить' : 'Закрепить'}
                onSelect={() => ctx.togglePin(data.ref)}
              />
              <MenuSeparator />
              <MenuItem icon={Trash2} label="Удалить" danger onSelect={() => ctx.remove(data.ref)} />
            </>
          )}
          <MenuSeparator />
          <ExplorerItems refId={data.ref} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Row({ node, attrs, innerRef, children }: RowRendererProps<ArNode>) {
  const ctx = useNodeCtx();
  return (
    <div
      {...attrs}
      ref={innerRef}
      onClick={(event) => {
        if (consumeTreeDropClick()) {
          return;
        }
        node.handleClick(event);
      }}
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
          if (node.data.isFolder) {
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

interface PinnedItem {
  ref: NoteRef;
  title: string;
  isFolder: boolean;
}

function PinnedRow({ item }: { item: PinnedItem }) {
  const ctx = useNodeCtx();
  const info = ctx.iconByRef[item.ref] ?? {};
  const active = ctx.activeRef === item.ref;
  const menuPoint = useRef({ x: 0, y: 0 });
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          onContextMenu={(event) => {
            menuPoint.current = { x: event.clientX, y: event.clientY };
          }}
          className={cx(
            'group/pin flex h-7 items-center gap-1.5 rounded-s px-2 text-ui',
            active ? 'bg-accent-dim text-text-0' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
          )}
        >
          <button
            type="button"
            onClick={() => ctx.openNote(item.ref)}
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
            onClick={() => ctx.togglePin(item.ref)}
            className="shrink-0 text-text-2 hover:text-danger"
          >
            <Pin size={11} strokeWidth={1.75} className="group-hover/pin:hidden" />
            <PinOff size={12} strokeWidth={1.75} className="hidden group-hover/pin:block" />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT}>
          <MenuItem icon={FileText} label="Открыть" onSelect={() => ctx.openNote(item.ref)} />
          <MenuItem icon={Columns2} label="Открыть в новой панели" onSelect={() => ctx.openInNewPane(item.ref)} />
          <MenuSeparator />
          <MenuItem icon={Pencil} label="Переименовать" kbd="F2" onSelect={() => ctx.renameByRef(item.ref)} />
          <MenuItem
            icon={Palette}
            label={item.isFolder ? 'Цвет папки' : 'Иконка и цвет'}
            onSelect={() =>
              ctx.requestIcon({
                ref: item.ref,
                icon: info.icon,
                color: info.color,
                point: menuPoint.current,
                mode: item.isFolder ? 'color' : 'full',
              })
            }
          />
          <MenuItem icon={PinOff} label="Открепить" onSelect={() => ctx.togglePin(item.ref)} />
          <MenuSeparator />
          <MenuItem icon={Trash2} label="Удалить" danger onSelect={() => ctx.remove(item.ref)} />
          <MenuSeparator />
          <ExplorerItems refId={item.ref} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TreePanel({ width, onWidthChange }: TreePanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const currentRef = useVaultStore((s) => s.currentRef);
  const vaultRoot = useVaultStore((s) => s.info?.root);
  const pinnedNotes = useVaultStore((s) => s.pinnedNotes);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();

  const vaultReady = vaultRoot !== undefined;
  const vk = useMemo(() => (vaultRoot === undefined ? undefined : vaultKey(vaultRoot)), [vaultRoot]);

  const treeRef = useRef<TreeApi<ArNode> | undefined>(undefined);
  const [listRef, size] = useElementSize();
  const [justOpened, setJustOpened] = useState<string | undefined>(undefined);
  const [justMoved, setJustMoved] = useState<string | undefined>(undefined);
  const [iconRequest, setIconRequest] = useState<IconRequest | undefined>(undefined);
  const [plusOpen, setPlusOpen] = useState(false);
  const [dropCount, setDropCount] = useState<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const moveTimer = useRef<number | undefined>(undefined);
  const renameTimer = useRef<number | undefined>(undefined);
  const iconTimer = useRef<number | undefined>(undefined);
  const bulkToggle = useRef(false);

  const forest = useMemo(() => buildForest(tree, pinnedNotes), [tree, pinnedNotes]);
  const nodeById = useMemo(() => {
    const map = new Map<string, ArNode>();
    const walk = (list: readonly ArNode[]) => {
      for (const node of list) {
        map.set(node.id, node);
        if (node.children !== null) {
          walk(node.children);
        }
      }
    };
    walk(forest);
    return map;
  }, [forest]);
  const pinned = useMemo(
    () =>
      tree
        .filter((node) => pinnedNotes.has(node.ref))
        .map((node) => ({ ref: node.ref, title: node.title, isFolder: node.path.endsWith(INDEX_SUFFIX) }))
        .sort((a, b) => a.title.localeCompare(b.title, 'ru')),
    [tree, pinnedNotes],
  );

  const initialOpenState = useMemo(() => {
    const state: Record<string, boolean> = {};
    if (vk !== undefined) {
      for (const id of useTreeStateStore.getState().getExpanded(vk)) {
        state[id] = true;
      }
    }
    return state;
  }, [vk]);

  useEffect(() => {
    return () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(moveTimer.current);
      window.clearTimeout(renameTimer.current);
      window.clearTimeout(iconTimer.current);
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

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') {
          if (useUiStore.getState().railView === 'brief') {
            return;
          }
          if (payload.paths.length > 0) {
            setDropCount(payload.paths.length);
          }
        } else if (payload.type === 'leave') {
          setDropCount(undefined);
        } else if (payload.type === 'drop') {
          setDropCount(undefined);
          if (useUiStore.getState().railView === 'brief') {
            return;
          }
          if (payload.paths.length > 0) {
            void useVaultStore.getState().addPathNotes(payload.paths);
          }
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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

  const renameByRef = useCallback((ref: NoteRef) => {
    window.setTimeout(() => {
      void treeRef.current?.edit(ref);
    }, 0);
  }, []);

  const requestIcon = useCallback((request: IconRequest) => {
    // Монтируем пикер следующим тиком: контекст-меню при закрытии возвращает фокус,
    // и свежий Popover принял бы это за взаимодействие снаружи и сразу закрылся.
    window.clearTimeout(iconTimer.current);
    iconTimer.current = window.setTimeout(() => setIconRequest(request), 0);
  }, []);

  const newNoteInside = useCallback((parent: NoteRef) => {
    void useVaultStore.getState().createNote({ parent });
  }, []);

  const createFolderFlow = useCallback((parent?: NoteRef) => {
    void (async () => {
      const ref = await useVaultStore.getState().createFolder(parent);
      if (ref === undefined) {
        return;
      }
      window.clearTimeout(renameTimer.current);
      renameTimer.current = window.setTimeout(() => {
        void treeRef.current?.edit(ref);
      }, 90);
    })();
  }, []);

  const newFolderInside = useCallback(
    (parent: NoteRef) => {
      createFolderFlow(parent);
    },
    [createFolderFlow],
  );

  const getNode = useCallback((id: string) => nodeById.get(id), [nodeById]);

  const togglePin = useCallback((ref: NoteRef) => {
    void useVaultStore.getState().togglePinNote(ref);
  }, []);

  const remove = useCallback((ref: NoteRef) => {
    void useVaultStore.getState().remove(ref);
  }, []);

  const handleActivate = useCallback((node: NodeApi<ArNode>) => {
    if (node.data.isFolder) {
      node.toggle();
      return;
    }
    useVaultStore.getState().openNote(node.data.ref);
  }, []);

  const handleToggle = useCallback(
    (id: string) => {
      if (bulkToggle.current) {
        return;
      }
      const open = treeRef.current?.isOpen(id) === true;
      if (vk !== undefined) {
        useTreeStateStore.getState().toggle(vk, id, open);
      }
      if (open) {
        flagOpened(id);
      }
    },
    [vk, flagOpened],
  );

  // openAll/closeAll шлют onToggle на каждый узел — на большом дереве это тысячи
  // одиночных записей и массовая reveal-анимация. Глушим обработчик флагом и
  // сохраняем итог одним setExpanded.
  const collapseAll = useCallback(() => {
    const api = treeRef.current;
    if (api === undefined) {
      return;
    }
    bulkToggle.current = true;
    try {
      api.closeAll();
    } finally {
      bulkToggle.current = false;
    }
    if (vk !== undefined) {
      useTreeStateStore.getState().setExpanded(vk, []);
    }
  }, [vk]);

  const expandAll = useCallback(() => {
    const api = treeRef.current;
    if (api === undefined) {
      return;
    }
    bulkToggle.current = true;
    try {
      api.openAll();
    } finally {
      bulkToggle.current = false;
    }
    if (vk !== undefined) {
      useTreeStateStore.getState().setExpanded(vk, collectFolderIds(forest));
    }
  }, [vk, forest]);

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
      getNode,
      openNote,
      openInNewPane,
      startRename,
      renameByRef,
      requestIcon,
      newNoteInside,
      newFolderInside,
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
      getNode,
      openNote,
      openInNewPane,
      startRename,
      renameByRef,
      requestIcon,
      newNoteInside,
      newFolderInside,
      togglePin,
      remove,
    ],
  );

  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      resizeCleanup.current?.();
      resizeCleanup.current = null;
    },
    [],
  );

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = width;
    let frame = 0;
    let lastX = startX;
    const onMove = (moveEvent: PointerEvent) => {
      lastX = moveEvent.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onWidthChange(startWidth + (lastX - startX));
      });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      onWidthChange(startWidth + (lastX - startX));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      resizeCleanup.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    resizeCleanup.current = finish;
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
          <div className="flex items-center gap-0.5">
            {forest.length > 0 ? (
              <>
                <Tooltip content="Развернуть все" side="bottom">
                  <button
                    type="button"
                    aria-label="Развернуть все"
                    onClick={expandAll}
                    className="rounded-xs p-1 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                  >
                    <ChevronsUpDown size={15} strokeWidth={1.75} />
                  </button>
                </Tooltip>
                <Tooltip content="Свернуть все" side="bottom">
                  <button
                    type="button"
                    aria-label="Свернуть все"
                    onClick={collapseAll}
                    className="rounded-xs p-1 text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                  >
                    <ChevronsDownUp size={15} strokeWidth={1.75} />
                  </button>
                </Tooltip>
              </>
            ) : null}
            <DropdownMenu.Root open={plusOpen} onOpenChange={setPlusOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label="Создать"
                  className={cx(
                    'rounded-xs p-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0',
                    plusOpen ? 'bg-bg-3 text-accent' : 'text-text-2',
                  )}
                >
                  <motion.span
                    className="flex"
                    animate={{ rotate: plusOpen ? 90 : 0 }}
                    transition={reduced ? { duration: 0 } : springSnappy}
                  >
                    <Plus size={14} strokeWidth={1.75} />
                  </motion.span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className={DD_CONTENT}>
                  <DropdownMenu.Item
                    className={MENU_ITEM}
                    onSelect={() => void useVaultStore.getState().createNote()}
                  >
                    <FilePlus size={15} strokeWidth={1.75} className="text-text-2" />
                    <span className="flex-1">Новая заметка</span>
                    <Kbd>Ctrl+N</Kbd>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={MENU_ITEM}
                    onSelect={() => useTemplatePickerStore.getState().openPicker()}
                  >
                    <LayoutTemplate size={15} strokeWidth={1.75} className="text-text-2" />
                    <span className="flex-1">Из шаблона…</span>
                    <Kbd>Ctrl+Alt+N</Kbd>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => createFolderFlow()}>
                    <FolderPlus size={15} strokeWidth={1.75} className="text-text-2" />
                    <span className="flex-1">Новая папка</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-stroke-0" />
                  <DropdownMenu.Item
                    className={MENU_ITEM}
                    onSelect={() => void useVaultStore.getState().createNote({ title: 'Новый план', type: 'plan' })}
                  >
                    <SquareKanban size={15} strokeWidth={1.75} className="text-text-2" />
                    <span className="flex-1">Новый план</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ) : null}
      </header>

      <NodeCtx.Provider value={ctxValue}>
        {forest.length === 0 && pinned.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {pinned.length > 0 ? (
              <div className="shrink-0 border-b border-stroke-0 px-2 pb-2 pt-1">
                <p className="px-2 pb-1 text-micro uppercase tracking-wide text-text-3">Закреплённое</p>
                <ul className="animate-fade-in space-y-0.5">
                  {pinned.map((item) => (
                    <li key={item.ref}>
                      <PinnedRow item={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div ref={listRef} className="min-h-0 flex-1">
              {forest.length > 0 ? (
                <Tree<ArNode>
                  key={vk ?? 'vault'}
                  ref={treeRef}
                  data={forest}
                  idAccessor="id"
                  childrenAccessor="children"
                  openByDefault={false}
                  initialOpenState={initialOpenState}
                  width={size.width > 0 ? size.width : width}
                  height={size.height > 0 ? size.height : 600}
                  indent={INDENT}
                  rowHeight={ROW_HEIGHT}
                  overscanCount={8}
                  paddingTop={4}
                  paddingBottom={8}
                  selection={currentRef}
                  dndBackend={treeDndBackend}
                  disableDrag={(data) => data.virtual === true}
                  disableDrop={disableDrop}
                  onMove={handleMove}
                  onRename={handleRename}
                  onToggle={handleToggle}
                  onActivate={handleActivate}
                  renderRow={Row}
                  renderCursor={Cursor}
                  renderDragPreview={TreeDragPreview}
                  aria-label="Дерево заметок"
                >
                  {NodeRow}
                </Tree>
              ) : null}
            </div>
          </div>
        )}
      </NodeCtx.Provider>

      <AnimatePresence>
        {dropCount !== undefined ? (
          <motion.div
            key="drop-overlay"
            className="absolute inset-2 z-30 flex items-center justify-center rounded-m border-2 border-dashed border-accent bg-bg-1/95"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={
              reduced
                ? { opacity: 0, transition: { duration: 0.08 } }
                : { opacity: 0, scale: 0.985, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }
            }
            transition={reduced ? { duration: 0.08 } : springStandard}
          >
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <motion.span
                aria-hidden
                className="grid size-12 place-items-center rounded-full bg-accent-dim text-accent"
                animate={reduced ? undefined : { scale: [1, 1.1, 1] }}
                transition={reduced ? undefined : { duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Import size={22} strokeWidth={1.75} />
              </motion.span>
              <div>
                <p className="text-ui text-text-0">Отпустите, чтобы добавить</p>
                <p className="mt-1 text-caption text-text-2">{filesPhrase(dropCount)} во «Входящих»</p>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

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
          mode={iconRequest.mode}
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
