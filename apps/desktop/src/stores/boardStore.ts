import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NoteRef, Status } from '@graphite/bindings';

export const DEFAULT_ORDER: readonly Status[] = ['inbox', 'shaping', 'planned', 'active', 'done', 'iced'];

export const COLUMN_LABEL_MAX = 40;
export const CARD_ALIAS_MAX = 120;

export interface ColumnConfig {
  label?: string;
  icon?: string;
  iconColor?: string;
  hidden?: boolean;
}

export interface BoardConfig {
  order: Status[];
  columns: Partial<Record<Status, ColumnConfig>>;
  cardAliases: Record<NoteRef, string>;
}

export interface BoardStore {
  byVault: Record<string, BoardConfig>;
  renameColumn(vk: string, status: Status, label: string): void;
  setColumnIcon(vk: string, status: Status, icon?: string, color?: string): void;
  toggleColumnHidden(vk: string, status: Status): void;
  reorderColumns(vk: string, order: Status[]): void;
  resetBoard(vk: string): void;
  setCardAlias(vk: string, ref: NoteRef, alias: string): void;
}

function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (DEFAULT_ORDER as readonly string[]).includes(value);
}

// Чинит сохранённый порядок колонок: неизвестные статусы отбрасываются, дубли
// схлопываются, недостающие дописываются в конец в дефолтном порядке — битый
// persist не должен ронять доску.
export function normalizeOrder(order: unknown): Status[] {
  const result: Status[] = [];
  if (Array.isArray(order)) {
    for (const status of order) {
      if (isStatus(status) && !result.includes(status)) {
        result.push(status);
      }
    }
  }
  for (const status of DEFAULT_ORDER) {
    if (!result.includes(status)) {
      result.push(status);
    }
  }
  return result;
}

/** Вписывает новый порядок видимых колонок в полный, сохраняя позиции скрытых. */
export function mergeVisibleOrder(full: readonly Status[], visible: readonly Status[]): Status[] {
  const visibleSet = new Set(visible);
  const queue = visible.filter((status) => isStatus(status));
  const merged = normalizeOrder([...full]).map((status) =>
    visibleSet.has(status) ? queue.shift() ?? status : status,
  );
  return normalizeOrder(merged);
}

function sanitizeColumn(raw: unknown): ColumnConfig | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const source = raw as Partial<ColumnConfig>;
  const column: ColumnConfig = {};
  if (typeof source.label === 'string' && source.label.trim().length > 0) {
    column.label = source.label.trim().slice(0, COLUMN_LABEL_MAX);
  }
  if (typeof source.icon === 'string' && source.icon.length > 0) {
    column.icon = source.icon;
  }
  if (typeof source.iconColor === 'string' && source.iconColor.length > 0) {
    column.iconColor = source.iconColor;
  }
  if (source.hidden === true) {
    column.hidden = true;
  }
  return Object.keys(column).length > 0 ? column : undefined;
}

export function normalizeBoardConfig(raw: unknown): BoardConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BoardConfig>;
  const columns: Partial<Record<Status, ColumnConfig>> = {};
  if (typeof source.columns === 'object' && source.columns !== null) {
    for (const [status, value] of Object.entries(source.columns)) {
      if (!isStatus(status)) {
        continue;
      }
      const column = sanitizeColumn(value);
      if (column !== undefined) {
        columns[status] = column;
      }
    }
  }
  const cardAliases: Record<NoteRef, string> = {};
  if (typeof source.cardAliases === 'object' && source.cardAliases !== null) {
    for (const [ref, alias] of Object.entries(source.cardAliases)) {
      if (typeof alias === 'string' && alias.trim().length > 0) {
        cardAliases[ref] = alias.trim().slice(0, CARD_ALIAS_MAX);
      }
    }
  }
  return { order: normalizeOrder(source.order), columns, cardAliases };
}

export function defaultBoardConfig(): BoardConfig {
  return { order: [...DEFAULT_ORDER], columns: {}, cardAliases: {} };
}

