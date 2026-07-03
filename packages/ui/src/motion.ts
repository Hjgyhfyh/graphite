export interface SpringConfig {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

export const springs = {
  snappy: { stiffness: 480, damping: 38, mass: 0.9 },
  standard: { stiffness: 340, damping: 30, mass: 1 },
  soft: { stiffness: 250, damping: 26, mass: 1 },
} as const satisfies Record<string, SpringConfig>;

export type SpringName = keyof typeof springs;

export function springTransition(name: SpringName): SpringConfig & { readonly type: 'spring' } {
  return { type: 'spring', ...springs[name] };
}

export const ease = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

export const easePoints = {
  out: [0.22, 1, 0.36, 1],
  in: [0.4, 0, 1, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<keyof typeof ease, readonly [number, number, number, number]>;

export const MOTION_BUDGET_MS = 450;
export const STAGGER_CAP = 8;
export const HOVER_TRANSITION_MS = 120;
export const REDUCED_MOTION_CROSSFADE_MS = 80;
export const TOOLTIP_DELAY_MS = 400;

export type MotionVersion = 'MVP' | 'v1' | 'v2';

export interface MotionSpec {
  readonly name: string;
  readonly version: MotionVersion;
  readonly mvpFallback?: string;
  readonly durationsMs: Readonly<Record<string, number>>;
  readonly springs: Readonly<Record<string, SpringName>>;
  readonly staggersMs: Readonly<Record<string, number>>;
  readonly caps: Readonly<Record<string, number>>;
  readonly notes: string;
}

export const MOTION = {
  M1: {
    name: 'Запуск окна',
    version: 'MVP',
    durationsMs: { windowFade: 140, panels: 220, total: 450 },
    springs: { windowScale: 'soft' },
    staggersMs: { panels: 45 },
    caps: {},
    notes: 'opacity 0→1 ease-out, scale 0.97→1; панели translateY 10→0 стаггером',
  },
  M2: {
    name: 'Разворот ветки',
    version: 'MVP',
    durationsMs: { chevron: 160 },
    springs: { children: 'snappy' },
    staggersMs: { children: 18 },
    caps: { children: 8 },
    notes: 'шеврон rotate 90°; дети FLIP, opacity + translateY -6→0',
  },
  M3: {
    name: 'Открытие заметки',
    version: 'v1',
    durationsMs: { title: 200 },
    springs: {},
    staggersMs: { blocks: 22 },
    caps: { blocks: 6 },
    notes: 'заголовок, затем стаггер только первых блоков',
  },
  M4: {
    name: 'Скользящий hover',
    version: 'MVP',
    durationsMs: {},
    springs: { pill: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'общая пилюля --bg-3 через layoutId',
  },
  M5: {
    name: 'DnD в дереве',
    version: 'v1',
    mvpFallback: 'без овершутов, базовый DnD',
    durationsMs: { grab: 150, insertLine: 120 },
    springs: { neighbors: 'snappy', drop: 'standard' },
    staggersMs: {},
    caps: {},
    notes: 'захват scale 1.03 + rotate 1.5°; линия вставки scaleX; посадка спрингом',
  },
  M6: {
    name: 'Переход вид-вид',
    version: 'v1',
    durationsMs: { exit: 160, enter: 200 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'канбан: старый opacity→0 + scale 0.985 ease-in; новый scale 1.015→1 ease-out',
  },
  M7: {
    name: 'Палитра: открытие',
    version: 'MVP',
    durationsMs: { overlay: 150 },
    springs: { panel: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'overlay 0→0.55; панель scale 0.96→1; фон приложения scale 0.995',
  },
  M8: {
    name: 'Палитра: закрытие и фильтр',
    version: 'MVP',
    durationsMs: { close: 120, rows: 60 },
    springs: { listHeight: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'закрытие ease-in; при фильтрации высота спрингом, строки кроссфейдом',
  },
  M9: {
    name: 'Скелетоны',
    version: 'MVP',
    durationsMs: { threshold: 150, shimmer: 1300, crossfade: 180 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'показывать только если ответ дольше threshold; shimmer лупом',
  },
  M10: {
    name: 'Тосты',
    version: 'MVP',
    durationsMs: { progress: 4000, exit: 160 },
    springs: { enter: 'standard', stack: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'прогресс linear; уход ease-in',
  },
  M11: {
    name: 'Автосейв',
    version: 'MVP',
    durationsMs: { dot: 500, check: 220 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'точка scale 1→1.3→1; галочка draw',
  },
  M12: {
    name: 'Пульс MCP',
    version: 'MVP',
    durationsMs: { cycle: 1200, feedRow: 200 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'opacity 0.45↔1 + scale 1↔1.12 циклом; появление строки ленты',
  },
  M13: {
    name: 'AI-правка в тексте',
    version: 'MVP',
    durationsMs: { highlightFade: 1400, mark: 180 },
    springs: { badge: 'soft' },
    staggersMs: {},
    caps: {},
    notes: 'фон --ai-dim → transparent; левая метка scaleY',
  },
  M14: {
    name: 'Создание из палитры',
    version: 'v1',
    durationsMs: { morph: 380 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'morph FLIP заголовка палитры в H1 заметки',
  },
  M15: {
    name: 'Поповеры, меню, тултипы',
    version: 'MVP',
    durationsMs: { open: 150, tooltipDelay: 400 },
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'origin от точки вызова, scale 0.95→1',
  },
  M16: {
    name: 'Чекбокс задачи',
    version: 'MVP',
    durationsMs: { check: 160, strike: 200 },
    springs: { box: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'галочка draw; зачёркивание width; строка до opacity 0.55',
  },
  M17: {
    name: 'Вкладки',
    version: 'v1',
    mvpFallback: 'только кроссфейд контента',
    durationsMs: { crossfade: 120 },
    springs: { indicator: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'индикатор slide спрингом; контент кроссфейдом',
  },
  M18: {
    name: 'Скролл: sticky-H1',
    version: 'v1',
    durationsMs: {},
    springs: {},
    staggersMs: {},
    caps: {},
    notes: 'H1 28→17px scroll-driven, только transform',
  },
  M19: {
    name: 'Граф',
    version: 'v2',
    durationsMs: {},
    springs: { nodes: 'soft' },
    staggersMs: { nodes: 12 },
    caps: {},
    notes: 'hover: соседи --accent, остальные до opacity 0.3',
  },
  M20: {
    name: 'Quick Capture',
    version: 'MVP',
    durationsMs: { enter: 160, contentUp: 140, windowFade: 160 },
    springs: { enter: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'сохранение: контент улетает вверх, окно гаснет',
  },
  M21: {
    name: 'Resize панелей',
    version: 'v1',
    durationsMs: {},
    springs: { snap: 'snappy', collapse: 'standard' },
    staggersMs: {},
    caps: {},
    notes: 'перетаскивание 1:1 без анимации; снап к дефолту; двойной клик — схлопывание',
  },
  M22: {
    name: 'Удаление + undo-тост',
    version: 'MVP',
    durationsMs: { collapse: 180 },
    springs: { neighbors: 'snappy' },
    staggersMs: {},
    caps: {},
    notes: 'height + opacity → 0; соседи спрингом; тост по M10',
  },
} as const satisfies Record<string, MotionSpec>;

export type MotionId = keyof typeof MOTION;
