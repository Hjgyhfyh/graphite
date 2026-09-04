import { invoke } from '@tauri-apps/api/core';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteRef, VaultInfoResponse } from '@graphite/bindings';
import {
  WELCOME_NOTE_REF,
  flushPendingSaves,
  invalidateVaultRootCache,
} from '../components/editor/editorSession';
import { usePanesStore } from './panesStore';
import { useTabsStore } from './tabsStore';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';
import { useVaultsStore, vaultKey, vaultName } from './vaultsStore';

function reason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

/** Совпадает ли путь с уже смонтированным хранилищем (по каноническому ключу). */
export function isActiveVaultPath(path: string): boolean {
  const root = useVaultStore.getState().info?.root;
  return root !== undefined && vaultKey(root) === vaultKey(path);
}

/**
 * Смена хранилища внутри сессии. Сначала дожидаемся записи «грязных» буферов
 * старого vault — отложенный автосейв резолвит ref через текущий корень и после
 * переключения записал бы заметку уже в новую папку. Затем монтируем новый
 * корень, сбрасываем сессионный стейт (вкладки, панели, дерево) и показываем
 * стартовую заметку, чтобы центр не оставался пустым.
 */
async function mountVault(path: string, create: boolean): Promise<VaultInfoResponse> {
  await flushPendingSaves();
  const info = create ? await commands.vaultCreate(path) : await commands.vaultOpen(path);
  invalidateVaultRootCache();
  useVaultsStore.getState().remember(info.root);
  useTabsStore.getState().reset();
  usePanesStore.getState().reset();
  useVaultStore.setState({
    info,
    tree: [],
    childrenByRef: {},
    currentRef: undefined,
    pinnedNotes: new Set<NoteRef>(),
    iconByRef: {},
  });
  await useVaultStore.getState().loadTree();
  useVaultStore.getState().openNote(WELCOME_NOTE_REF);
  return info;
}

async function mountWithToast(path: string, create: boolean): Promise<boolean> {
  try {
    const info = await mountVault(path, create);
    useUiStore.getState().pushToast({
      kind: 'success',
      text: `Хранилище «${vaultName(info.root)}» подключено`,
    });
    return true;
  } catch (error) {
    useUiStore.getState().pushToast({
      kind: 'error',
      text: reason(error, 'Не удалось открыть хранилище'),
    });
    return false;
  }
}

/** Переключение на известное хранилище; на уже активном — тихий no-op. */
export async function switchVault(path: string): Promise<boolean> {
  if (isActiveVaultPath(path)) {
    return true;
  }
  return mountWithToast(path, false);
}

/** Системный диалог выбора папки, затем открытие или создание хранилища. */
export async function pickVaultFolder(create: boolean): Promise<boolean> {
  let selected: unknown;
  try {
    selected = await invoke<string | null>('plugin:dialog|open', {
      options: {
        directory: true,
        multiple: false,
        title: create ? 'Где создать хранилище' : 'Папка с заметками',
      },
    });
  } catch (error) {
    useUiStore.getState().pushToast({
      kind: 'error',
      text: reason(error, 'Не удалось открыть хранилище'),
    });
    return false;
  }
  if (typeof selected !== 'string') {
    return false;
  }
  if (!create && isActiveVaultPath(selected)) {
    return true;
  }
  return mountWithToast(selected, create);
}

/** Убирает хранилище из списка известных; файлы на диске не трогаются. */
export function forgetVault(path: string): void {
  useVaultsStore.getState().forget(path);
}

let bootstrapped = false;

/**
 * Восстановление хранилища на старте приложения. Ядро само монтирует последний
 * vault по файлу-указателю (last-vault.json) ещё до загрузки webview — здесь
 * сверяем результат со списком известных. Если указатель потерян, поднимаем
 * vault из persist-списка (активный — первым); не вышло — остаётся экран
 * выбора. Guard защищает от двойного прогона mount-эффекта в StrictMode.
 */
export async function bootstrapVault(): Promise<void> {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;
  useVaultStore.getState().openNote(WELCOME_NOTE_REF);
  await useVaultStore.getState().loadInfo();
  const mounted = useVaultStore.getState().info;
  if (mounted !== undefined) {
    useVaultsStore.getState().remember(mounted.root);
    await useVaultStore.getState().loadTree();
    return;
  }
  if (!isTauriAvailable()) {
    return;
  }
  for (const candidate of [...useVaultsStore.getState().known]) {
    try {
      await useVaultStore.getState().openVault(candidate.path);
      return;
    } catch {
      // папка могла исчезнуть или переехать — пробуем следующее известное хранилище
    }
  }
}
