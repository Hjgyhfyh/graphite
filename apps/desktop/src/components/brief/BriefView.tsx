import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  AlignLeft,
  Compass,
  Copy,
  Eraser,
  FileCode2,
  FileDown,
  FilePlus,
  FolderOpen,
  Gauge,
  Loader,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { Button, cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { TreeNode } from '@graphite/bindings';
import {
  Presence,
  fadeVariants,
  listContainerVariants,
  listItemVariants,
  reducedFadeVariants,
  slideUpVariants,
  usePrefersReducedMotion,
} from '../../motion';
import {
  closeBriefView,
  normalizeExternalPath,
  openBriefView,
  useBriefStore,
} from '../../stores/briefStore';
import type { BriefNoteFile } from '../../stores/briefStore';
import { useGitStore } from '../../stores/gitStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { NoteIcon } from '../tree/NoteIcon';
import { NotePicker } from './NotePicker';
import {
  briefNoteTitle,
  composeBrief,
  estimateBriefChars,
  estimateTokens,
  formatChars,
  readNoteChars,
} from './composeBrief';

const WARN_CHARS = 80_000;
const DANGER_CHARS = 160_000;
const FLASH_MS = 1500;

const CARD = 'flex flex-col gap-3 rounded-m border border-stroke-0 bg-bg-1 p-4';
const CARD_LABEL = 'flex items-center gap-2 text-ui text-text-1';
const CARD_HINT = 'text-caption text-text-3';
const GHOST_ADD_ROW =
  'inline-flex items-center gap-1.5 self-start rounded-s px-1.5 py-1 text-caption text-text-2 transition-colors duration-[120ms] hover:text-text-0';
const ROW_REMOVE =
  'flex shrink-0 items-center justify-center rounded-xs p-1 text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-danger';

function reason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

function filesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return 'файл';
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return 'файла';
  }
  return 'файлов';
}

function externalName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  const name = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  return name.length > 0 ? name : path;
}

interface GrowingTextareaProps {
  value: string;
  minHeight: number;
  placeholder?: string;
  className?: string;
  onValueChange: (value: string) => void;
  assignRef?: (el: HTMLTextAreaElement | null) => void;
}

function GrowingTextarea({ value, minHeight, placeholder, className, onValueChange, assignRef }: GrowingTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (el === null) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
  }, [value, minHeight]);
  return (
    <textarea
      ref={(el) => {
        innerRef.current = el;
        assignRef?.(el);
      }}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onValueChange(event.target.value)}
      className={cx('w-full resize-none outline-none', className)}
      style={{ minHeight }}
    />
  );
}

