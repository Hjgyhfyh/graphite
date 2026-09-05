import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ActionId =
  | 'palette.open'
  | 'switcher.open'
  | 'search.global'
  | 'search.inNote'
  | 'view.tasks'
  | 'view.brief'
  | 'settings.open'
  | 'nav.back'
  | 'nav.forward'
  | 'note.new'
  | 'note.newChild'
  | 'note.newFromTemplate'
  | 'note.rename'
  | 'note.delete'
  | 'note.copyPage'
  | 'note.pin'
  | 'note.exportHtml'
  | 'note.exportMd'
  | 'note.print'
  | 'editor.toggleReading'
  | 'editor.focusMode'
  | 'editor.linkNote'
  | 'format.bold'
  | 'format.italic'
  | 'task.toggleLine'
  | 'task.sweepDone'
  | 'edit.undo'
  | 'edit.redo'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.close'
  | 'tab.togglePin'
  | 'pane.split'
  | 'pane.close'
  | 'sidebar.toggleTree'
  | 'sidebar.toggleRight'
  | 'aiFeed.toggle'
  | 'view.outline'
  | 'capture.quick'
  | 'prompts.history';

export type ActionGroup = 'Навигация' | 'Заметки' | 'Редактор' | 'Вкладки и панели' | 'Прочее';

export interface ActionDef {
  id: ActionId;
  title: string;
  group: ActionGroup;
}

export const ACTIONS: readonly ActionDef[] = [
  { id: 'palette.open', title: 'Командная палитра', group: 'Навигация' },
  { id: 'switcher.open', title: 'Быстрый переход', group: 'Навигация' },
  { id: 'search.global', title: 'Глобальный поиск', group: 'Навигация' },
  { id: 'search.inNote', title: 'Поиск в заметке', group: 'Навигация' },
  { id: 'view.tasks', title: 'Задачи', group: 'Навигация' },
  { id: 'view.brief', title: 'Бриф для Claude (идея → задание)', group: 'Навигация' },
  { id: 'settings.open', title: 'Настройки', group: 'Навигация' },
  { id: 'nav.back', title: 'Назад', group: 'Навигация' },
  { id: 'nav.forward', title: 'Вперёд', group: 'Навигация' },
  { id: 'note.new', title: 'Новая заметка', group: 'Заметки' },
  { id: 'note.newChild', title: 'Под-заметка', group: 'Заметки' },
  { id: 'note.newFromTemplate', title: 'Заметка из шаблона…', group: 'Заметки' },
  { id: 'note.rename', title: 'Переименовать', group: 'Заметки' },
  { id: 'note.delete', title: 'Удалить в корзину', group: 'Заметки' },
  { id: 'note.copyPage', title: 'Скопировать для ИИ', group: 'Заметки' },
  { id: 'note.pin', title: 'Закрепить заметку', group: 'Заметки' },
  { id: 'note.exportHtml', title: 'Экспорт в HTML…', group: 'Заметки' },
  { id: 'note.exportMd', title: 'Сохранить копию .md…', group: 'Заметки' },
  { id: 'note.print', title: 'Печать / PDF…', group: 'Заметки' },
  { id: 'editor.toggleReading', title: 'Режим чтения', group: 'Редактор' },
  { id: 'editor.focusMode', title: 'Режим фокуса', group: 'Редактор' },
  { id: 'editor.linkNote', title: 'Связать заметку', group: 'Редактор' },
  { id: 'format.bold', title: 'Жирный', group: 'Редактор' },
  { id: 'format.italic', title: 'Курсив', group: 'Редактор' },
  { id: 'task.toggleLine', title: 'Строка в чекбокс', group: 'Редактор' },
  { id: 'task.sweepDone', title: 'Убрать сделанное в «Готово»', group: 'Редактор' },
  { id: 'edit.undo', title: 'Отменить', group: 'Редактор' },
  { id: 'edit.redo', title: 'Повторить', group: 'Редактор' },
  { id: 'tab.next', title: 'Следующая вкладка', group: 'Вкладки и панели' },
  { id: 'tab.prev', title: 'Предыдущая вкладка', group: 'Вкладки и панели' },
  { id: 'tab.close', title: 'Закрыть вкладку', group: 'Вкладки и панели' },
  { id: 'tab.togglePin', title: 'Закрепить вкладку', group: 'Вкладки и панели' },
  { id: 'pane.split', title: 'Разделить область', group: 'Вкладки и панели' },
  { id: 'pane.close', title: 'Закрыть область', group: 'Вкладки и панели' },
  { id: 'sidebar.toggleTree', title: 'Скрыть дерево', group: 'Вкладки и панели' },
  { id: 'sidebar.toggleRight', title: 'Скрыть правую панель', group: 'Вкладки и панели' },
  { id: 'aiFeed.toggle', title: 'Лента ассистента', group: 'Вкладки и панели' },
  { id: 'view.outline', title: 'Оглавление заметки', group: 'Вкладки и панели' },
  { id: 'capture.quick', title: 'Быстрая запись', group: 'Прочее' },
  { id: 'prompts.history', title: 'История промтов', group: 'Прочее' },
];

