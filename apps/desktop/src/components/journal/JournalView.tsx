import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Variants } from 'motion/react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Flame,
  NotebookPen,
  RotateCw,
  Sparkles,
  SquareArrowOutUpRight,
  TriangleAlert,
} from 'lucide-react';
import { Button, cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteRef, TreeNode } from '@graphite/bindings';
import { splitFrontmatter } from '@graphite/editor';
import { DAILY_TEMPLATE_REF, buildDailyDoc, dailyRef } from '../../lib/dailyDoc';
import { dateFromYmd, journalStreaks, monthFill, streakDates } from '../../lib/journalStreak';
import {
  Presence,
  REDUCED_CROSSFADE,
  listItemVariants,
  reducedFadeVariants,
  springSnappy,
  springStandard,
  usePrefersReducedMotion,
} from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { EditorPane } from '../editor/EditorPane';
import { flushPendingSaves } from '../editor/editorSession';
import { copyWikiLink } from '../../lib/wikiLink';
import { NoteIcon, resolveIconColor } from '../tree/NoteIcon';

/** Записи дневника — файлы `Дневник/ГГГГ-ММ-ДД.md`; так же их кладёт `ensure_daily_note`. */
const DAILY_PATH_RE = /^Дневник\/(\d{4}-\d{2}-\d{2})\.md$/;

/** Скелетон показываем только если день открывается дольше порога (M9). */
const SKELETON_DELAY_MS = 150;
const CREATED_BADGE_MS = 4000;
const PRUNE_COUNT_DEBOUNCE_MS = 400;
const DAY_MS = 86_400_000;

const FMT_WEEKDAY_SHORT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const FMT_WEEKDAY_LONG = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' });
const FMT_DAY_MONTH = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const FMT_MONTH_YEAR = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const FMT_MONTH_SHORT = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
const PLURAL_RU = new Intl.PluralRules('ru-RU');

/** 2024-01-01 — понедельник, с него собираем подписи дней недели. */
const WEEKDAYS: readonly string[] = Array.from({ length: 7 }, (_, i) =>
  FMT_WEEKDAY_SHORT.format(new Date(2024, 0, 1 + i)),
);

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

/** Слайд месяца: направление листания приходит через custom (−1 назад, +1 вперёд). */
const monthSlideVariants: Variants = {
  enter: (dir: number) => ({ x: dir * 26, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { x: springSnappy, opacity: { duration: 0.16, ease: EASE_OUT } } },
  exit: (dir: number) => ({ x: dir * -26, opacity: 0, transition: { duration: 0.12, ease: EASE_IN } }),
};

const monthLabelVariants: Variants = {
  enter: (dir: number) => ({ x: dir * 16, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { x: springSnappy, opacity: { duration: 0.14, ease: EASE_OUT } } },
  exit: (dir: number) => ({ x: dir * -16, opacity: 0, transition: { duration: 0.1, ease: EASE_IN } }),
};

const headSwapVariants: Variants = {
  enter: { opacity: 0, y: 7 },
  center: { opacity: 1, y: 0, transition: { y: springSnappy, opacity: { duration: 0.14, ease: EASE_OUT } } },
  exit: { opacity: 0, y: -5, transition: { duration: 0.1, ease: EASE_IN } },
};

const paneSlideVariants: Variants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0, transition: { y: springStandard, opacity: { duration: 0.18, ease: EASE_OUT } } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.12, ease: EASE_IN } },
};

const paneFadeVariants: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.16, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.11, ease: EASE_IN } },
};

const reducedSwapVariants: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: REDUCED_CROSSFADE },
  exit: { opacity: 0, transition: REDUCED_CROSSFADE },
};

const monthListVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15, ease: EASE_OUT, staggerChildren: 0.02 } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_IN } },
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const rule = PLURAL_RU.select(count);
  return rule === 'one' ? one : rule === 'few' ? few : many;
}

