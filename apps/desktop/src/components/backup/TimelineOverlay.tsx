import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { Variants } from 'motion/react';
import {
  ArrowLeft,
  Camera,
  Clock,
  FileDiff,
  GitCommitVertical,
  History,
  Loader,
  RotateCcw,
  Undo2,
  User,
  X,
} from 'lucide-react';
import { Button, cx } from '@graphite/ui';
import { Presence, springSnappy, usePrefersReducedMotion } from '../../motion';
import { OVERLAY_SCRIM } from '../../lib/overlay';
import { useGitStore } from '../../stores/gitStore';
import type { GitFileChange } from '@graphite/bindings';

/** Максимум строк diff в рендере — очень большие изменения не топят DOM. */
const DIFF_LINE_CAP = 2600;

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

function classifyDiff(line: string): DiffLineKind {
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('similarity ') ||
    line.startsWith('\\ ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'del';
  }
  return 'ctx';
}

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-ok/10 text-ok',
  del: 'bg-danger/10 text-danger',
  hunk: 'bg-accent/8 text-accent',
  meta: 'text-text-3',
  ctx: 'text-text-1',
};

const FILE_BADGE: Record<string, { label: string; className: string; title: string }> = {
  A: { label: 'A', className: 'bg-ok/15 text-ok', title: 'Добавлен' },
  M: { label: 'M', className: 'bg-accent/15 text-accent', title: 'Изменён' },
  D: { label: 'D', className: 'bg-danger/15 text-danger', title: 'Удалён' },
  R: { label: 'R', className: 'bg-warn/15 text-warn', title: 'Переименован' },
};

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) {
    return 'только что';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days === 1) {
    return 'вчера';
  }
  if (days < 7) {
    return `${days} дн назад`;
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } },
};

const panelVariants: Variants = {
  initial: { opacity: 0, scale: 0.985, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: springSnappy },
  exit: { opacity: 0, scale: 0.99, y: 6, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } },
};

const reducedVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.08, ease: 'linear' } },
  exit: { opacity: 0, transition: { duration: 0.08, ease: 'linear' } },
};

const railVariants: Variants = {
  animate: { transition: { staggerChildren: 0.028, delayChildren: 0.05 } },
};

const railItemVariants: Variants = {
  initial: { opacity: 0, x: -10 },
  animate: { opacity: 1, x: 0, transition: springSnappy },
};

