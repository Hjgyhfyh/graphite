import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { motion } from 'motion/react';
import {
  CalendarDays,
  Camera,
  ChevronRight,
  CornerDownLeft,
  FilePlus,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  Loader,
  PlugZap,
  Palette,
  Search,
  UploadCloud,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Kbd } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { SearchHit } from '@graphite/bindings';
import { runAction } from '../../app/Keymap';
import { ACTIONS, chordKeys, useKeybindingsStore } from '../../stores/keybindingsStore';
import { useGitStore } from '../../stores/gitStore';
import { useUiStore, RAIL_DEFAULT_ORDER } from '../../stores/uiStore';
import { openBriefView } from '../../stores/briefStore';
import { pickVaultFolder, switchVault } from '../../stores/vaultActions';
import { useVaultStore } from '../../stores/vaultStore';
import { useVaultsStore, vaultKey } from '../../stores/vaultsStore';
import { nextTheme, startThemeCrossfade } from '../../theme';
import { NoteIcon } from '../tree/NoteIcon';
import { RAIL_META } from '../rail/railItems';
import { OVERLAY_SCRIM } from '../../lib/overlay';
import { Presence, fadeVariants, popVariants, reducedFadeVariants, usePrefersReducedMotion } from '../../motion';

interface PaletteAction {
  id: string;
  title: string;
  icon: LucideIcon;
  run: () => void;
}

const VIEW_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'journal.today',
    title: 'Сегодня в дневнике',
    icon: CalendarDays,
    run: () => {
      useUiStore.getState().openJournalDay();
    },
  },
  ...RAIL_DEFAULT_ORDER.map((view) => ({
    id: `view.${view}`,
    title: `Раздел: ${RAIL_META[view].label}`,
    icon: RAIL_META[view].icon,
    run: () => {
      if (view === 'brief') {
        openBriefView();
        return;
      }
      const ui = useUiStore.getState();
      ui.setFocusMode(false);
      ui.setRailView(view);
      if (view === 'tree' || view === 'search') {
        ui.setSidebarHidden(false);
      }
    },
  })),
];

const BACKUP_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'git.snapshot',
    title: 'Сохранить точку восстановления',
    icon: Camera,
    run: () => {
      void useGitStore.getState().snapshot();
    },
  },
  {
    id: 'git.timeline',
    title: 'История версий',
    icon: History,
    run: () => {
      useGitStore.getState().openTimeline();
    },
  },
  {
    id: 'git.push',
    title: 'Резервная копия на GitHub',
    icon: UploadCloud,
    run: () => {
      void useGitStore.getState().push();
    },
  },
];

const APPEARANCE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'theme.cycle',
    title: 'Следующая тема оформления',
    icon: Palette,
    run: () => {
      const ui = useUiStore.getState();
      if (!ui.reducedMotion) {
        startThemeCrossfade();
      }
      ui.setTheme(nextTheme(ui.theme));
    },
  },
];

const VAULT_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'vault.openFolder',
    title: 'Хранилище: открыть папку…',
    icon: FolderOpen,
    run: () => {
      void pickVaultFolder(false);
    },
  },
  {
    id: 'vault.create',
    title: 'Хранилище: создать новое…',
    icon: FolderPlus,
    run: () => {
      void pickVaultFolder(true);
    },
  },
];

type FullTextState = 'idle' | 'loading' | 'ok' | 'empty' | 'unavailable' | 'error';

const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-2';

const ROW =
  'flex h-10 cursor-default select-none items-center gap-2.5 rounded-s px-2.5 text-ui text-text-1 data-[selected=true]:bg-bg-3 data-[selected=true]:text-text-0';

const HINT_ROW =
  'flex cursor-default select-none items-center gap-2.5 rounded-s px-2.5 py-2 text-caption text-text-2';

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

