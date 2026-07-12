import { invoke } from '@tauri-apps/api/core';
import { isGraphiteError, isTauriAvailable } from '@graphite/bindings';

// Тонкие обёртки над собственными Rust-командами файлового менеджера. Зовём
// через сырой `invoke` с ручными типами (camelCase под serde) — не завязываемся
// на регенерацию @graphite/bindings, которую локально не собрать. Имя команды —
// snake_case, ключи аргументов — camelCase (маппинг Tauri: showHidden→show_hidden).

export interface FsEntry {
  name: string;
  /** Абсолютный путь на диске. */
  path: string;
  isDir: boolean;
  /** Размер файла в байтах; у папок — null. */
  size: number | null;
  /** Время изменения, epoch-миллисекунды UTC. */
  modifiedMs: number | null;
  /** Расширение в нижнем регистре без точки; у папок — null. */
  ext: string | null;
  hidden: boolean;
}

export interface FsDirListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface FsTextFile {
  content: string;
  truncated: boolean;
  isBinary: boolean;
}

export interface FsBinaryFile {
  base64: string;
  mime: string;
  truncated: boolean;
}

export type FsRootKind = 'drive' | 'home' | 'folder';

export interface FsRoot {
  name: string;
  path: string;
  kind: FsRootKind;
}

/** Кап чтения текста на просмотр (совпадает по смыслу с жёстким капом бэка). */
export const FS_TEXT_MAX = 2 * 1024 * 1024;
/** Кап картинки для base64-предпросмотра; крупнее — «открыть в системе». */
export const FS_IMAGE_MAX = 15 * 1024 * 1024;

/** Человекочитаемое сообщение из ошибки команды (GraphiteError или что угодно). */
export function fsErrorMessage(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}

/** Доступна ли файловая часть (только в Tauri-рантайме, не в браузерном dev). */
export function fsAvailable(): boolean {
  return isTauriAvailable();
}

export function listDir(path: string, showHidden: boolean): Promise<FsDirListing> {
  return invoke<FsDirListing>('fs_list_dir', { path, showHidden });
}

export function readText(path: string, maxBytes: number = FS_TEXT_MAX): Promise<FsTextFile> {
  return invoke<FsTextFile>('fs_read_text', { path, maxBytes });
}

export function readBase64(path: string, maxBytes: number = FS_IMAGE_MAX): Promise<FsBinaryFile> {
  return invoke<FsBinaryFile>('fs_read_base64', { path, maxBytes });
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>('fs_reveal_path', { path });
}

export function openPath(path: string): Promise<void> {
  return invoke<void>('fs_open_path', { path });
}

export function openTerminal(path: string): Promise<void> {
  return invoke<void>('fs_open_terminal', { path });
}

export function fsRoots(): Promise<FsRoot[]> {
  return invoke<FsRoot[]>('fs_roots');
}
