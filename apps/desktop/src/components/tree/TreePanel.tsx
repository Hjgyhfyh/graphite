import type { PointerEvent as ReactPointerEvent } from 'react';
import { FileText, Plus } from 'lucide-react';
import { Kbd } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import { useVaultStore } from '../../stores/vaultStore';

export interface TreePanelProps {
  width: number;
  onWidthChange: (w: number) => void;
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <FileText size={24} strokeWidth={1.5} className="text-text-3" />
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

export function TreePanel({ width, onWidthChange }: TreePanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const openNote = useVaultStore((s) => s.openNote);
  const currentRef = useVaultStore((s) => s.currentRef);
  const vaultReady = useVaultStore((s) => s.info !== undefined);

  const createNote = async () => {
    try {
      const res = await commands.noteCreate({ title: 'Новая заметка' });
      await useVaultStore.getState().loadTree();
      useVaultStore.getState().openNote(res.ref);
    } catch {
      // хранилище ещё не открыто — кнопка скрыта, сюда не попадаем
    }
  };

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
      className="relative flex shrink-0 flex-col border-r border-stroke-0 bg-bg-1"
      style={{ width }}
      aria-label="Дерево заметок"
    >
      <header className="flex h-9 shrink-0 items-center justify-between px-4 text-caption text-text-2">
        <span>Заметки</span>
        {vaultReady ? (
          <button
            type="button"
            aria-label="Новая заметка"
            onClick={() => void createNote()}
            className="rounded-xs p-1 text-text-2 hover:bg-bg-3 hover:text-text-0"
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        ) : null}
      </header>
      {tree.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {tree.map((node) => {
            const depth = node.path.split('/').length - 1;
            const active = currentRef === node.ref;
            return (
              <li key={node.ref}>
                <button
                  type="button"
                  onClick={() => openNote(node.ref)}
                  className={
                    active
                      ? 'flex h-7 w-full items-center rounded-s bg-accent-dim px-2 text-ui text-text-0'
                      : 'flex h-7 w-full items-center rounded-s px-2 text-ui text-text-1 hover:bg-bg-3 hover:text-text-0'
                  }
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  <span className="truncate">{node.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