function ChordBadges({ chords }: { chords: string[] }) {
  if (chords.length === 0) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chordKeys(chords[0]).map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </span>
  );
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

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const quickSwitcherOpen = useUiStore((s) => s.quickSwitcherOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const bindings = useKeybindingsStore((s) => s.bindings);
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const vaultRoot = useVaultStore((s) => s.info?.root);
  const knownVaults = useVaultsStore((s) => s.known);
  const reduced = usePrefersReducedMotion();
  const [query, setQuery] = useState('');
  const [ftHits, setFtHits] = useState<SearchHit[]>([]);
  const [ftState, setFtState] = useState<FullTextState>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = () => {
    restoreFocusRef.current = null;
    setOpen(false);
  };

  const cancel = () => {
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    setOpen(false);
    if (previous !== null && previous.isConnected) {
      previous.focus();
    }
  };

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    setQuery('');
    setFtHits([]);
    setFtState('idle');
    return undefined;
  }, [open]);

  useEffect(() => {
    if (open && quickSwitcherOpen) {
      setOpen(false);
    }
  }, [open, quickSwitcherOpen, setOpen]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length === 0) {
      setFtHits([]);
      setFtState('idle');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFtState('loading');
      commands.search({ query: trimmed, limit: 8 }).then(
        (response) => {
          if (cancelled) {
            return;
          }
          setFtHits(response.hits);
          setFtState(response.hits.length > 0 ? 'ok' : 'empty');
        },
        (error: unknown) => {
          if (cancelled) {
            return;
          }
          setFtHits([]);
          setFtState(isGraphiteError(error) && error.code === 'UNAVAILABLE' ? 'unavailable' : 'error');
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  // Отложенный запрос уводит O(N) fold+fuzzy по дереву с критического пути ввода:
  // Command.Input остаётся на живом query, а тяжёлый матчинг и все производные от
  // него флаги считаются от dq — так список и «Создать «{…}»» согласованы.
  const dq = useDeferredValue(query);
  const trimmed = dq.trim();
  const hasQuery = trimmed.length > 0;
  const activeVaultKey = vaultRoot === undefined ? undefined : vaultKey(vaultRoot);
  const commandMatches = useMemo(
    () =>
      ACTIONS.filter(
        (action) => action.id !== 'palette.open' && action.id !== 'view.today' && matches(dq, action.title, action.group),
      ),
    [dq],
  );
  const backupMatches = useMemo(() => BACKUP_ACTIONS.filter((action) => matches(dq, action.title)), [dq]);
  const viewMatches = useMemo(() => VIEW_ACTIONS.filter((action) => matches(dq, action.title)), [dq]);
  const appearanceMatches = useMemo(() => APPEARANCE_ACTIONS.filter((action) => matches(dq, action.title)), [dq]);
  const vaultMatches = useMemo(
    () => knownVaults.filter((vault) => matches(dq, vault.name, vault.path)),
    [dq, knownVaults],
  );
  const vaultActionMatches = useMemo(() => VAULT_ACTIONS.filter((action) => matches(dq, action.title)), [dq]);
  const noteMatches = useMemo(
    () =>
      hasQuery
        ? tree.filter((node) => matches(dq, node.title, node.path)).slice(0, 8)
        : [...tree].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8),
    [dq, hasQuery, tree],
  );
  const ftUnique = useMemo(() => {
    const noteRefs = new Set(noteMatches.map((node) => node.ref));
    return ftHits.filter((hit) => !noteRefs.has(hit.ref));
  }, [noteMatches, ftHits]);

  return (
    <Presence>
      {open ? (
        <motion.div
          key="palette-overlay"
          className={`fixed inset-0 z-40 flex items-start justify-center px-4 pt-[15vh] ${OVERLAY_SCRIM}`}
          variants={reduced ? reducedFadeVariants : fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
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
            key="palette-panel"
            role="dialog"
            aria-label="Командная палитра"
            className="flex max-h-[70vh] w-[600px] max-w-full flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3"
            variants={reduced ? reducedFadeVariants : popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Command
              shouldFilter={false}
              vimBindings={false}
              label="Командная палитра"
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-stroke-0 px-3.5">
                <Search size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
                <Command.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Команда, заметка или поиск по тексту…"
                  className="h-full w-full bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
                />
              </div>
              <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {commandMatches.length > 0 ? (
                  <Command.Group heading="Команды" className={HEADING}>
                    {commandMatches.map((action) => (
                      <Command.Item
                        key={action.id}
                        value={`command-${action.id}`}
                        keywords={[action.title, action.group]}
                        onSelect={() => {
                          if (runAction(action.id)) {
                            close();
                          } else {
                            pushToast({ kind: 'info', text: 'Недоступно здесь' });
                          }
                        }}
                        className={ROW}
                      >
                        <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                        <span className="flex-1 truncate">{action.title}</span>
                        <ChordBadges chords={bindings[action.id] ?? []} />
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null}

                {viewMatches.length > 0 ? (
                  <Command.Group heading="Разделы" className={HEADING}>
                    {viewMatches.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Command.Item
                          key={action.id}
                          value={`view-${action.id}`}
                          keywords={[action.title]}
                          onSelect={() => {
                            close();
                            action.run();
                          }}
                          className={ROW}
                        >
                          <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                          <span className="flex-1 truncate">{action.title}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}

                {appearanceMatches.length > 0 ? (
                  <Command.Group heading="Оформление" className={HEADING}>
                    {appearanceMatches.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Command.Item
                          key={action.id}
                          value={`appear-${action.id}`}
                          keywords={[action.title]}
                          onSelect={() => {
                            close();
                            action.run();
                          }}
                          className={ROW}
                        >
                          <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                          <span className="flex-1 truncate">{action.title}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}

                {backupMatches.length > 0 ? (
                  <Command.Group heading="Резервные копии" className={HEADING}>
                    {backupMatches.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Command.Item
                          key={action.id}
                          value={`backup-${action.id}`}
                          keywords={[action.title]}
                          onSelect={() => {
                            close();
                            action.run();
                          }}
                          className={ROW}
                        >
                          <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                          <span className="flex-1 truncate">{action.title}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}

                {vaultMatches.length > 0 || vaultActionMatches.length > 0 ? (
                  <Command.Group heading="Хранилища" className={HEADING}>
                    {vaultMatches.map((vault) => {
                      const active = activeVaultKey !== undefined && vaultKey(vault.path) === activeVaultKey;
                      return (
                        <Command.Item
                          key={`vault-${vaultKey(vault.path)}`}
                          value={`vault-${vaultKey(vault.path)}`}
                          keywords={[vault.name, vault.path]}
                          onSelect={() => {
                            close();
                            if (!active) {
                              void switchVault(vault.path);
                            }
                          }}
                          className={ROW}
                        >
                          <HardDrive
                            size={16}
                            strokeWidth={1.75}
                            className={active ? 'shrink-0 text-accent' : 'shrink-0 text-text-3'}
                          />
                          <span className="flex-1 truncate">{vault.name}</span>
                          {active ? (
                            <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-micro text-accent">
                              активное
                            </span>
                          ) : (
                            <span className="max-w-[45%] shrink-0 truncate font-mono text-micro text-text-3">
                              {vault.path}
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                    {vaultActionMatches.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Command.Item
                          key={action.id}
                          value={`vault-action-${action.id}`}
                          keywords={[action.title]}
                          onSelect={() => {
                            close();
                            action.run();
                          }}
                          className={ROW}
                        >
                          <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                          <span className="flex-1 truncate">{action.title}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}

                {noteMatches.length > 0 ? (
                  <Command.Group heading={hasQuery ? 'Заметки' : 'Недавние'} className={HEADING}>
                    {noteMatches.map((node) => {
                      const info = iconByRef[node.ref] ?? { icon: node.icon, color: node.iconColor };
                      return (
                        <Command.Item
                          key={node.ref}
                          value={`note-${node.ref}`}
                          keywords={[node.title, node.path]}
                          onSelect={() => {
                            close();
                            useVaultStore.getState().openNote(node.ref);
                          }}
                          className={ROW}
                        >
                          <NoteIcon
                            icon={info.icon}
                            color={info.color}
                            size={15}
                            className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                          />
                          <span className="flex-1 truncate">{node.title}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}

                {hasQuery && ftState !== 'idle' && (ftState !== 'ok' || ftUnique.length > 0) ? (
                  <Command.Group heading="Полнотекст" className={HEADING}>
                    {ftState === 'loading' ? (
                      <Command.Item disabled value="ft-loading" className={HINT_ROW}>
                        <Loader size={15} strokeWidth={1.75} className="shrink-0 animate-spin text-text-3" />
                        <span className="flex-1 truncate">Ищу в тексте…</span>
                      </Command.Item>
                    ) : null}
                    {ftState === 'ok'
                      ? ftUnique.map((hit) => {
                          const info = iconByRef[hit.ref] ?? { icon: undefined, color: undefined };
                          return (
                            <Command.Item
                              key={`ft-${hit.ref}`}
                              value={`ft-${hit.ref}`}
                              keywords={[hit.title]}
                              onSelect={() => {
                                close();
                                useVaultStore.getState().openNote(hit.ref);
                              }}
                              className="flex cursor-default select-none flex-col gap-0.5 rounded-s px-2.5 py-1.5 data-[selected=true]:bg-bg-3"
                            >
                              <span className="flex items-center gap-2.5">
                                <NoteIcon
                                  icon={info.icon}
                                  color={info.color}
                                  size={15}
                                  className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                                />
                                <span className="flex-1 truncate text-ui text-text-1">{hit.title}</span>
                              </span>
                              {hit.snippets[0] !== undefined ? (
                                <span className="line-clamp-2 pl-[26px] text-caption text-text-2">{hit.snippets[0]}</span>
                              ) : null}
                            </Command.Item>
                          );
                        })
                      : null}
                    {ftState === 'empty' ? (
                      <Command.Item disabled value="ft-empty" className={HINT_ROW}>
                        <Search size={15} strokeWidth={1.75} className="shrink-0 text-text-3" />
                        <span className="flex-1 truncate">В тексте совпадений нет</span>
                      </Command.Item>
                    ) : null}
                    {ftState === 'unavailable' ? (
                      <Command.Item disabled value="ft-unavailable" className={HINT_ROW}>
                        <PlugZap size={15} strokeWidth={1.75} className="shrink-0 text-text-3" />
                        <span className="flex-1 truncate">Полнотекст подключится вместе с ядром</span>
                      </Command.Item>
                    ) : null}
                    {ftState === 'error' ? (
                      <Command.Item disabled value="ft-error" className={HINT_ROW}>
                        <PlugZap size={15} strokeWidth={1.75} className="shrink-0 text-text-3" />
                        <span className="flex-1 truncate">Поиск временно недоступен</span>
                      </Command.Item>
                    ) : null}
                  </Command.Group>
                ) : null}

                {hasQuery ? (
                  <Command.Group heading="Создать" className={HEADING}>
                    <Command.Item
                      value="create-note"
                      onSelect={() => {
                        close();
                        void useVaultStore.getState().createNote({ title: trimmed });
                      }}
                      className={ROW}
                    >
                      <FilePlus size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
                      <span className="flex-1 truncate">
                        Новая заметка «<span className="text-text-0">{trimmed}</span>»
                      </span>
                    </Command.Item>
                  </Command.Group>
                ) : null}
              </Command.List>

              <div className="flex shrink-0 items-center gap-3.5 border-t border-stroke-0 px-3.5 py-2">
                <FooterHint keys={['↑', '↓']} label="выбрать" />
                <span className="flex items-center gap-1.5 text-micro text-text-2">
                  <Kbd>
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </Kbd>
                  открыть
                </span>
                <FooterHint keys={['Esc']} label="закрыть" />
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
