const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Локальная дата из `ГГГГ-ММ-ДД` — без UTC-сдвига `new Date(string)`. */
export function dateFromYmd(value: string): Date {
  return new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
}

export function ymdFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function shiftYmd(value: string, days: number): string {
  const date = dateFromYmd(value);
  date.setDate(date.getDate() + days);
  return ymdFromDate(date);
}

export interface JournalStreaks {
  current: number;
  best: number;
}

/**
 * Текущая серия: подряд до сегодня (или до вчера, если сегодня ещё пусто).
 * Рекорд — самая длинная непрерывная цепочка среди всех дат.
 */
export function journalStreaks(dates: ReadonlySet<string>, today: string): JournalStreaks {
  if (dates.size === 0) {
    return { current: 0, best: 0 };
  }

  const anchor = dates.has(today) ? today : shiftYmd(today, -1);
  let current = 0;
  if (dates.has(anchor)) {
    let cursor = anchor;
    while (dates.has(cursor)) {
      current += 1;
      cursor = shiftYmd(cursor, -1);
    }
  }

  const sorted = [...dates].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined) {
      continue;
    }
    const gap = Math.round((dateFromYmd(next).getTime() - dateFromYmd(prev).getTime()) / DAY_MS);
    if (gap === 1) {
      run += 1;
      if (run > best) {
        best = run;
      }
    } else {
      run = 1;
    }
  }
  return { current, best: Math.max(best, current) };
}

/** Даты, входящие в текущую серию (от якоря назад). */
export function streakDates(dates: ReadonlySet<string>, today: string): Set<string> {
  const { current } = journalStreaks(dates, today);
  const out = new Set<string>();
  if (current === 0) {
    return out;
  }
  let cursor = dates.has(today) ? today : shiftYmd(today, -1);
  for (let i = 0; i < current; i += 1) {
    out.add(cursor);
    cursor = shiftYmd(cursor, -1);
  }
  return out;
}

/** Доля дней месяца с записью, 0…1. */
export function monthFill(dates: ReadonlySet<string>, year: number, month: number): number {
  const prefix = `${year}-${pad2(month + 1)}-`;
  let count = 0;
  for (const date of dates) {
    if (date.startsWith(prefix)) {
      count += 1;
    }
  }
  if (count === 0) {
    return 0;
  }
  const days = new Date(year, month + 1, 0).getDate();
  return Math.min(1, count / days);
}
