import { useMemo, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy, Eye, ExternalLink, Folder, FolderOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@graphite/ui';
import type { FsEntry } from './fsApi';
import { formatSize, iconForFile } from './explorerFormat';

const MENU_CONTENT =
  'z-50 min-w-52 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0';
const ROW_HEIGHT = 30;

export interface FolderListProps {
  entries: FsEntry[];
  onOpenFolder(path: string): void;
  onOpenFile(path: string): void;
  onReveal(path: string): void;
  onCopyPath(path: string): void;
  onOpenExternal(path: string): void;
}

function MenuItem({ icon: Icon, label, onSelect }: { icon: LucideIcon; label: string; onSelect: () => void }) {
  return (
    <ContextMenu.Item className={MENU_ITEM} onSelect={onSelect}>
      <Icon size={15} strokeWidth={1.75} className="text-text-2" />
      <span className="flex-1">{label}</span>
    </ContextMenu.Item>
  );
}

export function FolderList({ entries, onOpenFolder, onOpenFile, onReveal, onCopyPath, onOpenExternal }: FolderListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Папки сверху, затем файлы; внутри групп — по имени без учёта регистра.
  const sorted = useMemo(() => {
    return entries.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true });
    });
  }, [entries]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (sorted.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-ui text-text-3">Папка пуста</div>;
  }

  const open = (entry: FsEntry) => {
    if (entry.isDir) {
      onOpenFolder(entry.path);
    } else {
      onOpenFile(entry.path);
    }
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = sorted[row.index];
          const Icon: LucideIcon = entry.isDir ? Folder : iconForFile(entry.ext);
          const isSelected = selected === entry.path;
          return (
            <div
              key={entry.path}
              className="absolute inset-x-0 top-0 px-1"
              style={{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }}
            >
              <ContextMenu.Root>
                <ContextMenu.Trigger asChild>
                  <button
                    type="button"
                    onClick={() => setSelected(entry.path)}
                    onDoubleClick={() => open(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        open(entry);
                      }
                    }}
                    title={entry.name}
                    className={cx(
                      'flex h-[28px] w-full items-center gap-2 rounded-s px-2 text-left outline-none transition-colors duration-[90ms]',
                      isSelected ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2',
                      entry.hidden ? 'opacity-55' : undefined,
                    )}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      className={cx('shrink-0', entry.isDir ? 'text-accent' : 'text-text-3')}
                    />
                    <span className="min-w-0 flex-1 truncate text-ui">{entry.name}</span>
                    {!entry.isDir ? (
                      <span className="shrink-0 font-mono text-micro text-text-3">{formatSize(entry.size)}</span>
                    ) : null}
                  </button>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className={MENU_CONTENT}>
                    {entry.isDir ? (
                      <MenuItem icon={FolderOpen} label="Открыть" onSelect={() => onOpenFolder(entry.path)} />
                    ) : (
                      <>
                        <MenuItem icon={Eye} label="Открыть предпросмотр" onSelect={() => onOpenFile(entry.path)} />
                        <MenuItem
                          icon={ExternalLink}
                          label="Открыть в системе"
                          onSelect={() => onOpenExternal(entry.path)}
                        />
                      </>
                    )}
                    <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
                    <MenuItem icon={FolderOpen} label="Показать в Проводнике" onSelect={() => onReveal(entry.path)} />
                    <MenuItem icon={Copy} label="Копировать путь" onSelect={() => onCopyPath(entry.path)} />
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            </div>
          );
        })}
      </div>
    </div>
  );
}
