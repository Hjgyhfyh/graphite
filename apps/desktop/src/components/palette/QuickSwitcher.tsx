import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeftRight, CornerDownLeft, Pin } from 'lucide-react';
import { Kbd } from '@graphite/ui';
import type { TreeNode } from '@graphite/bindings';
import { activeTab, usePanesStore } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import type { Tab, TabKind } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import type { NoteIconInfo } from '../../stores/vaultStore';
import { chordKeys, useKeybindingsStore } from '../../stores/keybindingsStore';
import { NoteIcon } from '../tree/NoteIcon';
import { Presence, fadeVariants, popVariants, reducedFadeVariants, springSnappy, usePrefersReducedMotion } from '../../motion';

type Section = 'tab' | 'note';

interface SwitchItem {
  key: string;
  kind: Section;
  ref: string;
  title: string;
  subtitle: string;
  icon?: string;
  color?: string;
  tabId?: string;
  dirty?: boolean;
  pinned?: boolean;
}

const KIND_LABEL: Record<TabKind, string> = {
  editor: '',
  plan: 'План',
  settings: 'Настройки',
  search: 'Поиск',
  tasks: 'Задачи',
};

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function subtitleFor(ref: string, kind: TabKind): string {
  if (kind !== 'editor') {
    return KIND_LABEL[kind];
  }
  return ref.startsWith('path:') ? folderOf(ref.slice('path:'.length)) : '';
}

function matches(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return true;
  }
  const hay = fields.filter((field) => field.length > 0).join(' ').toLowerCase();
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

function tabToItem(tab: Tab): SwitchItem {
  return {
    key: `tab:${tab.id}`,
    kind: 'tab',
    ref: tab.noteRef,
    title: tab.title,
    subtitle: subtitleFor(tab.noteRef, tab.kind),
    icon: tab.icon,
    color: tab.iconColor,
    tabId: tab.id,
    dirty: tab.dirty,
    pinned: tab.pinned,
  };
}

function noteToItem(node: TreeNode, iconByRef: Record<string, NoteIconInfo>): SwitchItem {
  const info = iconByRef[node.ref] ?? { icon: node.icon, color: node.iconColor };
  return {
    key: `note:${node.ref}`,
    kind: 'note',
    ref: node.ref,
    title: node.title,
    subtitle: folderOf(node.path),
    icon: info.icon,
    color: info.color,
  };
}

function mruOrderedTabs(tabs: Tab[], mru: string[]): Tab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: Tab[] = [];
  for (const id of mru) {
    const tab = byId.get(id);
    if (tab !== undefined) {
      ordered.push(tab);
      byId.delete(id);
    }
  }
  const rest = [...byId.values()].sort((a, b) => a.order - b.order);
  return [...ordered, ...rest];
}

function buildItems(
  query: string,
  tabs: Tab[],
  tree: TreeNode[],
  mru: string[],
  iconByRef: Record<string, NoteIconInfo>,
): SwitchItem[] {
  const ordered = mruOrderedTabs(tabs, mru);
  const q = query.trim();
  if (q.length === 0) {
    if (ordered.length > 0) {
      return ordered.map(tabToItem);
    }
    return tree.slice(0, 12).map((node) => noteToItem(node, iconByRef));
  }
  const tabItems = ordered
    .filter((tab) => matches(q, tab.title, subtitleFor(tab.noteRef, tab.kind)))
    .map(tabToItem);
  const openRefs = new Set(tabItems.map((item) => item.ref));
  const noteItems = tree
    .filter((node) => !openRefs.has(node.ref) && matches(q, node.title, node.path))
    .slice(0, 30)
    .map((node) => noteToItem(node, iconByRef));
  return [...tabItems, ...noteItems];
}