function FileBadge({ status }: { status: string }) {
  const badge = FILE_BADGE[status] ?? FILE_BADGE.M;
  return (
    <span
      title={badge.title}
      className={cx(
        'flex size-[18px] shrink-0 items-center justify-center rounded-xs font-mono text-micro font-semibold',
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}

function DiffView({ text, loading }: { text: string; loading: boolean }) {
  const lines = useMemo<DiffLine[]>(() => {
    if (text.length === 0) {
      return [];
    }
    const raw = text.split('\n');
    const capped = raw.slice(0, DIFF_LINE_CAP);
    const mapped: DiffLine[] = capped.map((line) => ({ kind: classifyDiff(line), text: line }));
    if (raw.length > DIFF_LINE_CAP) {
      mapped.push({ kind: 'meta', text: `… ещё ${raw.length - DIFF_LINE_CAP} строк` });
    }
    return mapped;
  }, [text]);

  if (loading && lines.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-caption text-text-2">
        <Loader size={15} strokeWidth={1.75} className="animate-spin" />
        Загрузка изменений…
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-text-3">
        <FileDiff size={22} strokeWidth={1.5} />
        <span className="text-caption">Нет изменений для показа</span>
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <pre className="min-w-full py-1 font-mono text-[11.5px] leading-[17px]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cx('whitespace-pre px-3', DIFF_LINE_CLASS[line.kind])}
          >
            {line.text.length > 0 ? line.text : ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function TimelineOverlay() {
  const open = useGitStore((s) => s.timelineOpen);
  const close = useGitStore((s) => s.closeTimeline);
  const log = useGitStore((s) => s.log);
  const logLoading = useGitStore((s) => s.logLoading);
  const selectedHash = useGitStore((s) => s.selectedHash);
  const selectedPath = useGitStore((s) => s.selectedPath);
  const files = useGitStore((s) => s.filesOfSelected);
  const diffText = useGitStore((s) => s.diffText);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const busy = useGitStore((s) => s.busy);
  const status = useGitStore((s) => s.status);
  const selectCommit = useGitStore((s) => s.selectCommit);
  const viewFile = useGitStore((s) => s.viewFile);
  const clearFileView = useGitStore((s) => s.clearFileView);
  const restoreCommit = useGitStore((s) => s.restoreCommit);
  const restoreFile = useGitStore((s) => s.restoreFile);
  const snapshot = useGitStore((s) => s.snapshot);
  const reduced = usePrefersReducedMotion();

  const [confirmCommit, setConfirmCommit] = useState(false);
  const [confirmFile, setConfirmFile] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Сбрасываем подтверждения при смене выбранного коммита/файла.
  useEffect(() => {
    setConfirmCommit(false);
    setConfirmFile(null);
  }, [selectedHash, selectedPath]);

  const selected = useMemo(
    () => log.find((commit) => commit.hash === selectedHash) ?? null,
    [log, selectedHash],
  );
  const activeFile = useMemo<GitFileChange | null>(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  const contentVariants = reduced ? reducedVariants : panelVariants;
  const emptyHistory = !logLoading && log.length === 0;

  return (
    <Presence>
      {open ? (
        <motion.div
          key="timeline-overlay"
          className={`fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-8 ${OVERLAY_SCRIM}`}
          variants={reduced ? reducedVariants : overlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
        >
          <motion.div
            key="timeline-panel"
            role="dialog"
            aria-label="История версий"
            className="flex h-full max-h-[860px] w-full max-w-6xl flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-1 shadow-3"
            variants={contentVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex h-13 shrink-0 items-center gap-3 border-b border-stroke-0 px-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 text-accent">
                <History size={16} strokeWidth={1.75} />
              </span>
              <div className="flex min-w-0 flex-col">
                <h2 className="text-ui font-semibold text-text-0">История версий</h2>
                <span className="truncate text-micro text-text-2">
                  {status?.branch !== undefined ? `Ветка ${status.branch} · ` : ''}
                  {log.length > 0 ? `${log.length} снимков` : 'Снимков пока нет'}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void snapshot()}
                  disabled={busy || status?.isRepo !== true}
                >
                  <Camera size={14} strokeWidth={1.75} />
                  Снимок
                </Button>
                <button
                  type="button"
                  aria-label="Закрыть"
                  onClick={close}
                  className="flex size-8 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                >
                  <X size={16} strokeWidth={1.75} />
                </button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1">
              {/* Левая колонна — вертикальный таймлайн коммитов. */}
              <div className="flex w-[300px] shrink-0 flex-col border-r border-stroke-0 bg-bg-1">
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                  {logLoading && log.length === 0 ? (
                    <div className="flex flex-col gap-2 px-1 pt-2">
                      {Array.from({ length: 6 }).map((_, index) => (
                        <div key={index} className="flex items-center gap-3">
                          <span className="size-2.5 shrink-0 rounded-full bg-bg-3" />
                          <span
                            className="h-3 flex-1 rounded-xs bg-bg-3"
                            style={{ opacity: 1 - index * 0.14 }}
                          />
                        </div>
                      ))}
                    </div>
                  ) : emptyHistory ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                      <GitCommitVertical size={26} strokeWidth={1.5} className="text-text-3" />
                      <p className="text-caption text-text-2">
                        Сделайте первый снимок, чтобы начать историю версий.
                      </p>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void snapshot()}
                        disabled={busy || status?.isRepo !== true}
                      >
                        <Camera size={14} strokeWidth={1.75} />
                        Сделать снимок
                      </Button>
                    </div>
                  ) : (
                    <motion.ul
                      className="flex flex-col"
                      variants={reduced ? undefined : railVariants}
                      initial={reduced ? undefined : 'initial'}
                      animate={reduced ? undefined : 'animate'}
                    >
                      {log.map((commit, index) => {
                        const isSelected = commit.hash === selectedHash;
                        return (
                          <motion.li key={commit.hash} variants={reduced ? undefined : railItemVariants}>
                            <button
                              type="button"
                              onClick={() => void selectCommit(commit.hash)}
                              className={cx(
                                'group relative flex w-full items-start gap-3 rounded-s py-2 pl-1 pr-2 text-left transition-colors duration-[120ms]',
                                isSelected ? 'bg-bg-2' : 'hover:bg-bg-2/60',
                              )}
                            >
                              <span className="relative flex w-4 shrink-0 justify-center self-stretch">
                                <span
                                  aria-hidden
                                  className={cx(
                                    'absolute w-px bg-stroke-1',
                                    log.length === 1
                                      ? 'hidden'
                                      : index === 0
                                        ? 'bottom-0 top-[13px]'
                                        : index === log.length - 1
                                          ? 'top-0 h-[13px]'
                                          : 'inset-y-0',
                                  )}
                                />
                                <span
                                  aria-hidden
                                  className={cx(
                                    'relative mt-[7px] size-2.5 rounded-full ring-4 transition-colors duration-[120ms]',
                                    isSelected ? 'ring-bg-2' : 'ring-bg-1',
                                    isSelected
                                      ? 'bg-accent'
                                      : 'bg-bg-4 group-hover:bg-text-3',
                                  )}
                                />
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                                <span className="flex items-center gap-1.5">
                                  <span
                                    className={cx(
                                      'min-w-0 flex-1 truncate text-ui',
                                      isSelected ? 'text-text-0' : 'text-text-1',
                                    )}
                                  >
                                    {commit.subject}
                                  </span>
                                  {index === 0 ? (
                                    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-micro font-medium text-accent">
                                      HEAD
                                    </span>
                                  ) : null}
                                </span>
                                <span className="flex items-center gap-1.5 text-micro text-text-2">
                                  <Clock size={10} strokeWidth={2} className="shrink-0" />
                                  {formatRelative(commit.date)}
                                  <span aria-hidden className="text-text-3">·</span>
                                  <span className="font-mono">{commit.shortHash}</span>
                                  {commit.filesChanged > 0 ? (
                                    <>
                                      <span aria-hidden className="text-text-3">·</span>
                                      <span>{commit.filesChanged} файл.</span>
                                    </>
                                  ) : null}
                                </span>
                              </span>
                            </button>
                          </motion.li>
                        );
                      })}
                    </motion.ul>
                  )}
                </div>
              </div>

              {/* Правая колонна — детали выбранного коммита. */}
              <div className="flex min-w-0 flex-1 flex-col bg-bg-0">
                {selected === null ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-3">
                    <GitCommitVertical size={26} strokeWidth={1.5} />
                    <span className="text-caption text-text-2">Выберите снимок слева</span>
                  </div>
                ) : (
                  <>
                    <div className="flex shrink-0 flex-col gap-3 border-b border-stroke-0 px-5 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 flex-col gap-1">
                          <h3 className="truncate text-h3 text-text-0">{selected.subject}</h3>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-2">
                            <span className="flex items-center gap-1.5">
                              <User size={12} strokeWidth={1.75} />
                              {selected.author}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <Clock size={12} strokeWidth={1.75} />
                              {formatFull(selected.date)}
                            </span>
                            <span className="font-mono text-text-3">{selected.shortHash}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {confirmCommit ? (
                            <>
                              <span className="text-caption text-text-2">Восстановить?</span>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setConfirmCommit(false);
                                  void restoreCommit(selected.hash);
                                }}
                              >
                                Да
                              </Button>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmCommit(false)}>
                                Отмена
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmCommit(true)}
                            >
                              <RotateCcw size={14} strokeWidth={1.75} />
                              Восстановить эту версию
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-1">
                      {/* Список изменённых файлов. */}
                      <div className="flex w-56 shrink-0 flex-col border-r border-stroke-0">
                        <div className="flex h-9 shrink-0 items-center justify-between px-3 text-micro uppercase tracking-wide text-text-2">
                          <span>Файлы</span>
                          <span className="font-mono text-text-3">{files.length}</span>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                          {files.length === 0 ? (
                            <p className="px-2 py-2 text-caption text-text-3">
                              {diffLoading ? 'Загрузка…' : 'Файлы не изменялись'}
                            </p>
                          ) : (
                            files.map((file) => {
                              const isActive = file.path === selectedPath;
                              return (
                                <button
                                  key={`${file.status}-${file.path}`}
                                  type="button"
                                  onClick={() => void viewFile(file.path)}
                                  title={file.path}
                                  className={cx(
                                    'flex w-full items-center gap-2 rounded-s px-2 py-1.5 text-left transition-colors duration-[120ms]',
                                    isActive ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2',
                                  )}
                                >
                                  <FileBadge status={file.status} />
                                  <span className="min-w-0 flex-1 truncate text-caption">{shortName(file.path)}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>

                      {/* Просмотр diff. */}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke-0 px-3">
                          {selectedPath !== null ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void clearFileView()}
                                className="flex items-center gap-1 rounded-xs px-1 py-0.5 text-caption text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                              >
                                <ArrowLeft size={13} strokeWidth={1.75} />
                                Весь коммит
                              </button>
                              <span aria-hidden className="text-text-3">/</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-1">
                                {selectedPath}
                              </span>
                              {confirmFile === selectedPath ? (
                                <span className="flex shrink-0 items-center gap-1.5">
                                  <span className="text-caption text-text-2">Вернуть?</span>
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => {
                                      const path = selectedPath;
                                      setConfirmFile(null);
                                      void restoreFile(selected.hash, path);
                                    }}
                                  >
                                    Да
                                  </Button>
                                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmFile(null)}>
                                    Отмена
                                  </Button>
                                </span>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy || activeFile?.status === 'D'}
                                  onClick={() => setConfirmFile(selectedPath)}
                                >
                                  <Undo2 size={13} strokeWidth={1.75} />
                                  Вернуть файл
                                </Button>
                              )}
                            </>
                          ) : (
                            <span className="flex items-center gap-1.5 text-caption text-text-2">
                              <FileDiff size={13} strokeWidth={1.75} />
                              Изменения снимка
                            </span>
                          )}
                        </div>
                        <DiffView text={diffText} loading={diffLoading} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
