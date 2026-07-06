import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { GitCommit, GitFileChange, GitStatus } from '@graphite/bindings';
import { useUiStore } from './uiStore';

/** Тихий авто-снимок срабатывает через это время после последней правки. */
const AUTO_SNAPSHOT_DEBOUNCE_MS = 90_000;
/** Сколько коммитов тянуть в таймлайн истории. */
const LOG_LIMIT = 100;
/** Метка тихого авто-снимка (реальное время коммита пишет git). */
const AUTO_SNAPSHOT_MESSAGE = 'Авто-снимок';
/** Канонический адрес облачной резервной копии Graphite. */
export const GRAPHITE_REMOTE_URL = 'https://github.com/Hjgyhfyh/graphite.git';

interface SnapshotOptions {
  /** Не показывать тосты (для фоновых авто-снимков). */
  quiet?: boolean;
}

interface PushOptions {
  /** Не показывать тост об успехе (для фоновой авто-заливки). */
  quiet?: boolean;
}

export interface GitStore {
  status: GitStatus | null;
  log: GitCommit[];
  selectedHash: string | null;
  selectedPath: string | null;
  filesOfSelected: GitFileChange[];
  diffText: string;
  timelineOpen: boolean;

  statusLoading: boolean;
  logLoading: boolean;
  diffLoading: boolean;
  busy: boolean;
  pushing: boolean;
  pulling: boolean;

  autoSnapshot: boolean;
  autoPush: boolean;
  error: string | null;

  refreshStatus(): Promise<void>;
  init(): Promise<void>;
  snapshot(message?: string, opts?: SnapshotOptions): Promise<void>;
  loadLog(): Promise<void>;
  selectCommit(hash: string): Promise<void>;
  viewFile(path: string): Promise<void>;
  clearFileView(): Promise<void>;
  restoreCommit(hash: string): Promise<void>;
  restoreFile(hash: string, path: string): Promise<void>;
  setRemote(url: string): Promise<void>;
  push(opts?: PushOptions): Promise<void>;
  pull(): Promise<void>;
  openTimeline(): void;
  closeTimeline(): void;
  setAutoSnapshot(on: boolean): void;
  setAutoPush(on: boolean): void;
  maybeAutoSnapshot(): void;
}

/** Дебаунс-таймер авто-снимков живёт вне стора — переживает ре-рендеры. */
let autoTimer: ReturnType<typeof setTimeout> | undefined;

function toast(kind: 'info' | 'success' | 'error', text: string): void {
  useUiStore.getState().pushToast({ kind, text });
}

function reason(error: unknown, fallback: string): string {
  return isGraphiteError(error) && error.message.length > 0 ? error.message : fallback;
}

/**
 * Переводит сырой вывод git о неудачной отправке в понятную подсказку. git шлёт
 * ошибки доступа и сети на английском независимо от локали ОС, поэтому ловим по
 * подстрокам; всё неизвестное показываем как есть.
 */