export function isDefaultBoardConfig(config: BoardConfig): boolean {
  return (
    config.order.length === DEFAULT_ORDER.length &&
    config.order.every((status, index) => status === DEFAULT_ORDER[index]) &&
    Object.keys(config.columns).length === 0 &&
    Object.keys(config.cardAliases).length === 0
  );
}

/**
 * Настройки канбан-доски: подписи/иконки/цвета/порядок/скрытие колонок и
 * подписи карточек. Скоуп — по хранилищу (ключ vaultKey из vaultsStore),
 * статусы ядра при этом не меняются — конфиг чисто презентационный.
 */
export const useBoardStore = create<BoardStore>()(
  persist(
    (set) => {
      const update = (vk: string, mutate: (config: BoardConfig) => BoardConfig) => {
        if (vk.length === 0) {
          return;
        }
        set((s) => {
          const next = mutate(s.byVault[vk] ?? defaultBoardConfig());
          const byVault = { ...s.byVault };
          // Конфиг без отличий от дефолта не храним — persist не разрастается.
          if (isDefaultBoardConfig(next)) {
            delete byVault[vk];
          } else {
            byVault[vk] = next;
          }
          return { byVault };
        });
      };

      const patchColumn = (vk: string, status: Status, patch: (column: ColumnConfig) => ColumnConfig) => {
        update(vk, (config) => {
          const next = patch({ ...(config.columns[status] ?? {}) });
          const columns = { ...config.columns };
          if (Object.keys(next).length === 0) {
            delete columns[status];
          } else {
            columns[status] = next;
          }
          return { ...config, columns };
        });
      };

      return {
        byVault: {},
        renameColumn: (vk, status, label) => {
          const trimmed = label.trim().slice(0, COLUMN_LABEL_MAX);
          patchColumn(vk, status, (column) => {
            if (trimmed.length === 0) {
              delete column.label;
            } else {
              column.label = trimmed;
            }
            return column;
          });
        },
        // Семантика зеркалит IconPicker.onPick: undefined — не менять, '' — снять, значение — установить.
        setColumnIcon: (vk, status, icon, color) => {
          patchColumn(vk, status, (column) => {
            if (icon !== undefined) {
              if (icon.length === 0) {
                delete column.icon;
              } else {
                column.icon = icon;
              }
            }
            if (color !== undefined) {
              if (color.length === 0) {
                delete column.iconColor;
              } else {
                column.iconColor = color;
              }
            }
            return column;
          });
        },
        toggleColumnHidden: (vk, status) => {
          patchColumn(vk, status, (column) => {
            if (column.hidden === true) {
              delete column.hidden;
            } else {
              column.hidden = true;
            }
            return column;
          });
        },
        reorderColumns: (vk, order) => {
          update(vk, (config) => ({ ...config, order: normalizeOrder(order) }));
        },
        resetBoard: (vk) => {
          update(vk, () => defaultBoardConfig());
        },
        setCardAlias: (vk, ref, alias) => {
          const trimmed = alias.trim().slice(0, CARD_ALIAS_MAX);
          update(vk, (config) => {
            const cardAliases = { ...config.cardAliases };
            if (trimmed.length === 0) {
              delete cardAliases[ref];
            } else {
              cardAliases[ref] = trimmed;
            }
            return { ...config, cardAliases };
          });
        },
      };
    },
    {
      name: 'graphite.board',
      partialize: (s) => ({ byVault: s.byVault }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as { byVault?: unknown };
        const byVault: Record<string, BoardConfig> = {};
        if (typeof saved.byVault === 'object' && saved.byVault !== null) {
          for (const [vk, raw] of Object.entries(saved.byVault)) {
            const config = normalizeBoardConfig(raw);
            if (!isDefaultBoardConfig(config)) {
              byVault[vk] = config;
            }
          }
        }
        return { ...current, byVault };
      },
    },
  ),
);

const DEFAULT_CONFIG: BoardConfig = defaultBoardConfig();

/** Конфиг доски для хранилища; до загрузки info (пустой ключ) — дефолт. */
export function useBoardConfig(vk: string): BoardConfig {
  const stored = useBoardStore((s) => (vk.length > 0 ? s.byVault[vk] : undefined));
  return stored ?? DEFAULT_CONFIG;
}
