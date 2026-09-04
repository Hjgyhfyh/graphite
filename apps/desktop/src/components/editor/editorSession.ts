import { commands } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';

export const WELCOME_NOTE_REF: NoteRef = 'path:Добро пожаловать.md';

const pendingSaves = new Map<NoteRef, Promise<void>>();
const liveEditorFlushes = new Set<() => void>();

/** Регистрирует запись заметки, чтобы смена vault могла дождаться её завершения. */
export function trackPendingSave(ref: NoteRef, save: Promise<void>): void {
  pendingSaves.set(ref, save);
  void save.finally(() => {
    if (pendingSaves.get(ref) === save) {
      pendingSaves.delete(ref);
    }
  });
}

/** Текущая запись заметки; чтение с диска должно начаться после неё. */
export function pendingSaveFor(ref: NoteRef): Promise<void> | undefined {
  return pendingSaves.get(ref);
}

/** Подключает живой редактор к общему flush перед сменой хранилища. */
export function registerEditorFlush(flush: () => void): () => void {
  liveEditorFlushes.add(flush);
  return () => liveEditorFlushes.delete(flush);
}

/**
 * Форсирует автосейв всех открытых «грязных» редакторов и дожидается уже
 * начатых записей. Это не даёт отложенной записи попасть в новый vault.
 */
export async function flushPendingSaves(): Promise<void> {
  for (const flush of [...liveEditorFlushes]) {
    flush();
  }
  await Promise.allSettled([...pendingSaves.values()]);
}

let vaultRootPromise: Promise<string | undefined> | null = null;

/** Корень активного vault для преобразования относительных путей вложений. */
export function vaultRootPath(): Promise<string | undefined> {
  vaultRootPromise ??= commands
    .vaultInfo()
    .then((info) => info.root)
    .catch(() => {
      vaultRootPromise = null;
      return undefined;
    });
  return vaultRootPromise;
}

/** Сбрасывает кэш после смены хранилища. */
export function invalidateVaultRootCache(): void {
  vaultRootPromise = null;
}