function initialMru(): string[] {
  const { tabId } = activeTab(usePanesStore.getState());
  return tabId === undefined ? [] : [tabId];
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

export function QuickSwitcher() {
  const open = useUiStore((s) => s.quickSwitcherOpen);
  const setOpen = useUiStore((s) => s.setQuickSwitcherOpen);
  const tabs = useTabsStore((s) => s.tabs);
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const bindings = useKeybindingsStore((s) => s.bindings);
  const reduced = usePrefersReducedMotion();

  const [mru, setMru] = useState<string[]>(initialMru);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [holdMode, setHoldMode] = useState(false);

  const items = useMemo(() => buildItems(query, tabs, tree, mru, iconByRef), [query, tabs, tree, mru, iconByRef]);

  const openRef = useRef(open);
  const indexRef = useRef(index);
  const holdModeRef = useRef(holdMode);
  const itemsRef = useRef(items);
  const mruRef = useRef(mru);
  const armedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  openRef.current = open;
  indexRef.current = index;
  holdModeRef.current = holdMode;
  itemsRef.current = items;
  mruRef.current = mru;

  const closeSwitcher = useCallback(() => {
    openRef.current = false;
    holdModeRef.current = false;
    armedRef.current = false;
    setOpen(false);
    setHoldMode(false);
    setQuery('');
  }, [setOpen]);

  const commit = useCallback(
    (target?: number) => {
      const list = itemsRef.current;
      const item = list[target ?? indexRef.current];
      closeSwitcher();
      if (item === undefined) {
        return;
      }
      if (item.kind === 'tab' && item.tabId !== undefined) {
        useTabsStore.getState().activate(item.tabId);
      } else {
        useVaultStore.getState().openNote(item.ref);
      }
    },
    [closeSwitcher],
  );

  const step = useCallback((delta: number) => {
    setIndex((current) => {
      const len = itemsRef.current.length;
      return len === 0 ? 0 : (current + delta + len) % len;
    });
  }, []);

  const cancel = useCallback(() => {
    openRef.current = false;
    holdModeRef.current = false;
    armedRef.current = false;
    setOpen(false);
    setHoldMode(false);
    setQuery('');
  }, [setOpen]);

  useEffect(() => {
    const record = () => {
      const { tabId } = activeTab(usePanesStore.getState());
      if (tabId === undefined) {
        return;
      }
      setMru((prev) => (prev[0] === tabId ? prev : [tabId, ...prev.filter((id) => id !== tabId)]));
    };
    record();
    return usePanesStore.subscribe(record);
  }, []);

  useEffect(() => {
    const ids = new Set(tabs.map((tab) => tab.id));
    setMru((prev) => {
      const filtered = prev.filter((id) => ids.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [tabs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Tab') {
        if (useUiStore.getState().paletteOpen) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const backward = event.shiftKey;
        if (!openRef.current) {
          const list = buildItems(
            '',
            useTabsStore.getState().tabs,
            useVaultStore.getState().tree,
            mruRef.current,
            useVaultStore.getState().iconByRef,
          );
          if (list.length < 2) {
            return;
          }
          const start = backward ? list.length - 1 : 1;
          armedRef.current = true;
          openRef.current = true;
          holdModeRef.current = true;
          indexRef.current = start;
          itemsRef.current = list;
          setHoldMode(true);
          setIndex(start);
          setOpen(true);
        } else {
          const len = itemsRef.current.length;
          if (len > 0) {
            const next = (indexRef.current + (backward ? -1 : 1) + len) % len;
            holdModeRef.current = true;
            indexRef.current = next;
            setHoldMode(true);
            setIndex(next);
          }
        }
        return;
      }
      if (!openRef.current) {
        return;
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          step(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          step(-1);
          break;
        case 'Enter':
          event.preventDefault();
          commit();
          break;
        case 'Escape':
          event.preventDefault();
          cancel();
          break;
        case 'Home':
          event.preventDefault();
          setIndex(0);
          break;
        case 'End':
          event.preventDefault();
          setIndex(Math.max(0, itemsRef.current.length - 1));
          break;
        default:
          if (holdModeRef.current && /^[1-9]$/.test(event.key)) {
            event.preventDefault();
            const slot = Number(event.key) - 1;
            if (slot < itemsRef.current.length) {
              commit(slot);
            }
          }
          break;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!openRef.current || !holdModeRef.current) {
        return;
      }
      if (event.key === 'Control' || event.key === 'Meta' || (!event.ctrlKey && !event.metaKey)) {
        commit();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [cancel, commit, setOpen, step]);

  useEffect(() => {
    if (!open) {
      setHoldMode(false);
      setQuery('');
      armedRef.current = false;
      return;
    }
    if (armedRef.current) {
      armedRef.current = false;
      return;
    }
    setHoldMode(false);
    setIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    setIndex((current) => {
      const len = items.length;
      return len === 0 ? 0 : Math.min(current, len - 1);
    });
  }, [items.length]);

  useEffect(() => {
    if (query.length > 0) {
      setIndex(0);
    }
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-selected="true"]');
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [index, items]);

  const pillTransition = reduced ? { duration: 0 } : springSnappy;
  const nextChord = bindings['tab.next']?.[0] ?? 'Ctrl+Tab';

  return (
    <Presence>
      {open ? (
        <motion.div
          key="switcher-overlay"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[18vh]"
          variants={reduced ? reducedFadeVariants : fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              cancel();
            }
          }}
        >
          <motion.div
            key="switcher-panel"
            role="dialog"
            aria-label="Быстрый переход"
            className="flex w-[520px] max-w-full flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3"
            variants={reduced ? reducedFadeVariants : popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-stroke-0 px-3.5">
              <ArrowLeftRight size={15} strokeWidth={1.75} className="shrink-0 text-text-2" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Перейти к вкладке или заметке…"
                className="h-full w-full bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
              />
            </div>

            <div ref={listRef} className="max-h-[52vh] min-h-0 overflow-y-auto p-1.5">
              {items.length === 0 ? (
                <div className="px-3 py-8 text-center text-ui text-text-2">Ничего не найдено</div>
              ) : (
                items.map((item, position) => {
                  const selected = position === index;
                  const header =
                    query.trim().length === 0
                      ? position === 0
                        ? 'Недавние'
                        : null
                      : position === 0 || items[position - 1].kind !== item.kind
                        ? item.kind === 'tab'
                          ? 'Вкладки'
                          : 'Заметки'
                        : null;
                  return (
                    <Fragment key={item.key}>
                      {header !== null ? (
                        <div className="px-2.5 pb-1 pt-2 text-micro uppercase tracking-wide text-text-2">{header}</div>
                      ) : null}
                      <button
                        type="button"
                        data-selected={selected}
                        onMouseEnter={() => setIndex(position)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => commit(position)}
                        className="group relative flex h-11 w-full select-none items-center gap-2.5 rounded-s px-2.5 text-left text-ui text-text-1 data-[selected=true]:text-text-0"
                      >
                        {selected ? (
                          <>
                            <motion.span
                              layoutId="switcher-pill"
                              className="absolute inset-0 rounded-s bg-bg-3"
                              transition={pillTransition}
                            />
                            <motion.span
                              layoutId="switcher-bar"
                              className="absolute inset-y-2 left-1 w-0.5 rounded-full bg-accent"
                              transition={pillTransition}
                            />
                          </>
                        ) : null}
                        <span className="relative z-10 flex min-w-0 flex-1 items-center gap-2.5">
                          <NoteIcon
                            icon={item.icon}
                            color={item.color}
                            size={16}
                            className={item.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                          />
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                          {item.subtitle.length > 0 ? (
                            <span className="max-w-[42%] shrink-0 truncate text-caption text-text-2">{item.subtitle}</span>
                          ) : null}
                          {item.pinned === true ? (
                            <Pin size={12} strokeWidth={1.75} className="shrink-0 text-text-2" />
                          ) : null}
                          {item.dirty === true ? <span className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                          {holdMode && position < 9 ? <Kbd>{position + 1}</Kbd> : null}
                        </span>
                      </button>
                    </Fragment>
                  );
                })
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3.5 border-t border-stroke-0 px-3.5 py-2">
              <FooterHint keys={chordKeys(nextChord)} label="цикл" />
              <FooterHint keys={['↑', '↓']} label="выбрать" />
              <span className="flex items-center gap-1.5 text-micro text-text-2">
                <Kbd>
                  <CornerDownLeft size={11} strokeWidth={2} />
                </Kbd>
                открыть
              </span>
              <FooterHint keys={['Esc']} label="закрыть" />
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
