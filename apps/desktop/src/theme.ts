export type Theme = 'default' | 'dracula' | 'paper';

export interface ThemeOption {
  id: Theme;
  label: string;
  /** Мини-палитра для свотчей селектора: поверхность, акцент, ИИ. */
  swatch: readonly [string, string, string];
}

/** Каталог тем. Сами значения токенов живут в packages/ui/src/tokens.css. */
export const THEMES: readonly ThemeOption[] = [
  { id: 'default', label: 'Графит', swatch: ['#0D0E11', '#8B93FF', '#4FD6BE'] },
  { id: 'dracula', label: 'Dracula', swatch: ['#282A36', '#BD93F9', '#FF79C6'] },
  { id: 'paper', label: 'Бумага', swatch: ['#F4F2EC', '#4F58C9', '#1B8F7C'] },
];

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((option) => option.id === value);
}

/**
 * Применяет тему атрибутом data-theme на <html>: каскад CSS-токенов доводит
 * палитру до всего интерфейса, включая CodeMirror. База — без атрибута.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'default') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export function nextTheme(current: Theme): Theme {
  const index = THEMES.findIndex((option) => option.id === current);
  return THEMES[(index + 1) % THEMES.length].id;
}

const THEME_CROSSFADE_MS = 360;

let crossfadeTimer: number | undefined;

/**
 * Плавный перелив палитры при смене темы на лету: на время перехода включаем
 * цветовые transition-правила для всего документа (index.css), затем снимаем.
 * Вызывать до applyTheme и только вне reduced-motion — на старте окна не нужен.
 */
export function startThemeCrossfade(): void {
  const root = document.documentElement;
  root.setAttribute('data-theme-switching', 'true');
  if (crossfadeTimer !== undefined) {
    window.clearTimeout(crossfadeTimer);
  }
  crossfadeTimer = window.setTimeout(() => {
    crossfadeTimer = undefined;
    root.removeAttribute('data-theme-switching');
  }, THEME_CROSSFADE_MS);
}
