import { create } from 'zustand';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { isTauriAvailable } from '@graphite/bindings';
import { useUiStore } from './uiStore';

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'error';

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

export interface UpdateProgress {
  downloaded: number;
  total?: number;
}

export interface UpdaterStore {
  status: UpdaterStatus;
  available: UpdateInfo | null;
  progress: UpdateProgress | null;
  error?: string;
  dismissed: boolean;
  check(manual?: boolean): Promise<void>;
  install(): Promise<void>;
  relaunch(): Promise<void>;
  dismiss(): void;
}

// Объект Update держит хендл нативного ресурса и несериализуем — его нельзя класть
// в стор. Храним его в модульной переменной, а в сторе — только плоский снимок.
let pendingUpdate: Update | null = null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
  status: 'idle',
  available: null,
  progress: null,
  error: undefined,
  dismissed: false,

  check: async (manual = false) => {
    if (!isTauriAvailable()) {
      return;
    }
    const status = get().status;
    if (status === 'checking' || status === 'downloading') {
      return;
    }
    set({ status: 'checking', error: undefined, progress: null, dismissed: false });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update === null) {
        pendingUpdate = null;
        set({ status: 'uptodate', available: null });
        if (manual) {
          useUiStore.getState().pushToast({ kind: 'success', text: 'У вас актуальная версия' });
        }
        return;
      }
      pendingUpdate = update;
      const body = update.body?.trim();
      set({
        status: 'available',
        available: {
          version: update.version,
          notes: body !== undefined && body.length > 0 ? body : undefined,
          date: update.date,
        },
      });
    } catch (error) {
      pendingUpdate = null;
      set({ status: 'error', error: errorMessage(error, 'Не удалось проверить обновления') });
      if (manual) {
        useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось проверить обновления' });
      }
    }
  },

  install: async () => {
    if (!isTauriAvailable() || pendingUpdate === null || get().status === 'downloading') {
      return;
    }
    set({ status: 'downloading', progress: { downloaded: 0 }, error: undefined });
    let downloaded = 0;
    let total: number | undefined;
    try {
      await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength;
            set({ progress: { downloaded: 0, total } });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            set({ progress: { downloaded, total } });
            break;
          case 'Finished':
            set({ progress: { downloaded: total ?? downloaded, total } });
            break;
        }
      });
      set({ status: 'ready' });
    } catch (error) {
      set({ status: 'error', error: errorMessage(error, 'Не удалось загрузить обновление') });
      useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось загрузить обновление' });
    }
  },

  relaunch: async () => {
    if (!isTauriAvailable()) {
      return;
    }
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (error) {
      set({ status: 'error', error: errorMessage(error, 'Не удалось перезапустить приложение') });
      useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось перезапустить приложение' });
    }
  },

  dismiss: () => {
    set({ dismissed: true });
  },
}));