export const DEFAULT_BINDINGS: Record<ActionId, string[]> = {
  'palette.open': ['Ctrl+K'],
  'switcher.open': ['Ctrl+P'],
  'search.global': ['Ctrl+Shift+F'],
  'search.inNote': ['Ctrl+F'],
  'view.tasks': ['Ctrl+Shift+T'],
  'view.brief': ['Ctrl+Shift+B'],
  'settings.open': ['Ctrl+Comma'],
  'nav.back': ['Alt+Left'],
  'nav.forward': ['Alt+Right'],
  'note.new': ['Ctrl+N'],
  'note.newChild': ['Ctrl+Shift+N'],
  'note.newFromTemplate': ['Ctrl+Alt+N'],
  'note.rename': ['F2'],
  'note.delete': ['Delete'],
  'note.copyPage': ['Ctrl+Shift+C'],
  'note.pin': ['Ctrl+Shift+P'],
  'note.exportHtml': [],
  'note.exportMd': [],
  'note.print': [],
  'editor.toggleReading': ['Ctrl+E'],
  'editor.focusMode': ['Ctrl+Shift+Backslash'],
  'editor.linkNote': ['Ctrl+L'],
  'format.bold': ['Ctrl+B'],
  'format.italic': ['Ctrl+I'],
  'task.toggleLine': ['Ctrl+Shift+L'],
  'task.sweepDone': ['Ctrl+Shift+D'],
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Y', 'Ctrl+Shift+Z'],
  'tab.next': ['Ctrl+Tab'],
  'tab.prev': ['Ctrl+Shift+Tab'],
  'tab.close': ['Ctrl+W'],
  'tab.togglePin': ['Ctrl+Alt+P'],
  'pane.split': ['Ctrl+Alt+Backslash'],
  'pane.close': ['Ctrl+Alt+W'],
  'sidebar.toggleTree': ['Ctrl+Backslash'],
  'sidebar.toggleRight': ['Alt+Backslash'],
  'aiFeed.toggle': ['Ctrl+Shift+A'],
  'view.outline': ['Ctrl+Shift+O'],
  'capture.quick': ['Ctrl+Alt+Space'],
  'prompts.history': [],
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'ContextMenu']);

const DISPLAY_KEYS: Record<string, string> = {
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Delete: 'Del',
  Escape: 'Esc',
  Backspace: 'Backspace',
};

const CODE_TO_TOKEN: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backslash: 'Backslash',
  IntlBackslash: 'Backslash',
  Minus: 'Minus',
  Equal: 'Equal',
  Backquote: 'Backquote',
  Quote: 'Quote',
  Semicolon: 'Semicolon',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
};

function normalizeKey(key: string): string {
  if (key === ' ') {
    return 'Space';
  }
  if (key === '\\') {
    return 'Backslash';
  }
  if (key === ',') {
    return 'Comma';
  }
  if (key === '.') {
    return 'Period';
  }
  if (key === '/') {
    return 'Slash';
  }
  if (key.startsWith('Arrow')) {
    return key.slice(5);
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key;
}

/**
 * Токен физической клавиши из `event.code` — не зависит от активной раскладки.
 * При русской раскладке `event.key` даёт кириллицу (B → «и»), из-за чего дефолты
 * (латиница) не матчились; `code` стабилен (`KeyB` в любой раскладке). Для клавиш
 * без `code` откатываемся на `event.key`.
 */
function keyToken(event: KeyboardEvent): string {
  const code = event.code;
  if (code.length > 0) {
    if (code.length === 4 && code.startsWith('Key')) {
      return code.slice(3);
    }
    if (code.length === 6 && code.startsWith('Digit')) {
      return code.slice(5);
    }
    if (code.length === 7 && code.startsWith('Numpad')) {
      const digit = code.slice(6);
      if (digit >= '0' && digit <= '9') {
        return digit;
      }
    }
    if (code.startsWith('Arrow')) {
      return code.slice(5);
    }
    if (/^F\d{1,2}$/.test(code)) {
      return code;
    }
    const mapped = CODE_TO_TOKEN[code];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return normalizeKey(event.key);
}

export function eventToChord(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  parts.push(keyToken(event));
  return parts.join('+');
}

export function chordKeys(chord: string): string[] {
  return chord.split('+').map((key) => DISPLAY_KEYS[key] ?? key);
}

export function formatChord(chord: string): string {
  return chordKeys(chord).join(' + ');
}

export function formatBinding(chords: string[]): string {
  return chords.length === 0 ? '—' : chords.map(formatChord).join(', ');
}

export interface KeybindingsStore {
  bindings: Record<ActionId, string[]>;
  setBinding(id: ActionId, chords: string[]): void;
  resetBinding(id: ActionId): void;
  resetAll(): void;
  matchEvent(event: KeyboardEvent): ActionId | null;
}

export const useKeybindingsStore = create<KeybindingsStore>()(
  persist(
    (set, get) => ({
      bindings: { ...DEFAULT_BINDINGS },
      setBinding: (id, chords) => {
        set((s) => ({ bindings: { ...s.bindings, [id]: chords } }));
      },
      resetBinding: (id) => {
        set((s) => ({ bindings: { ...s.bindings, [id]: [...DEFAULT_BINDINGS[id]] } }));
      },
      resetAll: () => {
        set({ bindings: { ...DEFAULT_BINDINGS } });
      },
      matchEvent: (event) => {
        const chord = eventToChord(event);
        if (chord === null) {
          return null;
        }
        const entries = Object.entries(get().bindings) as [ActionId, string[]][];
        for (const [id, chords] of entries) {
          if (chords.includes(chord)) {
            return id;
          }
        }
        return null;
      },
    }),
    {
      name: 'graphite.keybindings',
      partialize: (s) => ({ bindings: s.bindings }),
      merge: (persisted, current) => {
        const saved = (persisted as { bindings?: Partial<Record<ActionId, string[]>> } | undefined)?.bindings;
        return { ...current, bindings: { ...DEFAULT_BINDINGS, ...(saved ?? {}) } };
      },
    },
  ),
);