function KeyHint({ keys, onPrimary }: { keys: string[]; onPrimary?: boolean }) {
  return (
    <span aria-hidden className="ml-0.5 flex items-center gap-0.5">
      {keys.map((key) => (
        <kbd
          key={key}
          className={cx(
            'rounded-xs border px-1 font-mono text-[10px] leading-[14px]',
            onPrimary === true ? 'border-bg-0/25 bg-bg-0/10 text-bg-0/80' : 'border-stroke-1 bg-bg-2 text-text-2',
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function BriefView() {
  const idea = useBriefStore((s) => s.idea);
  const description = useBriefStore((s) => s.description);
  const files = useBriefStore((s) => s.files);
  const directions = useBriefStore((s) => s.directions);
  const setIdea = useBriefStore((s) => s.setIdea);
  const setDescription = useBriefStore((s) => s.setDescription);
  const setFileWhy = useBriefStore((s) => s.setFileWhy);
  const removeFile = useBriefStore((s) => s.removeFile);
  const setDirection = useBriefStore((s) => s.setDirection);
  const removeDirection = useBriefStore((s) => s.removeDirection);
  const setNotePickerOpen = useBriefStore((s) => s.setNotePickerOpen);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const pushToast = useUiStore((s) => s.pushToast);
  const reduced = usePrefersReducedMotion();
  const tauriOk = isTauriAvailable();

  const [busy, setBusy] = useState<'copy' | 'create' | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const [pathFormOpen, setPathFormOpen] = useState(false);
  const [pathValue, setPathValue] = useState('');
  const [pendingChars, setPendingChars] = useState<ReadonlySet<string>>(() => new Set());
  const [flashId, setFlashId] = useState<string | undefined>(undefined);

  const ideaRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const directionRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const flashTimer = useRef<number | undefined>(undefined);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pathFormOpenRef = useRef(pathFormOpen);
  pathFormOpenRef.current = pathFormOpen;

  const ideaEmpty = idea.trim().length === 0;
  const draftEmpty =
    ideaEmpty && description.trim().length === 0 && files.length === 0 && directions.length === 0;
  const actionsDisabled = ideaEmpty || busy !== undefined;
  const estimated = estimateBriefChars({ idea, description, files, directions });
  const counterTone =
    estimated > DANGER_CHARS ? 'text-danger' : estimated > WARN_CHARS ? 'text-warn' : 'text-text-2';

  const sectionVariants = reduced ? reducedFadeVariants : listItemVariants;
  const rowVariants = reduced ? reducedFadeVariants : listItemVariants;

  const flashRow = useCallback((id: string) => {
    window.clearTimeout(flashTimer.current);
    setFlashId(undefined);
    requestAnimationFrame(() => {
      setFlashId(id);
      flashTimer.current = window.setTimeout(() => setFlashId(undefined), FLASH_MS);
    });
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(flashTimer.current);
    };
  }, []);

  const setPending = useCallback((id: string, on: boolean) => {
    setPendingChars((prev) => {
      if (prev.has(id) === on) {
        return prev;
      }
      const next = new Set(prev);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const loadChars = useCallback(
    async (file: Pick<BriefNoteFile, 'id' | 'ref' | 'title' | 'path'>, silent: boolean) => {
      setPending(file.id, true);
      try {
        const chars = await readNoteChars(file);
        useBriefStore.getState().setNoteChars(file.id, chars);
      } catch (error) {
        if (!silent) {
          pushToast({ kind: 'error', text: reason(error, `Не удалось прочитать «${file.title}»`) });
        }
      } finally {
        setPending(file.id, false);
      }
    },
    [pushToast, setPending],
  );

  useEffect(() => {
    if (useBriefStore.getState().idea.trim().length > 0) {
      return undefined;
    }
    const raf = requestAnimationFrame(() => ideaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    for (const file of useBriefStore.getState().files) {
      if (file.kind === 'note' && file.chars === undefined) {
        void loadChars(file, true);
      }
    }
  }, [loadChars]);

  useEffect(() => {
    if (!pathFormOpen) {
      return undefined;
    }
    const raf = requestAnimationFrame(() => pathInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [pathFormOpen]);

  const handleAddNote = useCallback(
    (node: TreeNode): boolean => {
      const store = useBriefStore.getState();
      const added = store.addNoteFile({ ref: node.ref, title: node.title, path: node.path, why: '' });
      if (!added) {
        const existing = store.files.find(
          (file): file is BriefNoteFile => file.kind === 'note' && file.ref === node.ref,
        );
        if (existing !== undefined) {
          flashRow(existing.id);
        }
        pushToast({ kind: 'info', text: 'Уже в списке опорных' });
        return false;
      }
      const created = useBriefStore
        .getState()
        .files.find((file): file is BriefNoteFile => file.kind === 'note' && file.ref === node.ref);
      if (created !== undefined) {
        void loadChars(created, false);
      }
      return true;
    },
    [flashRow, loadChars, pushToast],
  );

  const handleExternalPaths = useCallback(
    (paths: string[]) => {
      const store = useBriefStore.getState();
      const before = new Map<string, string>();
      for (const file of store.files) {
        if (file.kind === 'external') {
          before.set(normalizeExternalPath(file.path), file.id);
        }
      }
      const added = store.addExternalFiles(paths);
      const duplicateId = paths
        .map((path) => before.get(normalizeExternalPath(path)))
        .find((id): id is string => id !== undefined);
      if (added > 0) {
        pushToast({
          kind: 'success',
          text: added === 1 ? 'Файл добавлен в опорные' : `Добавлено файлов: ${added}`,
        });
      }
      if (duplicateId !== undefined) {
        flashRow(duplicateId);
        pushToast({ kind: 'info', text: 'Уже в списке опорных' });
      }
    },
    [flashRow, pushToast],
  );

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
          if (payload.paths.length > 0) {
            setDragOver(true);
          }
        } else if (payload.type === 'leave') {
          setDragOver(false);
        } else if (payload.type === 'drop') {
          setDragOver(false);
          if (payload.paths.length > 0) {
            handleExternalPaths(payload.paths);
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
  }, [handleExternalPaths]);

  const runCopy = useCallback(async () => {
    if (busyRef.current !== undefined) {
      return;
    }
    const draft = useBriefStore.getState().snapshot();
    if (draft.idea.trim().length === 0) {
      pushToast({ kind: 'info', text: 'Сначала запишите идею' });
      return;
    }
    setBusy('copy');
    try {
      const composed = await composeBrief(draft);
      try {
        await navigator.clipboard.writeText(composed.text);
      } catch {
        pushToast({ kind: 'error', text: 'Не удалось скопировать в буфер' });
        return;
      }
      if (composed.truncatedTitles.length > 0) {
        pushToast({ kind: 'info', text: `Обрезаны длинные заметки: ${composed.truncatedTitles.join(', ')}` });
      }
      const filesPart =
        draft.files.length > 0 ? ` · ${draft.files.length} ${filesWord(draft.files.length)}` : '';
      pushToast({
        kind: 'success',
        text: `Бриф скопирован${filesPart} · ≈ ${formatChars(composed.chars)} знаков`,
      });
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось собрать бриф') });
    } finally {
      setBusy(undefined);
    }
  }, [pushToast]);

  const runCreate = useCallback(async () => {
    if (busyRef.current !== undefined) {
      return;
    }
    const draft = useBriefStore.getState().snapshot();
    if (draft.idea.trim().length === 0) {
      pushToast({ kind: 'info', text: 'Сначала запишите идею' });
      return;
    }
    setBusy('create');
    try {
      const composed = await composeBrief(draft);
      const created = await commands.noteCreate({ title: briefNoteTitle(draft.idea), content: composed.text });
      const snap = useBriefStore.getState().snapshot();
      useBriefStore.getState().clear();
      void useVaultStore.getState().loadTree();
      useVaultStore.getState().openNote(created.ref);
      useUiStore.getState().setRailView('tree');
      useUiStore.getState().setSidebarHidden(false);
      pushToast({
        kind: 'success',
        text: 'Заметка-план создана',
        action: {
          label: 'Вернуть черновик',
          run: () => {
            useBriefStore.getState().restore(snap);
            openBriefView();
          },
        },
      });
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось создать заметку') });
    } finally {
      setBusy(undefined);
    }
  }, [pushToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (
        ui.paletteOpen ||
        ui.quickSwitcherOpen ||
        ui.floatingCaptureOpen ||
        useGitStore.getState().timelineOpen ||
        useBriefStore.getState().notePickerOpen
      ) {
        return;
      }
      if (event.key === 'Escape') {
        if (busyRef.current !== undefined) {
          return;
        }
        event.preventDefault();
        if (pathFormOpenRef.current) {
          setPathFormOpen(false);
          setPathValue('');
          return;
        }
        closeBriefView();
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        if (busyRef.current !== undefined) {
          return;
        }
        if (event.shiftKey) {
          void runCreate();
        } else {
          void runCopy();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [runCopy, runCreate]);

  const registerDirectionRef = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el === null) {
      directionRefs.current.delete(id);
    } else {
      directionRefs.current.set(id, el);
    }
  }, []);

  const handleAddDirection = () => {
    const id = useBriefStore.getState().addDirection();
    requestAnimationFrame(() => directionRefs.current.get(id)?.focus());
  };

  const closePathForm = () => {
    setPathFormOpen(false);
    setPathValue('');
  };

  const submitPath = () => {
    const value = pathValue.trim();
    if (value.length === 0) {
      return;
    }
    handleExternalPaths([value]);
    setPathValue('');
    pathInputRef.current?.focus();
  };

  const onPathKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      submitPath();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePathForm();
    }
  };

  const browseExternal = async () => {
    try {
      const selected = await invoke<string | string[] | null>('plugin:dialog|open', {
        options: { multiple: true, title: 'Опорные файлы' },
      });
      if (typeof selected === 'string') {
        handleExternalPaths([selected]);
      } else if (Array.isArray(selected)) {
        handleExternalPaths(selected.filter((path): path is string => typeof path === 'string'));
      }
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось открыть диалог выбора файла' });
    }
  };

  const clearDraft = () => {
    const store = useBriefStore.getState();
    const snap = store.snapshot();
    store.clear();
    pushToast({
      kind: 'info',
      text: 'Черновик очищен',
      action: { label: 'Вернуть', run: () => useBriefStore.getState().restore(snap) },
    });
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-bg-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <motion.div
          variants={reduced ? undefined : listContainerVariants}
          initial="initial"
          animate="animate"
          className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 pb-10 pt-8"
        >
          <motion.header variants={sectionVariants} className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-s bg-ai/15 text-ai">
                  <Sparkles size={17} strokeWidth={1.75} />
                </span>
                <h1 className="text-h2 text-text-0">Идея → задание для Claude</h1>
              </div>
              <p className="text-caption text-text-2">
                Соберите бриф — Claude получит цель, контекст и ваши направления одним сообщением.
              </p>
            </div>
            {!draftEmpty ? (
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={clearDraft}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-s px-2 text-caption text-text-2 transition-colors duration-[120ms] hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-45"
              >
                <Eraser size={13} strokeWidth={1.75} />
                Очистить черновик
              </button>
            ) : null}
          </motion.header>

          <motion.section variants={sectionVariants} aria-label="Идея">
            <input
              ref={ideaRef}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="Идея одной фразой…"
              aria-label="Идея"
              className="w-full border-b border-stroke-0 bg-transparent pb-3 text-h2 text-text-0 caret-accent outline-none transition-colors duration-[120ms] placeholder:text-text-3 focus:border-accent/50"
            />
          </motion.section>

          <motion.section variants={sectionVariants} className={CARD} aria-label="Описание">
            <div className={CARD_LABEL}>
              <AlignLeft size={15} strokeWidth={1.75} className="text-accent" />
              Описание
              <span className={CARD_HINT}>что сделать и как понять, что готово</span>
            </div>
            <GrowingTextarea
              value={description}
              minHeight={96}
              placeholder="Контекст, желаемый результат, критерии готовности…"
              className="rounded-s border border-stroke-1 bg-bg-2 px-3 py-2 text-body text-text-0 caret-accent transition-colors duration-[120ms] placeholder:text-text-3 focus:border-accent/50"
              onValueChange={setDescription}
            />
          </motion.section>

          <motion.section variants={sectionVariants} className={CARD} aria-label="Опорные файлы">
            <div className={CARD_LABEL}>
              <Paperclip size={15} strokeWidth={1.75} className="text-accent" />
              Опорные файлы
              {files.length > 0 ? <span className={CARD_HINT}>{files.length}</span> : null}
              <span className="ml-auto text-micro text-text-3">заметки войдут содержимым, внешние — путями</span>
            </div>

            {files.length === 0 ? (
              <div className="rounded-s border border-dashed border-stroke-1 px-6 py-6 text-center text-caption text-text-2">
                {tauriOk
                  ? 'Перетащите файлы прямо в окно — или добавьте заметку из хранилища'
                  : 'Добавьте заметку из хранилища или укажите путь к файлу'}
              </div>
            ) : (
              <motion.ul
                variants={reduced ? undefined : listContainerVariants}
                initial="initial"
                animate="animate"
                className="flex flex-col gap-1.5"
              >
                <Presence mode="popLayout">
                  {files.map((file) => (
                    <motion.li
                      key={file.id}
                      layout={!reduced}
                      variants={rowVariants}
                      exit="exit"
                      className="relative flex flex-col gap-1 rounded-s border border-transparent bg-bg-2 px-2.5 py-2 transition-colors duration-[120ms] focus-within:border-stroke-1"
                    >
                      {flashId === file.id ? (
                        <span aria-hidden className="pointer-events-none absolute inset-0 animate-ai-dim rounded-s" />
                      ) : null}
                      <div className="flex items-center gap-2">
                        {file.kind === 'note' ? (
                          <NoteIcon
                            icon={(iconByRef[file.ref] ?? {}).icon}
                            color={(iconByRef[file.ref] ?? {}).color}
                            size={15}
                            className={
                              (iconByRef[file.ref] ?? {}).color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'
                            }
                          />
                        ) : (
                          <FileCode2 size={15} strokeWidth={1.75} className="shrink-0 text-text-2" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-ui text-text-0">
                          {file.kind === 'note' ? file.title : externalName(file.path)}
                        </span>
                        {file.kind === 'note' ? (
                          file.chars !== undefined ? (
                            <span className="shrink-0 font-mono text-micro text-text-3">
                              ≈ {formatChars(file.chars)}
                            </span>
                          ) : pendingChars.has(file.id) ? (
                            <Loader
                              size={13}
                              strokeWidth={1.75}
                              className={cx('shrink-0 text-text-2', !reduced && 'animate-spin')}
                            />
                          ) : (
                            <span
                              className="shrink-0 font-mono text-micro text-text-3"
                              title="Размер посчитаю при сборке"
                            >
                              —
                            </span>
                          )
                        ) : null}
                        <button
                          type="button"
                          aria-label="Убрать из опорных"
                          onClick={() => removeFile(file.id)}
                          className={ROW_REMOVE}
                        >
                          <X size={14} strokeWidth={1.75} />
                        </button>
                      </div>
                      <span className="truncate pl-[23px] font-mono text-micro text-text-3" title={file.path}>
                        {file.path}
                      </span>
                      <div className="pl-[23px]">
                        <input
                          value={file.why}
                          onChange={(event) => setFileWhy(file.id, event.target.value)}
                          placeholder="Зачем этот файл…"
                          aria-label="Зачем этот файл"
                          className="w-full bg-transparent text-caption text-text-1 caret-accent outline-none placeholder:text-text-3"
                        />
                      </div>
                    </motion.li>
                  ))}
                </Presence>
              </motion.ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setNotePickerOpen(true)}>
                <Plus size={14} strokeWidth={1.75} />
                Заметка из хранилища
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (pathFormOpen) {
                    pathInputRef.current?.focus();
                  } else {
                    setPathFormOpen(true);
                  }
                }}
              >
                <Plus size={14} strokeWidth={1.75} />
                Внешний файл…
              </Button>
            </div>

            <Presence>
              {pathFormOpen ? (
                <motion.div
                  key="external-path-form"
                  variants={reduced ? reducedFadeVariants : slideUpVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex items-center gap-2"
                >
                  <input
                    ref={pathInputRef}
                    value={pathValue}
                    onChange={(event) => setPathValue(event.target.value)}
                    onKeyDown={onPathKeyDown}
                    placeholder="C:\путь\к\файлу или папке"
                    aria-label="Путь к внешнему файлу"
                    className="h-7 min-w-0 flex-1 rounded-s border border-stroke-1 bg-bg-2 px-2.5 font-mono text-caption text-text-0 caret-accent outline-none transition-colors duration-[120ms] placeholder:text-text-3 focus:border-accent/50"
                  />
                  {tauriOk ? (
                    <Button variant="ghost" size="sm" onClick={() => void browseExternal()}>
                      <FolderOpen size={14} strokeWidth={1.75} />
                      Обзор…
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" disabled={pathValue.trim().length === 0} onClick={submitPath}>
                    Добавить
                  </Button>
                  <button type="button" aria-label="Скрыть поле пути" onClick={closePathForm} className={ROW_REMOVE}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </motion.div>
              ) : null}
            </Presence>
          </motion.section>

          <motion.section variants={sectionVariants} className={CARD} aria-label="Направления от меня">
            <div className={CARD_LABEL}>
              <Compass size={15} strokeWidth={1.75} className="text-accent" />
              Направления от меня
              <span className={CARD_HINT}>рамки для Claude: что важно, что не трогать, какой стиль</span>
            </div>

            {directions.length > 0 ? (
              <motion.ul
                variants={reduced ? undefined : listContainerVariants}
                initial="initial"
                animate="animate"
                className="flex flex-col gap-1.5"
              >
                <Presence mode="popLayout">
                  {directions.map((direction, index) => (
                    <motion.li
                      key={direction.id}
                      layout={!reduced}
                      variants={rowVariants}
                      exit="exit"
                      className="flex items-start gap-2.5 rounded-s border border-transparent bg-bg-2 px-2.5 py-2 transition-colors duration-[120ms] focus-within:border-stroke-1"
                    >
                      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-micro font-medium text-accent">
                        {index + 1}
                      </span>
                      <GrowingTextarea
                        value={direction.text}
                        minHeight={20}
                        placeholder="Например: не трогать публичный API, тексты держать на русском…"
                        className="flex-1 bg-transparent text-ui text-text-0 caret-accent placeholder:text-text-3"
                        onValueChange={(text) => setDirection(direction.id, text)}
                        assignRef={(el) => registerDirectionRef(direction.id, el)}
                      />
                      <button
                        type="button"
                        aria-label="Убрать направление"
                        onClick={() => removeDirection(direction.id)}
                        className={ROW_REMOVE}
                      >
                        <X size={14} strokeWidth={1.75} />
                      </button>
                    </motion.li>
                  ))}
                </Presence>
              </motion.ul>
            ) : null}

            <button type="button" onClick={handleAddDirection} className={GHOST_ADD_ROW}>
              <Plus size={14} strokeWidth={1.75} />
              Добавить направление
            </button>
          </motion.section>
        </motion.div>
      </div>

      <footer className="shrink-0 border-t border-stroke-0 bg-bg-1/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-8 py-3">
          {draftEmpty ? (
            <span className="text-caption text-text-3">Идея, контекст и направления — одним сообщением</span>
          ) : (
            <span
              className={cx('flex items-center gap-1.5 text-caption transition-colors duration-[120ms]', counterTone)}
              title={estimated > DANGER_CHARS ? 'Очень большой бриф — Claude может не вместить всё' : undefined}
            >
              <Gauge size={13} strokeWidth={1.75} />≈ {formatChars(estimated)} знаков · ~
              {formatChars(estimateTokens(estimated))} токенов
            </span>
          )}
          <span className="flex-1" />
          <div
            className="flex items-center gap-2"
            title={ideaEmpty && busy === undefined ? 'Сначала запишите идею' : undefined}
          >
            <Button variant="ghost" disabled={actionsDisabled} onClick={() => void runCreate()}>
              {busy === 'create' ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <FilePlus size={14} strokeWidth={1.75} />
              )}
              {busy === 'create' ? 'Создаю…' : 'Создать заметку-план'}
              <KeyHint keys={['Ctrl', 'Shift', '⏎']} />
            </Button>
            <Button variant="primary" disabled={actionsDisabled} onClick={() => void runCopy()}>
              {busy === 'copy' ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <Copy size={14} strokeWidth={1.75} />
              )}
              {busy === 'copy' ? 'Собираю…' : 'Скопировать для Claude'}
              <KeyHint keys={['Ctrl', '⏎']} onPrimary />
            </Button>
          </div>
        </div>
      </footer>

      <Presence>
        {dragOver ? (
          <motion.div
            key="brief-drop-overlay"
            variants={reduced ? reducedFadeVariants : fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-20 flex items-center justify-center bg-bg-0/70 p-8 backdrop-blur-sm"
          >
            <div className="flex w-full max-w-xl flex-col items-center gap-3 rounded-l border-2 border-dashed border-ai bg-bg-1/85 px-8 py-10 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-ai/15 text-ai">
                <FileDown size={22} strokeWidth={1.75} />
              </span>
              <p className="text-ui text-text-0">Отпустите — добавлю в опорные файлы</p>
              <p className="text-caption text-text-2">В бриф попадут пути — содержимое Claude прочитает сам</p>
            </div>
          </motion.div>
        ) : null}
      </Presence>

      <NotePicker onAdd={handleAddNote} />
    </main>
  );
}
