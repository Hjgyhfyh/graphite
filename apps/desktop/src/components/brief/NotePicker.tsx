import { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { motion } from 'motion/react';
import { CornerDownLeft, FileSearch, Paperclip } from 'lucide-react';
import { Button, Kbd } from '@graphite/ui';
import type { NoteRef, TreeNode } from '@graphite/bindings';
import { useBriefStore } from '../../stores/briefStore';
import { useVaultStore } from '../../stores/vaultStore';
import { NoteIcon } from '../tree/NoteIcon';
import { Presence, fadeVariants, popVariants, reducedFadeVariants, usePrefersReducedMotion } from '../../motion';

export interface NotePickerProps {
  onAdd: (node: TreeNode) => boolean;
}

const RECENT_LIMIT = 12;
const QUERY_LIMIT = 30;

const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-2';

const ROW =
  'flex h-10 cursor-default select-none items-center gap-2.5 rounded-s px-2.5 text-ui text-text-1 data-[selected=true]:bg-bg-3 data-[selected=true]:text-text-0 data-[disabled=true]:opacity-60';

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function foldText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

function matches(query: string, ...fields: string[]): boolean {
  const q = foldText(query.trim());
  if (q.length === 0) {
    return true;
  }
  const hay = foldText(fields.filter((field) => field.length > 0).join(' '));
  if (hay.includes(q)) {
    return true;
  }
  let cursor = 0;
  for (let i = 0; i < hay.length && cursor < q.length; i += 1) {
    if (hay[i] === q[cursor]) {
      cursor += 1;
    }
  }
  return cursor === q.length;
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-micro text-text-2">
      <span className="flex items-center gap-1">
        {keys.map((key, index) => (
          <Kbd key={index}>{key}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}

export function NotePicker({ onAdd }: NotePickerProps) {
  const open = useBriefStore((s) => s.notePickerOpen);
  const files = useBriefStore((s) => s.files);
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const [query, setQuery] = useState('');
  const [addedCount, setAddedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const inBrief = useMemo(() => {
    const refs = new Set<NoteRef>();
    for (const file of files) {
      if (file.kind === 'note') {
        refs.add(file.ref);
      }
    }
    return refs;
  }, [files]);

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    setQuery('');
    setAddedCount(0);
    return undefined;
  }, [open]);

  const cancel = () => {
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    useBriefStore.getState().setNotePickerOpen(false);
    if (previous !== null && previous.isConnected) {
      previous.focus();
    }
  };

  const pick = (node: TreeNode) => {
    if (onAdd(node)) {
      setAddedCount((count) => count + 1);
    }
    setQuery('');
    inputRef.current?.focus();
  };

  const trimmed = query.trim();
  const items = useMemo(() => {
    if (trimmed.length === 0) {
      return [...tree].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, RECENT_LIMIT);
    }
    return tree.filter((node) => matches(trimmed, node.title, node.path)).slice(0, QUERY_LIMIT);
  }, [tree, trimmed]);

  return (
    <Presence>
      {open ? (
        <motion.div
          key="brief-note-picker-overlay"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[18vh]"
          variants={reduced ? reducedFadeVariants : fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            } else if (event.key === 'Tab') {
              event.preventDefault();
            }
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              cancel();
            }
          }}
        >
          <motion.div
            key="brief-note-picker-panel"
            role="dialog"
            aria-label="Заметка для брифа"
            className="flex max-h-[62vh] w-[520px] max-w-full flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3"
            variants={reduced ? reducedFadeVariants : popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Command
              shouldFilter={false}
              vimBindings={false}
              label="Заметка для брифа"
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-stroke-0 px-3.5">
                <FileSearch size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
                <Command.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Заметка для брифа…"
                  className="h-full w-full bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
                />
              </div>
              <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {items.length > 0 ? (
                  <Command.Group heading={trimmed.length === 0 ? 'Недавние' : 'Заметки'} className={HEADING}>
                    {items.map((node) => {
                      const info = iconByRef[node.ref] ?? { icon: node.icon, color: node.iconColor };
                      const added = inBrief.has(node.ref);
                      const folder = folderOf(node.path);
                      return (
                        <Command.Item
                          key={node.ref}
                          value={`brief-note-${node.ref}`}
                          keywords={[node.title, node.path]}
                          disabled={added}
                          onSelect={() => pick(node)}
                          className={ROW}
                        >
                          <NoteIcon
                            icon={info.icon}
                            color={info.color}
                            size={15}
                            className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                          />
                          <span className="min-w-0 flex-1 truncate">{node.title}</span>
                          {added ? (
                            <span className="shrink-0 rounded-full bg-ai/15 px-1.5 py-px text-micro text-ai">
                              в брифе
                            </span>
                          ) : folder.length > 0 ? (
                            <span className="max-w-[45%] shrink-0 truncate text-caption text-text-2">{folder}</span>
                          ) : null}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : (
                  <div className="px-3 py-8 text-center text-ui text-text-2">
                    {tree.length === 0 ? 'В хранилище пока нет заметок' : 'Ничего не найдено'}
                  </div>
                )}
              </Command.List>
              <div className="flex shrink-0 items-center gap-3.5 border-t border-stroke-0 px-3.5 py-2">
                <FooterHint keys={['↑', '↓']} label="выбрать" />
                <span className="flex items-center gap-1.5 text-micro text-text-2">
                  <Kbd>
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </Kbd>
                  добавить
                </span>
                <FooterHint keys={['Esc']} label="готово" />
                <span className="flex-1" />
                {addedCount > 0 ? (
                  <span className="flex items-center gap-1.5 text-micro text-ai">
                    <Paperclip size={11} strokeWidth={1.75} />
                    Добавлено: {addedCount}
                  </span>
                ) : null}
                <Button variant="ghost" size="sm" onClick={cancel}>
                  Готово
                </Button>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
