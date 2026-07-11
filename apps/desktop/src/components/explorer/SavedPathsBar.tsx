import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Reorder, useDragControls } from 'motion/react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { invoke } from '@tauri-apps/api/core';
import { GripVertical, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { cx } from '@graphite/ui';
import { REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useExplorerStore } from '../../stores/explorerStore';
import type { SavedPath } from '../../stores/explorerStore';
import { useUiStore } from '../../stores/uiStore';

const MENU_CONTENT =
  'z-50 min-w-44 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';

interface SavedPillProps {
  saved: SavedPath;
  editing: boolean;
  reduced: boolean;
  onOpen(): void;
  onStartEdit(): void;
  onCommitEdit(name: string): void;
  onCancelEdit(): void;
  onRemove(): void;
}

function SavedPill({ saved, editing, reduced, onOpen, onStartEdit, onCommitEdit, onCancelEdit, onRemove }: SavedPillProps) {
  const controls = useDragControls();
  const [draft, setDraft] = useState(saved.name);

  const commit = () => {
    onCommitEdit(draft);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancelEdit();
    }
  };

  return (
    <Reorder.Item
      value={saved.id}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      whileDrag={reduced ? undefined : { scale: 1.04 }}
      className="shrink-0"
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="group flex h-7 items-center rounded-full border border-stroke-0 bg-bg-2 pl-1 pr-0.5 transition-colors duration-[120ms] hover:border-stroke-1">
            <button
              type="button"
              aria-label="Перетащить закладку"
              onPointerDown={(event) => {
                event.preventDefault();
                controls.start(event);
              }}
              className="flex w-3 shrink-0 cursor-grab touch-none items-center justify-center text-text-3 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 active:cursor-grabbing"
            >
              <GripVertical size={13} strokeWidth={1.75} />
            </button>
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
                className="mx-1 h-5 w-28 rounded-xs border border-stroke-1 bg-bg-1 px-1.5 text-caption text-text-0 outline-none focus:border-accent"
              />
            ) : (
              <button
                type="button"
                onClick={onOpen}
                title={saved.path}
                className="flex items-center gap-1.5 px-1.5 text-caption text-text-1 transition-colors duration-[120ms] hover:text-text-0"
              >
                <Star size={12} strokeWidth={1.75} className="shrink-0 text-accent" fill="currentColor" />
                <span className="max-w-[160px] truncate">{saved.name}</span>
              </button>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <ContextMenu.Item className={MENU_ITEM} onSelect={onStartEdit}>
              <Pencil size={15} strokeWidth={1.75} className="text-text-2" />
              <span className="flex-1">Переименовать</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cx(MENU_ITEM, 'text-danger data-[highlighted]:text-danger')}
              onSelect={onRemove}
            >
              <Trash2 size={15} strokeWidth={1.75} />
              <span className="flex-1">Удалить</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </Reorder.Item>
  );
}

export function SavedPathsBar() {
  const saved = useExplorerStore((s) => s.saved);
  const openFolderPane = useExplorerStore((s) => s.openFolderPane);
  const addSaved = useExplorerStore((s) => s.addSaved);
  const removeSaved = useExplorerStore((s) => s.removeSaved);
  const renameSaved = useExplorerStore((s) => s.renameSaved);
  const reorderSaved = useExplorerStore((s) => s.reorderSaved);
  const pushToast = useUiStore((s) => s.pushToast);
  const reduced = usePrefersReducedMotion();
  const [editingId, setEditingId] = useState<string | null>(null);
  const busyRef = useRef(false);

  const addViaDialog = async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      const selected = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Папка в закладки' },
      });
      if (typeof selected === 'string' && selected.length > 0) {
        addSaved(selected);
        pushToast({ kind: 'success', text: 'Папка в закладках' });
      }
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось выбрать папку' });
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
      <span className="shrink-0 text-micro uppercase tracking-wide text-text-3">Закладки</span>
      {saved.length > 0 ? (
        <Reorder.Group
          axis="x"
          values={saved.map((entry) => entry.id)}
          onReorder={(ids) => reorderSaved(ids as string[])}
          className="flex items-center gap-1.5"
        >
          {saved.map((entry) => (
            <SavedPill
              key={entry.id}
              saved={entry}
              editing={editingId === entry.id}
              reduced={reduced}
              onOpen={() => openFolderPane(entry.path)}
              onStartEdit={() => setEditingId(entry.id)}
              onCommitEdit={(name) => {
                renameSaved(entry.id, name);
                setEditingId(null);
              }}
              onCancelEdit={() => setEditingId(null)}
              onRemove={() => removeSaved(entry.id)}
            />
          ))}
        </Reorder.Group>
      ) : (
        <span className="shrink-0 text-caption text-text-3">папки для быстрого доступа</span>
      )}
      <button
        type="button"
        onClick={() => void addViaDialog()}
        title="Добавить папку в закладки"
        className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-dashed border-stroke-1 px-2.5 text-caption text-text-2 transition-colors duration-[120ms] hover:border-accent hover:text-text-0"
      >
        <Plus size={13} strokeWidth={2} />
        Добавить
      </button>
    </div>
  );
}