function dayAria(date: Date): string {
  return `${capitalize(FMT_WEEKDAY_LONG.format(date))}, ${FMT_DAY_MONTH.format(date)} ${date.getFullYear()}`;
}

function relativeLabel(date: string, today: string): string | undefined {
  const diff = Math.round((dateFromYmd(date).getTime() - dateFromYmd(today).getTime()) / DAY_MS);
  if (diff === 0) {
    return 'Сегодня';
  }
  if (diff === 1) {
    return 'Завтра';
  }
  if (diff === -1) {
    return 'Вчера';
  }
  return undefined;
}

function describeDayError(error: unknown): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено — попробуйте чуть позже' : error.message;
  }
  return 'Не удалось открыть запись этого дня';
}

/** Положение месяца в календаре + направление последнего листания для анимации. */
interface MonthCursor {
  year: number;
  month: number;
  dir: number;
}

interface DayCellProps {
  date: Date;
  dateStr: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasEntry: boolean;
  inStreak: boolean;
  tint?: string;
  pillLayoutId: string;
  reduced: boolean;
  onSelect: (date: string) => void;
}

function DayCell({
  date,
  dateStr,
  inMonth,
  isToday,
  isSelected,
  hasEntry,
  inStreak,
  tint,
  pillLayoutId,
  reduced,
  onSelect,
}: DayCellProps) {
  return (
    <motion.button
      type="button"
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          void copyWikiLink(dailyRef(dateStr));
          return;
        }
        onSelect(dateStr);
      }}
      whileTap={reduced ? undefined : { scale: 0.9 }}
      aria-pressed={isSelected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={`${dayAria(date)}${hasEntry ? ', есть запись' : ''}${inStreak ? ', в текущей серии' : ''}. Ctrl — скопировать ссылку`}
      title="Клик — открыть · Ctrl — скопировать ссылку"
      className={cx(
        'relative flex size-9 items-center justify-center rounded-full text-ui tabular-nums transition-colors duration-[120ms]',
        isSelected
          ? 'font-semibold text-bg-0'
          : isToday
            ? 'font-semibold text-accent hover:bg-accent-dim'
            : inMonth
              ? 'text-text-1 hover:bg-bg-3 hover:text-text-0'
              : 'text-text-3 hover:bg-bg-2 hover:text-text-2',
      )}
    >
      {isSelected ? (
        <motion.span
          layoutId={pillLayoutId}
          aria-hidden
          className="absolute inset-0 rounded-full bg-accent shadow-1"
          transition={reduced ? REDUCED_CROSSFADE : springSnappy}
        />
      ) : isToday ? (
        <span aria-hidden className="absolute inset-0 rounded-full ring-1 ring-inset ring-accent/45" />
      ) : null}
      <span className="relative z-10">{date.getDate()}</span>
      {hasEntry && !isSelected ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] z-0 rounded-full"
          style={{
            backgroundColor: `color-mix(in srgb, ${tint ?? 'var(--accent)'} ${inStreak ? (inMonth ? '42%' : '24%') : inMonth ? '22%' : '12%'}, transparent)`,
          }}
        />
      ) : null}
    </motion.button>
  );
}

interface StateCardProps {
  tone: 'accent' | 'danger';
  icon: ReactNode;
  title: string;
  hint: string;
  action?: { label: string; icon?: ReactNode; run: () => void };
}

