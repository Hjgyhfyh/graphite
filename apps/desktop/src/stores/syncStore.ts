import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { listen } from '@tauri-apps/api/event';
import { GRAPHITE_EVENT, commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteChangedEvent, SyncStatusDto, SyncStatusEvent } from '@graphite/bindings';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';
import { vaultKey } from './vaultsStore';

/** Тихий фоновый пуш срабатывает через это время после последней правки. */
const NUDGE_DEBOUNCE_MS = 4000;

/** Алфавит Крокфорда кода доступа (без визуально спорных I L O U) — зеркало sync-core. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY_LEN = 20;
const CODE_GROUP = 5;
const CODE_PREFIX = 'GRPH';

export const SYNC_CODE_PLACEHOLDER = 'GRPH-XXXXX-XXXXX-XXXXX-XXXXX';

function formatSyncCode(body: string): string {
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += CODE_GROUP) {
    groups.push(body.slice(i, i + CODE_GROUP));
  }
  return [CODE_PREFIX, ...groups].join('-');
}

/**
 * Приводит ввод пользователя к каноничному коду `GRPH-…` — зеркало
 * `sync_core::code::normalize`: верхний регистр, без дефисов/пробелов,
 * омоглифы I/L→1, O→0, U→V, опциональный префикс GRPH отбрасывается.
 * `undefined` — если после чистки не получилось 20 символов алфавита.
 */
export function normalizeSyncCode(input: string): string | undefined {
  let body = '';
  for (const ch of input) {
    if (ch === '-' || /\s/.test(ch)) {
      continue;
    }
    const up = ch.toUpperCase();
    body += up === 'I' || up === 'L' ? '1' : up === 'O' ? '0' : up === 'U' ? 'V' : up;
  }
  if (body.length === CODE_BODY_LEN + CODE_PREFIX.length && body.startsWith(CODE_PREFIX)) {
    body = body.slice(CODE_PREFIX.length);
  }
  if (body.length !== CODE_BODY_LEN) {
    return undefined;
  }
  for (const ch of body) {
    if (!CODE_ALPHABET.includes(ch)) {
      return undefined;
    }
  }
  return formatSyncCode(body);
}

/** Понятный текст ошибки синхронизации из сырого сообщения бэкенда. */
export function humanSyncError(raw: string | undefined): string {
  const text = raw?.trim() ?? '';
  if (text.length === 0) {
    return 'Ошибка синхронизации';
  }
  if (text.startsWith('сеть:')) {
    return 'Нет связи с сервером синхронизации — проверьте интернет';
  }
  return text;
}

/**
 * Является ли путь sync-хранилищем: активная реплика — по статусу ядра,
 * остальные — по кодам, сохранённым на этом устройстве при создании/подключении.
 */
export function isSyncPath(codes: Record<string, string>, status: SyncStatusDto, path: string): boolean {
  const key = vaultKey(path);
  if (status.active && status.root !== undefined && vaultKey(status.root) === key) {
    return true;
  }
  return codes[key] !== undefined;
}

const INACTIVE_STATUS: SyncStatusDto = { state: 'idle', active: false };

export interface SyncStore {
  status: SyncStatusDto;
  /** Запрос sync_now уже в полёте (ручной или фоновый). */
  busy: boolean;
  /** Коды доступа по каноническому ключу пути реплики (persist на устройстве). */
  codes: Record<string, string>;
  refresh(): Promise<void>;
  syncNow(opts?: { quiet?: boolean }): Promise<void>;
  detach(): Promise<boolean>;
  rememberCode(path: string, code: string): void;
  forgetCode(path: string): void;
  applyEvent(e: SyncStatusEvent): void;
  nudge(): void;
}

/** Дебаунс-таймер фонового пуша живёт вне стора — переживает ре-рендеры. */
let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

function toast(kind: 'info' | 'success' | 'error', text: string): void {
  useUiStore.getState().pushToast({ kind, text });
}

function reason(error: unknown, fallback: string): string {
  return isGraphiteError(error) && error.message.length > 0 ? error.message : fallback;
}

function isCodeMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((code) => typeof code === 'string' && code.length > 0)
  );
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set, get) => ({
      status: INACTIVE_STATUS,
      busy: false,
      codes: {},

      refresh: async () => {
        if (!isTauriAvailable()) {
          return;
        }
        try {
          const status = await commands.syncStatus();
          set({ status });
        } catch {
          // ядро ещё не подключено — считаем синхронизацию неактивной
          set({ status: INACTIVE_STATUS });
        }
      },

      syncNow: async (opts) => {
        const quiet = opts?.quiet ?? false;
        // «syncing» — цикл уже гонит фоновый супервизор; второй параллельно не нужен.
        if (!isTauriAvailable() || get().busy || !get().status.active || get().status.state === 'syncing') {
          return;
        }
        set({ busy: true });
        try {
          const status = await commands.syncNow();
          set({ status });
          if (!quiet) {
            if (status.state === 'error') {
              toast('error', humanSyncError(status.lastError));
            } else {
              toast('success', 'Синхронизировано');
            }
          }
        } catch (error) {
          if (!quiet) {
            toast('error', reason(error, 'Не удалось синхронизировать'));
          }
        } finally {
          set({ busy: false });
        }
      },

      detach: async () => {
        if (!isTauriAvailable() || get().busy) {
          return false;
        }
        const root = get().status.root;
        set({ busy: true });
        try {
          await commands.syncDetach();
          if (root !== undefined) {
            get().forgetCode(root);
          }
          set({ status: INACTIVE_STATUS });
          toast('success', 'Синхронизация отключена — файлы остались на диске');
          return true;
        } catch (error) {
          toast('error', reason(error, 'Не удалось отключить синхронизацию'));
          return false;
        } finally {
          set({ busy: false });
        }
      },

      rememberCode: (path, code) => {
        set((s) => ({ codes: { ...s.codes, [vaultKey(path)]: code } }));
      },

      forgetCode: (path) => {
        set((s) => {
          const codes = { ...s.codes };
          delete codes[vaultKey(path)];
          return { codes };
        });
      },

      applyEvent: (e) => {
        set((s) => ({
          status: {
            state: e.state,
            // Бэкенд шлёт «syncing» без метки времени — прошлую не теряем.
            lastSyncAt: e.lastSyncAt ?? (e.active ? s.status.lastSyncAt : undefined),
            lastError: e.lastError,
            active: e.active,
            root: e.active ? (s.status.root ?? useVaultStore.getState().info?.root) : undefined,
          },
        }));
      },

      nudge: () => {
        if (!isTauriAvailable() || !get().status.active) {
          return;
        }
        if (nudgeTimer !== undefined) {
          clearTimeout(nudgeTimer);
        }
        nudgeTimer = setTimeout(() => {
          nudgeTimer = undefined;
          const s = useSyncStore.getState();
          if (s.status.active && s.status.state !== 'syncing' && !s.busy) {
            void s.syncNow({ quiet: true });
          }
        }, NUDGE_DEBOUNCE_MS);
      },
    }),
    {
      name: 'graphite.sync',
      partialize: (s) => ({ codes: s.codes }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Pick<SyncStore, 'codes'>>;
        return { ...current, codes: isCodeMap(saved.codes) ? saved.codes : {} };
      },
    },
  ),
);

/**
 * Подписки sync-модуля: статус от ядра, дебаунс фонового пуша после правок и
 * перечитывание статуса при смене хранилища. Вызывается один раз из AppShell;
 * возвращает cleanup (безопасно для StrictMode).
 */
export function initSyncStore(): () => void {
  if (!isTauriAvailable()) {
    return () => {};
  }
  void useSyncStore.getState().refresh();
  const statusSub = listen<SyncStatusEvent>(GRAPHITE_EVENT.syncStatus, (event) => {
    useSyncStore.getState().applyEvent(event.payload);
  });
  const changesSub = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
    // Правки, пришедшие pull-ом (external), пуш не поднимают — иначе цикл.
    if (event.payload.actor !== 'external') {
      useSyncStore.getState().nudge();
    }
  });
  let prevRoot = useVaultStore.getState().info?.root;
  const unsubscribeVault = useVaultStore.subscribe((s) => {
    const root = s.info?.root;
    if (root !== prevRoot) {
      prevRoot = root;
      void useSyncStore.getState().refresh();
    }
  });
  return () => {
    void statusSub.then((unlisten) => unlisten());
    void changesSub.then((unlisten) => unlisten());
    unsubscribeVault();
    if (nudgeTimer !== undefined) {
      clearTimeout(nudgeTimer);
      nudgeTimer = undefined;
    }
  };
}