function explainGitError(raw: string): string {
  const text = raw.toLowerCase();
  const authMarkers = [
    'authentication failed',
    'could not read username',
    'could not read password',
    'terminal prompts disabled',
    'invalid username or password',
    'support for password authentication',
    'access denied',
    'permission denied',
    'fatal: authentication',
    'repository not found',
    '403',
    '401',
  ];
  if (authMarkers.some((marker) => text.includes(marker))) {
    return 'Не удалось войти в GitHub. Нужен доступ: Personal Access Token или Git Credential Manager. Настройте вход и повторите.';
  }
  const networkMarkers = [
    'could not resolve host',
    'unable to access',
    'failed to connect',
    'connection timed out',
    'network is unreachable',
  ];
  if (networkMarkers.some((marker) => text.includes(marker))) {
    return 'Нет связи с GitHub — проверьте интернет и адрес репозитория.';
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'Не удалось отправить на GitHub';
}

export const useGitStore = create<GitStore>()(
  persist(
    (set, get) => ({
      status: null,
      log: [],
      selectedHash: null,
      selectedPath: null,
      filesOfSelected: [],
      diffText: '',
      timelineOpen: false,

      statusLoading: false,
      logLoading: false,
      diffLoading: false,
      busy: false,
      pushing: false,
      pulling: false,

      autoSnapshot: false,
      autoPush: false,
      error: null,

      refreshStatus: async () => {
        if (!isTauriAvailable()) {
          set({ status: null });
          return;
        }
        set({ statusLoading: true });
        try {
          const status = await commands.gitStatus();
          set({ status, error: null });
        } catch (error) {
          // Прежний статус не сбрасываем: разовый сбой не должен гасить индикатор.
          set({ error: reason(error, 'Не удалось получить статус истории') });
        } finally {
          set({ statusLoading: false });
        }
      },

      init: async () => {
        if (!isTauriAvailable()) {
          return;
        }
        set({ busy: true, error: null });
        try {
          const status = await commands.gitInit();
          set({ status });
          toast('success', 'История версий включена');
        } catch (error) {
          toast('error', reason(error, 'Не удалось включить историю версий'));
        } finally {
          set({ busy: false });
        }
      },

      snapshot: async (message, opts) => {
        if (!isTauriAvailable()) {
          return;
        }
        const quiet = opts?.quiet ?? false;
        set({ busy: true, error: null });
        try {
          const result = await commands.gitSnapshot(message);
          if (result.ok) {
            if (!quiet) {
              toast('success', 'Снимок сохранён');
            }
            await get().refreshStatus();
            if (get().autoPush && get().status?.hasRemote === true) {
              void get().push({ quiet: true });
            }
            if (get().timelineOpen) {
              await get().loadLog();
            }
          } else if (!quiet) {
            toast('info', result.message);
          }
        } catch (error) {
          const text = reason(error, 'Не удалось сделать снимок');
          set({ error: text });
          if (!quiet) {
            toast('error', text);
          }
        } finally {
          set({ busy: false });
        }
      },

      loadLog: async () => {
        if (!isTauriAvailable()) {
          return;
        }
        set({ logLoading: true });
        try {
          const log = await commands.gitLog(LOG_LIMIT);
          set({ log });
          const selected = get().selectedHash;
          const stillThere = selected !== null && log.some((commit) => commit.hash === selected);
          if (!stillThere) {
            if (log.length > 0) {
              void get().selectCommit(log[0].hash);
            } else {
              set({ selectedHash: null, selectedPath: null, filesOfSelected: [], diffText: '' });
            }
          }
        } catch (error) {
          set({ log: [], error: reason(error, 'Не удалось загрузить историю') });
        } finally {
          set({ logLoading: false });
        }
      },

      selectCommit: async (hash) => {
        set({
          selectedHash: hash,
          selectedPath: null,
          filesOfSelected: [],
          diffText: '',
          diffLoading: true,
          error: null,
        });
        if (!isTauriAvailable()) {
          set({ diffLoading: false });
          return;
        }
        try {
          const [files, diff] = await Promise.all([
            commands.gitCommitFiles(hash),
            commands.gitDiff({ hash }),
          ]);
          // Гонка: пока грузили, могли выбрать другой коммит.
          if (get().selectedHash !== hash) {
            return;
          }
          set({ filesOfSelected: files, diffText: diff, diffLoading: false });
        } catch (error) {
          if (get().selectedHash !== hash) {
            return;
          }
          set({ diffLoading: false, error: reason(error, 'Не удалось загрузить изменения') });
        }
      },

      viewFile: async (path) => {
        const hash = get().selectedHash;
        if (hash === null) {
          return;
        }
        set({ selectedPath: path, diffLoading: true });
        if (!isTauriAvailable()) {
          set({ diffLoading: false });
          return;
        }
        try {
          const diff = await commands.gitDiff({ hash, path });
          if (get().selectedHash !== hash || get().selectedPath !== path) {
            return;
          }
          set({ diffText: diff, diffLoading: false });
        } catch (error) {
          if (get().selectedHash !== hash || get().selectedPath !== path) {
            return;
          }
          set({ diffLoading: false, error: reason(error, 'Не удалось загрузить изменения файла') });
        }
      },

      clearFileView: async () => {
        const hash = get().selectedHash;
        if (hash === null) {
          return;
        }
        set({ selectedPath: null, diffLoading: true });
        if (!isTauriAvailable()) {
          set({ diffLoading: false });
          return;
        }
        try {
          const diff = await commands.gitDiff({ hash });
          if (get().selectedHash === hash && get().selectedPath === null) {
            set({ diffText: diff, diffLoading: false });
          }
        } catch {
          set({ diffLoading: false });
        }
      },

      restoreCommit: async (hash) => {
        if (!isTauriAvailable()) {
          return;
        }
        set({ busy: true, error: null });
        try {
          const result = await commands.gitRestoreCommit(hash);
          toast(result.ok ? 'success' : 'info', result.ok ? 'Версия восстановлена' : result.message);
          await get().refreshStatus();
          await get().loadLog();
        } catch (error) {
          toast('error', reason(error, 'Не удалось восстановить версию'));
        } finally {
          set({ busy: false });
        }
      },

      restoreFile: async (hash, path) => {
        if (!isTauriAvailable()) {
          return;
        }
        set({ busy: true, error: null });
        try {
          const result = await commands.gitRestoreFile({ hash, path });
          toast(result.ok ? 'success' : 'info', result.ok ? 'Файл восстановлен' : result.message);
          await get().refreshStatus();
          await get().loadLog();
        } catch (error) {
          toast('error', reason(error, 'Не удалось восстановить файл'));
        } finally {
          set({ busy: false });
        }
      },

      setRemote: async (url) => {
        if (!isTauriAvailable()) {
          return;
        }
        set({ busy: true, error: null });
        try {
          const status = await commands.gitRemoteSet(url);
          set({ status });
          toast('success', url.trim().length > 0 ? 'Удалённый репозиторий сохранён' : 'Удалённый репозиторий отключён');
        } catch (error) {
          toast('error', reason(error, 'Не удалось сохранить репозиторий'));
        } finally {
          set({ busy: false });
        }
      },

      push: async (opts) => {
        if (!isTauriAvailable()) {
          return;
        }
        const quiet = opts?.quiet ?? false;
        const status = get().status;
        if (status !== null && !status.hasRemote) {
          if (!quiet) {
            toast('info', 'Сначала укажите удалённый репозиторий');
          }
          return;
        }
        set({ pushing: true, error: null });
        try {
          const result = await commands.gitPush();
          if (result.ok) {
            if (!quiet) {
              toast('success', 'Резервная копия отправлена');
            }
          } else {
            const text = explainGitError(result.message);
            set({ error: text });
            toast('error', text);
          }
          await get().refreshStatus();
        } catch (error) {
          const text = explainGitError(reason(error, 'Не удалось отправить на GitHub'));
          set({ error: text });
          toast('error', text);
        } finally {
          set({ pushing: false });
        }
      },

      pull: async () => {
        if (!isTauriAvailable()) {
          return;
        }
        const status = get().status;
        if (status !== null && !status.hasRemote) {
          toast('info', 'Сначала укажите удалённый репозиторий');
          return;
        }
        set({ pulling: true, error: null });
        try {
          const result = await commands.gitPull();
          toast(result.ok ? 'success' : 'error', result.ok ? 'Изменения получены' : result.message || 'Не удалось забрать');
          await get().refreshStatus();
          if (get().timelineOpen) {
            await get().loadLog();
          }
        } catch (error) {
          toast('error', reason(error, 'Не удалось забрать с GitHub'));
        } finally {
          set({ pulling: false });
        }
      },

      openTimeline: () => {
        set({ timelineOpen: true, error: null });
        void get().refreshStatus();
        void get().loadLog();
      },

      closeTimeline: () => {
        set({ timelineOpen: false });
      },

      setAutoSnapshot: (on) => {
        set({ autoSnapshot: on });
        if (!on && autoTimer !== undefined) {
          clearTimeout(autoTimer);
          autoTimer = undefined;
        }
      },

      setAutoPush: (on) => {
        set({ autoPush: on });
      },

      maybeAutoSnapshot: () => {
        if (!isTauriAvailable()) {
          return;
        }
        const state = get();
        if (!state.autoSnapshot || state.status === null || !state.status.isRepo) {
          return;
        }
        if (autoTimer !== undefined) {
          clearTimeout(autoTimer);
        }
        autoTimer = setTimeout(() => {
          autoTimer = undefined;
          void useGitStore.getState().snapshot(AUTO_SNAPSHOT_MESSAGE, { quiet: true });
        }, AUTO_SNAPSHOT_DEBOUNCE_MS);
      },
    }),
    {
      name: 'graphite.git',
      partialize: (state) => ({ autoSnapshot: state.autoSnapshot, autoPush: state.autoPush }),
    },
  ),
);