function StateCard({ tone, icon, title, hint, action }: StateCardProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-l border border-stroke-0 bg-bg-1 px-8 py-9 text-center shadow-1 inset-shadow-hairline">
        <span
          className={cx(
            'flex size-11 items-center justify-center rounded-full',
            tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-accent-dim text-accent',
          )}
        >
          {icon}
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-ui font-medium text-text-0">{title}</p>
          <p className="text-caption leading-relaxed text-text-2">{hint}</p>
        </div>
        {action !== undefined ? (
          <Button variant="ghost" size="sm" onClick={action.run}>
            {action.icon}
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DaySkeleton({ reduced }: { reduced: boolean }) {
  const lines: ReadonlyArray<{ h: string; w: string }> = [
    { h: 'h-7', w: '38%' },
    { h: 'h-3.5', w: '86%' },
    { h: 'h-3.5', w: '72%' },
    { h: 'h-3.5', w: '80%' },
    { h: 'h-3.5', w: '46%' },
  ];
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-10 pt-12">
      {lines.map((line, index) => (
        <motion.div
          key={index}
          className={cx('rounded-s bg-bg-2', line.h, index === 0 ? 'mb-3' : undefined)}
          style={{ width: line.w }}
          animate={reduced ? undefined : { opacity: [0.5, 0.85, 0.5] }}
          transition={reduced ? undefined : { duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: index * 0.08 }}
        />
      ))}
    </div>
  );
}

export function JournalView() {
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const tauri = useMemo(() => isTauriAvailable(), []);

  const [today, setToday] = useState(() => ymd(new Date()));
  const [cursor, setCursor] = useState<MonthCursor>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth(), dir: 0 };
  });
  const [selectedDate, setSelectedDate] = useState(() => ymd(new Date()));
  const journalDate = useUiStore((s) => s.journalDate);

  useEffect(() => {
    if (journalDate === undefined) {
      return;
    }
    setSelectedDate(journalDate);
    const dayDate = dateFromYmd(journalDate);
    setCursor({ year: dayDate.getFullYear(), month: dayDate.getMonth(), dir: 0 });
    useUiStore.getState().consumeJournalDate();
  }, [journalDate]);
  const [day, setDay] = useState<{ ref: NoteRef; virgin: boolean; doc?: string } | undefined>(undefined);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState<string | undefined>(undefined);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [createdBadge, setCreatedBadge] = useState(false);
  const [pruneCount, setPruneCount] = useState(0);
  const [pruning, setPruning] = useState(false);

  /** Защита от гонок: устаревший ответ peekDailyNote не должен перебить свежий. */
  const daySeq = useRef(0);
  const openedDateRef = useRef<string | undefined>(undefined);

  /** Тело шаблона «Шаблоны/Дневник.md»: null — шаблона нет, читается один раз за жизнь вида. */
  const dayTemplateRef = useRef<string | null | undefined>(undefined);

  useEffect(
    () => () => {
      daySeq.current += 1;
      openedDateRef.current = undefined;
    },
    [],
  );

  /* Записи дневника из дерева: дата → узел. */
  const entriesByDate = useMemo(() => {
    const map = new Map<string, TreeNode>();
    for (const node of tree) {
      const match = DAILY_PATH_RE.exec(node.path.replace(/\\/g, '/'));
      if (match !== null) {
        map.set(match[1], node);
      }
    }
    return map;
  }, [tree]);

  const dateSet = useMemo(() => new Set(entriesByDate.keys()), [entriesByDate]);
  const streaks = useMemo(() => journalStreaks(dateSet, today), [dateSet, today]);
  const inStreakDates = useMemo(() => streakDates(dateSet, today), [dateSet, today]);

  /* Цвет точки на дне календаря — из иконки заметки, иначе акцент темы. */
  const tintByDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const [date, node] of entriesByDate) {
      const info = iconByRef[node.ref];
      map.set(date, resolveIconColor(info?.color ?? node.iconColor) ?? 'var(--accent)');
    }
    return map;
  }, [entriesByDate, iconByRef]);

  const monthKey = `${cursor.year}-${pad2(cursor.month + 1)}`;
  const monthPrefix = `${monthKey}-`;

  /* Сетка месяца: всегда 6 недель с понедельника — высота календаря стабильна. */
  const gridDays = useMemo(() => {
    const lead = (new Date(cursor.year, cursor.month, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(cursor.year, cursor.month, 1 - lead + i));
  }, [cursor.year, cursor.month]);

  const monthTitle = useMemo(() => {
    const parts = FMT_MONTH_YEAR.formatToParts(new Date(cursor.year, cursor.month, 1));
    const month = parts.find((part) => part.type === 'month')?.value ?? '';
    const year = parts.find((part) => part.type === 'year')?.value ?? String(cursor.year);
    return `${capitalize(month)} ${year}`;
  }, [cursor.year, cursor.month]);

  const monthEntries = useMemo(
    () =>
      [...entriesByDate.entries()]
        .filter(([date]) => date.startsWith(monthPrefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, node]) => ({ date, node })),
    [entriesByDate, monthPrefix],
  );

  const focusMonth = useCallback((date: string) => {
    setCursor((prev) => {
      const target = dateFromYmd(date);
      const targetKey = target.getFullYear() * 12 + target.getMonth();
      const prevKey = prev.year * 12 + prev.month;
      if (targetKey === prevKey) {
        return prev;
      }
      return { year: target.getFullYear(), month: target.getMonth(), dir: targetKey > prevKey ? 1 : -1 };
    });
  }, []);

  const shiftMonth = useCallback((delta: number) => {
    setCursor((prev) => {
      const total = prev.year * 12 + prev.month + delta;
      return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12, dir: delta > 0 ? 1 : -1 };
    });
  }, []);

  const goYearMonth = useCallback((year: number, month: number) => {
    setCursor((prev) => {
      const prevKey = prev.year * 12 + prev.month;
      const nextKey = year * 12 + month;
      if (prevKey === nextKey) {
        return prev;
      }
      return { year, month, dir: nextKey > prevKey ? 1 : -1 };
    });
  }, []);

  /** Лениво читает пользовательский шаблон дня; ошибка или отсутствие — встроенный каркас. */
  const dailyTemplate = useCallback(async (): Promise<string | null> => {
    if (dayTemplateRef.current !== undefined) {
      return dayTemplateRef.current;
    }
    try {
      const res = await commands.noteRead({ ref: DAILY_TEMPLATE_REF });
      dayTemplateRef.current = splitFrontmatter(res.content)?.body ?? res.content;
    } catch {
      dayTemplateRef.current = null;
    }
    return dayTemplateRef.current;
  }, []);

  const openDay = useCallback(
    (date: string) => {
      focusMonth(date);
      if (openedDateRef.current === date) {
        return;
      }
      openedDateRef.current = date;
      setSelectedDate(date);
      setCreatedBadge(false);
      setDayError(undefined);
      setDay(undefined);
      const seq = (daySeq.current += 1);
      if (!tauri) {
        setDayLoading(false);
        return;
      }
      setDayLoading(true);
      void (async () => {
        try {
          // Просмотр ничего не создаёт: peek лишь проверяет, есть ли файл дня.
          const note = await commands.peekDailyNote({ date });
          if (seq !== daySeq.current) {
            return;
          }
          if (note.exists) {
            setDayLoading(false);
            setDay({ ref: note.ref, virgin: false });
            return;
          }
          // Файла нет — показываем виргинальный черновик: на диск он ляжет
          // только с первым реальным вводом в редакторе.
          const template = await dailyTemplate();
          if (seq !== daySeq.current) {
            return;
          }
          setDayLoading(false);
          setDay({ ref: dailyRef(date), virgin: true, doc: buildDailyDoc(date, template ?? undefined) });
        } catch (error) {
          if (seq !== daySeq.current) {
            return;
          }
          openedDateRef.current = undefined;
          setDayLoading(false);
          setDayError(describeDayError(error));
        }
      })();
    },
    [focusMonth, tauri, dailyTemplate],
  );

  /* При входе в дневник сразу открываем сегодняшний день. */
  useEffect(() => {
    openDay(ymd(new Date()));
  }, [openDay]);

  /* «Сегодня» не должно протухать за полночь. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = ymd(new Date());
      setToday((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!dayLoading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowSkeleton(true);
    }, SKELETON_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [dayLoading, selectedDate]);

  useEffect(() => {
    if (!createdBadge) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCreatedBadge(false);
    }, CREATED_BADGE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [createdBadge]);

  /* Черновик материализуется первым вводом: как только файл дня появился в
     дереве, день перестаёт быть виртуальным — редактор при этом не ремаунтится. */
  useEffect(() => {
    if (day?.virgin === true && entriesByDate.has(selectedDate)) {
      setDay({ ref: day.ref, virgin: false, doc: day.doc });
      setCreatedBadge(true);
    }
  }, [entriesByDate, selectedDate, day]);

  /* Счётчик нетронутых шаблонов — с дебаунсом, чтобы не дёргать бэкенд на каждое движение дерева. */
  useEffect(() => {
    if (!tauri) {
      return;
    }
    const timer = window.setTimeout(() => {
      commands.pruneEmptyDailyNotes({ dryRun: true }).then(
        (res) => {
          setPruneCount(res.items.length);
        },
        () => {
          setPruneCount(0);
        },
      );
    }, PRUNE_COUNT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [tree, tauri]);

  const restorePruned = useCallback(
    async (tokens: string[]) => {
      try {
        for (const token of tokens) {
          await commands.noteRestore({ restoreToken: token });
        }
        await useVaultStore.getState().loadTree();
        const current = openedDateRef.current;
        if (current !== undefined) {
          openedDateRef.current = undefined;
          openDay(current);
        }
      } catch (error) {
        useUiStore.getState().pushToast({
          kind: 'error',
          text: isGraphiteError(error) ? error.message : 'Не удалось вернуть записи',
        });
      }
    },
    [openDay],
  );

  const pruneEmpty = useCallback(async () => {
    if (pruning) {
      return;
    }
    setPruning(true);
    try {
      // Отложенный автосейв способен воскресить только что убранный файл — сначала гасим его.
      await flushPendingSaves();
      const res = await commands.pruneEmptyDailyNotes({});
      openedDateRef.current = undefined;
      setDay(undefined);
      await useVaultStore.getState().loadTree();
      void useVaultStore.getState().loadInfo();
      setPruneCount(0);
      openDay(selectedDate);
      const tokens = res.items
        .map((item) => item.restoreToken)
        .filter((token): token is string => token !== undefined);
      useUiStore.getState().pushToast({
        kind: 'info',
        text: res.items.length > 0 ? `Убрано пустых записей: ${res.items.length}` : 'Пустых записей уже нет',
        action: tokens.length > 0 ? { label: 'Вернуть', run: () => void restorePruned(tokens) } : undefined,
      });
    } catch (error) {
      useUiStore.getState().pushToast({
        kind: 'error',
        text: isGraphiteError(error) ? error.message : 'Не удалось убрать пустые записи',
      });
    } finally {
      setPruning(false);
    }
  }, [pruning, selectedDate, openDay, restorePruned]);

  const openInTab = useCallback(() => {
    if (day === undefined || day.virgin) {
      return;
    }
    useVaultStore.getState().openNote(day.ref);
    useUiStore.getState().setRailView('tree');
  }, [day]);

  const selectedDateObj = useMemo(() => dateFromYmd(selectedDate), [selectedDate]);
  const headline = `${capitalize(FMT_WEEKDAY_LONG.format(selectedDateObj))}, ${FMT_DAY_MONTH.format(selectedDateObj)} ${selectedDateObj.getFullYear()}`;
  const relChip = relativeLabel(selectedDate, today);
  const todayInView = today.startsWith(monthPrefix);
  const totalEntries = entriesByDate.size;
  const pillLayoutId = `journal-day-pill-${monthKey}`;

  const monthVariants = reduced ? reducedSwapVariants : monthSlideVariants;
  const labelVariants = reduced ? reducedSwapVariants : monthLabelVariants;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 bg-bg-0">
      {/* Левая колонка: календарь и записи месяца */}
      <aside
        aria-label="Календарь дневника"
        className="flex w-[312px] shrink-0 flex-col overflow-hidden border-r border-stroke-0 bg-bg-1"
      >
        <div className="flex flex-col gap-4 px-5 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-s bg-accent-dim text-accent">
              <CalendarDays size={16} strokeWidth={1.75} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-text-0">Дневник</h1>
              <span className="truncate text-micro text-text-3">
                {totalEntries === 0
                  ? 'Пока ни одной записи'
                  : streaks.current > 0
                    ? `Серия ${streaks.current} ${pluralRu(streaks.current, 'день', 'дня', 'дней')} · рекорд ${streaks.best}`
                    : `Пауза · рекорд ${streaks.best} ${pluralRu(streaks.best, 'день', 'дня', 'дней')}`}
              </span>
            </div>
            {streaks.current > 0 ? (
              <span
                title={`Серия ${streaks.current} · рекорд ${streaks.best} · всего ${totalEntries}`}
                className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 text-micro font-semibold tabular-nums text-accent"
              >
                <Flame size={13} strokeWidth={1.75} aria-hidden />
                {streaks.current}
              </span>
            ) : null}
          </div>
          <Button variant="primary" className="w-full" onClick={() => openDay(today)}>
            <NotebookPen size={15} strokeWidth={1.75} />
            Открыть сегодня
          </Button>
        </div>

        {/* Навигация по месяцам */}
        <div className="flex items-center justify-between gap-1 pl-5 pr-3.5 pb-1.5">
          <div className="relative min-w-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false} custom={cursor.dir}>
              <motion.h2
                key={monthKey}
                custom={cursor.dir}
                variants={labelVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="truncate text-ui font-semibold text-text-0"
              >
                {monthTitle}
              </motion.h2>
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => openDay(today)}
              className={cx(
                'h-7 rounded-s px-2 text-caption font-medium transition-colors duration-[120ms] hover:bg-bg-3',
                todayInView && selectedDate === today ? 'text-text-2 hover:text-text-0' : 'text-accent',
              )}
            >
              Сегодня
            </button>
            <button
              type="button"
              aria-label="Предыдущий месяц"
              onClick={() => shiftMonth(-1)}
              className="flex size-7 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4"
            >
              <ChevronLeft size={15} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Следующий месяц"
              onClick={() => shiftMonth(1)}
              className="flex size-7 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4"
            >
              <ChevronRight size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Дни недели */}
        <div aria-hidden className="grid grid-cols-7 place-items-center px-4 pb-1">
          {WEEKDAYS.map((label, index) => (
            <span key={label} className={cx('text-micro font-medium', index >= 5 ? 'text-text-3/80' : 'text-text-3')}>
              {label}
            </span>
          ))}
        </div>

        {/* Сетка месяца */}
        <div className="relative px-4">
          <AnimatePresence mode="popLayout" initial={false} custom={cursor.dir}>
            <motion.div
              key={monthKey}
              custom={cursor.dir}
              variants={monthVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="grid grid-cols-7 place-items-center gap-y-1"
            >
              {gridDays.map((cell) => {
                const dateStr = ymd(cell);
                return (
                  <DayCell
                    key={dateStr}
                    date={cell}
                    dateStr={dateStr}
                    inMonth={cell.getMonth() === cursor.month}
                    isToday={dateStr === today}
                    isSelected={dateStr === selectedDate}
                    hasEntry={entriesByDate.has(dateStr)}
                    inStreak={inStreakDates.has(dateStr)}
                    tint={tintByDate.get(dateStr)}
                    pillLayoutId={pillLayoutId}
                    reduced={reduced}
                    onSelect={openDay}
                  />
                );
              })}
            </motion.div>
          </AnimatePresence>
        </div>

        {totalEntries > 0 ? (
          <div className="flex items-end gap-0.5 px-5 pt-3" role="group" aria-label={`Плотность записей за ${cursor.year}`}>
            {Array.from({ length: 12 }, (_, month) => {
              const fill = monthFill(dateSet, cursor.year, month);
              const active = month === cursor.month;
              const label = capitalize(FMT_MONTH_SHORT.format(new Date(cursor.year, month, 1)));
              return (
                <button
                  key={month}
                  type="button"
                  title={`${label} ${cursor.year}`}
                  aria-label={`${label} ${cursor.year}${fill > 0 ? `, есть записи` : ''}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => goYearMonth(cursor.year, month)}
                  className={cx(
                    'h-3.5 flex-1 rounded-xs transition-[box-shadow,transform] duration-[120ms]',
                    active ? 'ring-1 ring-accent ring-offset-1 ring-offset-bg-1' : 'hover:opacity-90',
                  )}
                  style={{
                    backgroundColor:
                      fill === 0
                        ? 'var(--bg-3)'
                        : `color-mix(in srgb, var(--accent) ${Math.round(18 + fill * 72)}%, var(--bg-3))`,
                  }}
                />
              );
            })}
          </div>
        ) : null}

        {/* Уборка пустышек: нетронутые шаблоны уезжают в корзину, вернуть можно из тоста */}
        <AnimatePresence initial={false}>
          {pruneCount > 0 ? (
            <motion.div
              key="prune"
              initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={
                reduced ? REDUCED_CROSSFADE : { height: springSnappy, opacity: { duration: 0.14, ease: EASE_OUT } }
              }
              className="overflow-hidden px-4"
            >
              <div className="pt-2.5">
                <Button variant="ghost" size="sm" className="w-full" disabled={pruning} onClick={() => void pruneEmpty()}>
                  <Eraser size={14} strokeWidth={1.75} />
                  Убрать пустые записи ({pruneCount})
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Записи месяца */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-stroke-0 pt-3">
          <div className="flex items-baseline justify-between px-5 pb-1.5">
            <span className="text-caption font-medium text-text-2">Записи месяца</span>
            {monthEntries.length > 0 ? (
              <span className="text-micro tabular-nums text-text-3">{monthEntries.length}</span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={monthKey}
                variants={reduced ? reducedFadeVariants : monthListVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex flex-col gap-0.5"
              >
                {monthEntries.length === 0 ? (
                  <div className="mx-1 mt-1 flex flex-col items-center gap-2.5 rounded-m border border-dashed border-stroke-1 px-4 py-8 text-center">
                    <NotebookPen size={17} strokeWidth={1.5} className="text-text-3" />
                    <p className="text-caption leading-relaxed text-text-2">
                      В этом месяце записей пока нет.
                      <br />
                      Откройте день и начните писать — запись появится.
                    </p>
                  </div>
                ) : (
                  monthEntries.map(({ date, node }) => {
                    const info = iconByRef[node.ref];
                    const entryDate = dateFromYmd(date);
                    const active = date === selectedDate;
                    const customTitle = node.title.trim();
                    const subtitle =
                      customTitle.length > 0 && customTitle !== date
                        ? customTitle
                        : capitalize(FMT_WEEKDAY_LONG.format(entryDate));
                    return (
                      <motion.button
                        key={node.ref}
                        type="button"
                        variants={reduced ? reducedFadeVariants : listItemVariants}
                        onClick={(event) => {
                          if (event.ctrlKey || event.metaKey) {
                            event.preventDefault();
                            void copyWikiLink(node.ref);
                            return;
                          }
                          openDay(date);
                        }}
                        title="Клик — открыть · Ctrl — скопировать ссылку"
                        className={cx(
                          'group flex w-full items-center gap-2.5 rounded-s px-2 py-1.5 text-left transition-colors duration-[120ms]',
                          active ? 'bg-bg-2' : 'hover:bg-bg-2/60',
                        )}
                      >
                        <span
                          className={cx(
                            'flex size-7 shrink-0 items-center justify-center rounded-s transition-colors duration-[120ms]',
                            active ? 'bg-accent-dim' : 'bg-bg-2 group-hover:bg-bg-3',
                          )}
                        >
                          <NoteIcon
                            icon={info?.icon ?? node.icon}
                            color={info?.color ?? node.iconColor ?? 'accent'}
                            size={14}
                            fallback="Notebook"
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            className={cx(
                              'truncate text-ui',
                              active ? 'text-text-0' : 'text-text-1 group-hover:text-text-0',
                            )}
                          >
                            {FMT_DAY_MONTH.format(entryDate)}
                          </span>
                          <span className="truncate text-micro text-text-3">{subtitle}</span>
                        </span>
                        {date === today ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                      </motion.button>
                    );
                  })
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </aside>

      {/* Правая часть: запись выбранного дня */}
      <section aria-label="Запись дня" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-stroke-0 px-8 pb-3.5 pt-6">
          <div className="relative min-w-0 flex-1">
            <Presence mode="wait">
              <motion.div
                key={selectedDate}
                variants={reduced ? reducedSwapVariants : headSwapVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1"
              >
                <h2 className="min-w-0 truncate text-h3 text-text-0">{headline}</h2>
                {relChip !== undefined ? (
                  <span
                    className={cx(
                      'rounded-full px-2 py-0.5 text-micro font-medium',
                      relChip === 'Сегодня' ? 'bg-accent/15 text-accent' : 'bg-bg-3 text-text-1',
                    )}
                  >
                    {relChip}
                  </span>
                ) : null}
                <AnimatePresence initial={false}>
                  {day?.virgin === true ? (
                    <motion.span
                      key="draft"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
                      className="rounded-full bg-bg-3 px-2 py-0.5 text-micro font-medium text-text-2"
                    >
                      Черновик — сохранится при первом вводе
                    </motion.span>
                  ) : null}
                  {createdBadge ? (
                    <motion.span
                      key="created"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
                      className="inline-flex items-center gap-1 rounded-full bg-ai/15 px-2 py-0.5 text-micro font-medium text-ai"
                    >
                      <Sparkles size={11} strokeWidth={1.75} />
                      Новая запись
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            </Presence>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={openInTab}
            disabled={day === undefined || day.virgin}
          >
            <SquareArrowOutUpRight size={14} strokeWidth={1.75} />
            Открыть во вкладке
          </Button>
        </header>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Presence mode="wait">
            {!tauri ? (
              <motion.div
                key="offline"
                variants={reduced ? reducedSwapVariants : paneFadeVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex min-h-0 flex-1 flex-col"
              >
                <StateCard
                  tone="accent"
                  icon={<NotebookPen size={20} strokeWidth={1.75} />}
                  title="Дневник живёт в настольном приложении"
                  hint="Календарь можно полистать уже сейчас, а записи по дням откроются в Graphite."
                />
              </motion.div>
            ) : dayError !== undefined ? (
              <motion.div
                key={`error-${selectedDate}`}
                variants={reduced ? reducedSwapVariants : paneFadeVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex min-h-0 flex-1 flex-col"
              >
                <StateCard
                  tone="danger"
                  icon={<TriangleAlert size={20} strokeWidth={1.75} />}
                  title="Не получилось открыть день"
                  hint={dayError}
                  action={{
                    label: 'Попробовать ещё раз',
                    icon: <RotateCw size={14} strokeWidth={1.75} />,
                    run: () => openDay(selectedDate),
                  }}
                />
              </motion.div>
            ) : day !== undefined ? (
              <motion.div
                key={day.ref}
                variants={reduced ? reducedSwapVariants : paneSlideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <EditorPane key={day.ref} tabId={`daily-${day.ref}`} noteRef={day.ref} initialDoc={day.doc} />
              </motion.div>
            ) : (
              <motion.div
                key={`loading-${selectedDate}`}
                variants={reduced ? reducedSwapVariants : paneFadeVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className="flex min-h-0 flex-1 flex-col"
              >
                {showSkeleton ? <DaySkeleton reduced={reduced} /> : null}
              </motion.div>
            )}
          </Presence>
        </div>
      </section>
    </main>
  );
}
