import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface KnownVault {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface VaultsStore {
  known: KnownVault[];
  activePath?: string;
  remember(path: string): void;
  forget(path: string): void;
}

/**
 * Канонический ключ пути для дедупликации: Windows не различает регистр и вид
 * разделителей, а диалог выбора папки и ядро могут вернуть один и тот же
 * каталог по-разному (слэши, регистр буквы диска, хвостовой разделитель).
 */
export function vaultKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Отображаемое имя хранилища — последний сегмент пути. */
export function vaultName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

function isKnownVault(value: unknown): value is KnownVault {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<KnownVault>;
  return (
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.lastOpenedAt === 'string'
  );
}

function dedupeByKey(vaults: KnownVault[]): KnownVault[] {
  const seen = new Set<string>();
  const unique: KnownVault[] = [];
  for (const vault of vaults) {
    const key = vaultKey(vault.path);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(vault);
    }
  }
  return unique;
}

/**
 * Persist-список известных хранилищ (Задача #3) и последний активный путь для
 * восстановления на старте (Задача #1). Канон идентичности — `info.root` из
 * ответа ядра, поэтому `remember` всегда вызывается с ним после успешного open.
 */
export const useVaultsStore = create<VaultsStore>()(
  persist(
    (set) => ({
      known: [],
      activePath: undefined,
      remember: (path) => {
        const key = vaultKey(path);
        set((s) => {
          const rest = s.known.filter((vault) => vaultKey(vault.path) !== key);
          const entry: KnownVault = {
            path,
            name: vaultName(path),
            lastOpenedAt: new Date().toISOString(),
          };
          return { known: [entry, ...rest], activePath: path };
        });
      },
      forget: (path) => {
        const key = vaultKey(path);
        set((s) => ({
          known: s.known.filter((vault) => vaultKey(vault.path) !== key),
          activePath:
            s.activePath !== undefined && vaultKey(s.activePath) === key ? undefined : s.activePath,
        }));
      },
    }),
    {
      name: 'graphite.vaults',
      partialize: (s) => ({ known: s.known, activePath: s.activePath }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Pick<VaultsStore, 'known' | 'activePath'>>;
        const known = Array.isArray(saved.known) ? dedupeByKey(saved.known.filter(isKnownVault)) : [];
        return {
          ...current,
          known,
          activePath:
            typeof saved.activePath === 'string' && saved.activePath.length > 0
              ? saved.activePath
              : undefined,
        };
      },
    },
  ),
);
