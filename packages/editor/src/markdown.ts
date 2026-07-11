import { splitFrontmatter } from './frontmatter';

export type MdInline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly MdInline[] }
  | { readonly kind: 'em'; readonly children: readonly MdInline[] }
  | { readonly kind: 'del'; readonly children: readonly MdInline[] }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'tag'; readonly value: string }
  | { readonly kind: 'wikilink'; readonly target: string; readonly label: string }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly MdInline[] };

export interface MdTask {
  readonly checked: boolean;
  readonly line: number;
}

export interface MdListItem {
  readonly indent: number;
  readonly ordered: boolean;
  readonly marker: string;
  readonly content: readonly MdInline[];
  readonly task?: MdTask;
}

export type MdBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly content: readonly MdInline[] }
  | { readonly kind: 'paragraph'; readonly content: readonly MdInline[] }
  | { readonly kind: 'blockquote'; readonly children: readonly MdBlock[] }
  | { readonly kind: 'code'; readonly lang?: string; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly MdListItem[] }
  | { readonly kind: 'hr' };

const INLINE_MAX_DEPTH = 6;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

// Зеркало правил ядра (vault-core parser.rs): из чего состоит тег и после
// каких символов `#` не начинает его.
function isTagChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_/-]/u.test(ch);
}

function blocksTagStart(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_#/-]/u.test(ch);
}

function findMarker(input: string, marker: string, start: number): number {
  let from = start;
  while (from <= input.length - marker.length) {
    const at = input.indexOf(marker, from);
    if (at < 0) {
      return -1;
    }
    if (input[at - 1] === '\\') {
      from = at + marker.length;
      continue;
    }
    return at;
  }
  return -1;
}

/**
 * Total, allocation-light inline parser for the reading view. Never throws and always
 * terminates; anything it cannot classify is preserved as literal text so round-trip
 * intent is never lost.
 */
export function parseInline(input: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  if (input.length === 0) {
    return out;
  }
  const canNest = depth < INLINE_MAX_DEPTH;
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };
  const descend = (inner: string): readonly MdInline[] =>
    canNest ? parseInline(inner, depth + 1) : [{ kind: 'text', value: inner }];

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];

    if (c === '\\' && i + 1 < n) {
      buffer += input[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const end = input.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', value: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === '[' && input[i + 1] === '[') {
      const end = input.indexOf(']]', i + 2);
      if (end > i) {
        const inner = input.slice(i + 2, end);
        const bar = inner.indexOf('|');
        const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
        flush();
        out.push({ kind: 'wikilink', target, label: label.length > 0 ? label : target });
        i = end + 2;
        continue;
      }
    }

    if (c === '[') {
      const close = input.indexOf(']', i + 1);
      if (close > i && input[close + 1] === '(') {
        const paren = input.indexOf(')', close + 2);
        if (paren > close) {
          const label = input.slice(i + 1, close);
          const href = input.slice(close + 2, paren).trim();
          flush();
          out.push({ kind: 'link', href, children: descend(label) });
          i = paren + 1;
          continue;
        }
      }
    }

    if (c === '#' && !blocksTagStart(input[i - 1])) {
      let end = i + 1;
      while (end < n && isTagChar(input[end])) {
        end += 1;
      }
      const value = input.slice(i + 1, end);
      if (value.length > 0 && !/^[0-9]+$/.test(value)) {
        flush();
        out.push({ kind: 'tag', value });
        i = end;
        continue;
      }
    }

    if ((c === '*' && input[i + 1] === '*') || (c === '_' && input[i + 1] === '_')) {
      const marker = c + c;
      const boundaryOk = c === '*' || !isWordChar(input[i - 1]);
      if (boundaryOk && input[i + 2] !== ' ' && input[i + 2] !== undefined) {
        const end = findMarker(input, marker, i + 2);
        if (end > i + 1 && input[end - 1] !== ' ') {
          flush();
          out.push({ kind: 'strong', children: descend(input.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
      }
    }

    if (c === '~' && input[i + 1] === '~') {
      if (input[i + 2] !== ' ' && input[i + 2] !== undefined) {
        const end = findMarker(input, '~~', i + 2);
        if (end > i + 1 && input[end - 1] !== ' ') {
          flush();
          out.push({ kind: 'del', children: descend(input.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
      }
    }

    if (c === '*' || c === '_') {
      const boundaryOk = c === '*' || !isWordChar(input[i - 1]);
      if (boundaryOk && input[i + 1] !== ' ' && input[i + 1] !== undefined && input[i + 1] !== c) {
        const end = findMarker(input, c, i + 1);
        if (end > i && input[end - 1] !== ' ' && (c === '*' || !isWordChar(input[end + 1]))) {
          flush();
          out.push({ kind: 'em', children: descend(input.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }

    buffer += c;
    i += 1;
  }
  flush();
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([^`]*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s*(.*)$/;

/** Маркеры блока «Готово»: скрытая служебная разметка убранных планов. */
export const DONE_BLOCK_START_RE = /^<!--\s*готово:\s*(.*?)\s*-->\s*$/;
export const DONE_BLOCK_END_RE = /^<!--\s*\/готово\s*-->\s*$/;
const DONE_MARKER_RE = /^<!--\s*(?:готово:|\/готово)/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    FENCE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    DONE_MARKER_RE.test(line) ||
    isBlank(line)
  );
}

/**
 * Block-level markdown parser scoped to what the reading view renders. Absolute line indices
 * are tracked (via `baseOffset` through nested recursion) so interactive checkboxes toggle the
 * exact source line of the whole document, even inside blockquotes.
 */
export function parseBlocks(source: string, baseOffset = 0): MdBlock[] {
  const lines = source.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    if (isBlank(line) || DONE_MARKER_RE.test(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1][0];
      const lang = fence[2].trim();
      // Закрывающая ограда — тот же символ и длина не короче открывающей
      // (CommonMark); иначе блок «закрывается» не там и глотает текст после ```.
      const closeRe = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < n && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < n) {
        i += 1;
      }
      blocks.push({ kind: 'code', lang: lang.length > 0 ? lang : undefined, value: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, content: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      const blockStart = i;
      const inner: string[] = [];
      while (i < n) {
        const q = QUOTE_RE.exec(lines[i]);
        if (q === null) {
          if (isBlank(lines[i])) {
            break;
          }
          inner.push(lines[i]);
          i += 1;
          continue;
        }
        inner.push(q[1]);
        i += 1;
      }
      blocks.push({ kind: 'blockquote', children: parseBlocks(inner.join('\n'), baseOffset + blockStart) });
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list !== null) {
      const items: MdListItem[] = [];
      while (i < n) {
        const m = LIST_RE.exec(lines[i]);
        if (m === null) {
          break;
        }
        const indent = Math.floor(m[1].replace(/\t/g, '    ').length / 2);
        const ordered = /\d/.test(m[2]);
        const rest = m[3];
        const task = TASK_RE.exec(rest);
        if (task !== null) {
          items.push({
            indent,
            ordered,
            marker: m[2],
            content: parseInline(task[2]),
            task: { checked: task[1].toLowerCase() === 'x', line: baseOffset + i },
          });
        } else {
          items.push({ indent, ordered, marker: m[2], content: parseInline(rest) });
        }
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < n && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', content: parseInline(para.join(' ').replace(/\s+/g, ' ').trim()) });
  }

  return blocks;
}

export interface SweepDoneResult {
  /** Итоговый текст заметки. */
  text: string;
  /** Сколько верхнеуровневых пунктов уехало в «Готово». */
  moved: number;
}

const TOP_TASK_RE = /^(?:[-*+]|\d{1,9}[.)])\s+\[([ xX/])\]/;
const NESTED_TASK_RE = /^\s+(?:[-*+]|\d{1,9}[.)])\s+\[([ xX/])\]/;
const DATE_HEADING_RE = /^###\s+(.*?)\s*#*\s*$/;

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е');
}

/**
 * Переносит выполненные верхнеуровневые пункты-чекбоксы (вместе с вложенными
 * строками) в конец секции «## Готово», создавая её при необходимости; пункт
 * с невыполненным дочерним чекбоксом остаётся на месте. Строки задач
 * сохраняются байт-в-байт (якоря и метки не задеваются), EOL-стиль исходника
 * не меняется. `dateLabel` группирует перенесённое под `### <дата>`, не
 * дублируя подзаголовок при повторной уборке в тот же день.
 */
/** Границы секции «## Готово»: заголовок → следующий заголовок уровня ≤2 или конец. */
function findDoneSection(lines: readonly string[], bodyStart: number): { start: number; end: number } {
  let start = -1;
  let end = lines.length;
  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = HEADING_RE.exec(lines[i]);
    if (heading === null) {
      continue;
    }
    if (start === -1) {
      if (heading[1].length === 2 && normalizeHeading(heading[2]) === 'готово') {
        start = i;
      }
    } else if (heading[1].length <= 2) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Пересобирает документ: строки из `movedSet` уходят, `movedLines` дописываются
 * в конец секции «Готово» (секция и дневной подзаголовок создаются при
 * необходимости). Пустая строка после вырезанного куска схлопывается, чтобы
 * на его месте не оставалось двойного пробела.
 */
function relocateToDone(
  lines: readonly string[],
  eol: string,
  movedSet: ReadonlySet<number>,
  movedLines: readonly string[],
  doneStart: number,
  doneEnd: number,
  dateLabel?: string,
): string {
  const kept: string[] = [];
  let insertAt = -1;
  for (let k = 0; k < lines.length; k++) {
    if (doneStart !== -1 && k === doneEnd) {
      insertAt = kept.length;
    }
    if (movedSet.has(k)) {
      continue;
    }
    if (
      lines[k].trim().length === 0 &&
      k > 0 &&
      movedSet.has(k - 1) &&
      (kept.length === 0 || kept[kept.length - 1].trim().length === 0)
    ) {
      continue;
    }
    kept.push(lines[k]);
  }
  if (insertAt === -1) {
    insertAt = kept.length;
  }
  let floor = 0;
  if (doneStart !== -1) {
    for (let k = 0; k <= doneStart; k++) {
      if (!movedSet.has(k)) {
        floor += 1;
      }
    }
  }
  while (insertAt > floor && kept[insertAt - 1].trim().length === 0) {
    insertAt -= 1;
  }

  const block: string[] = [];
  if (doneStart === -1) {
    if (insertAt > 0 && kept[insertAt - 1].trim().length !== 0) {
      block.push('');
    }
    block.push('## Готово');
  }
  if (dateLabel !== undefined && dateLabel.length > 0) {
    let lastDate: string | null = null;
    if (doneStart !== -1) {
      for (let k = doneStart + 1; k < doneEnd; k++) {
        const dated = DATE_HEADING_RE.exec(lines[k]);
        if (dated !== null) {
          lastDate = dated[1].trim();
        }
      }
    }
    if (lastDate !== dateLabel) {
      block.push(`### ${dateLabel}`);
    }
  }
  block.push(...movedLines);

  return [...kept.slice(0, insertAt), ...block, ...kept.slice(insertAt)].join(eol);
}

export function sweepDoneTasks(source: string, dateLabel?: string): SweepDoneResult | null {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const bodyStart = splitFrontmatter(source)?.bodyLine ?? 0;
  const { start: doneStart, end: doneEnd } = findDoneSection(lines, bodyStart);

  const units: { from: number; to: number }[] = [];
  let inFence = false;
  let i = bodyStart;
  while (i < lines.length) {
    if (doneStart !== -1 && i >= doneStart && i < doneEnd) {
      i = doneEnd;
      inFence = false;
      continue;
    }
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      i += 1;
      continue;
    }
    const top = TOP_TASK_RE.exec(line);
    if (top === null) {
      i += 1;
      continue;
    }
    const from = i;
    let open = top[1] !== 'x' && top[1] !== 'X';
    i += 1;
    while (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim().length > 0) {
      const child = NESTED_TASK_RE.exec(lines[i]);
      if (child !== null && child[1] !== 'x' && child[1] !== 'X') {
        open = true;
      }
      i += 1;
    }
    if (!open) {
      units.push({ from, to: i });
    }
  }
  if (units.length === 0) {
    return null;
  }

  const movedSet = new Set<number>();
  for (const unit of units) {
    for (let k = unit.from; k < unit.to; k++) {
      movedSet.add(k);
    }
  }
  const movedLines = units.flatMap((unit) => lines.slice(unit.from, unit.to));

  return {
    text: relocateToDone(lines, eol, movedSet, movedLines, doneStart, doneEnd, dateLabel),
    moved: units.length,
  };
}

/**
 * Сжимает произвольно выделенные строки в блок «Готово» прямо на месте: текст
 * оборачивается скрытыми маркерами `<!-- готово: … --> … <!-- /готово -->` и
 * сохраняется байт-в-байт. Каждая уборка — отдельный самостоятельный блок
 * (редактор сворачивает его в капсулу), так что в одном файле копится стопка
 * закрытых планов, а ниже пишется следующий. `moved` — число непустых строк.
 */
export function sweepLinesDone(
  source: string,
  fromLine: number,
  toLine: number,
  label?: string,
): SweepDoneResult | null {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const bodyStart = splitFrontmatter(source)?.bodyLine ?? 0;

  let from = Math.max(fromLine, bodyStart);
  let to = Math.min(toLine, lines.length - 1);
  while (from <= to && lines[from].trim().length === 0) {
    from += 1;
  }
  while (to >= from && lines[to].trim().length === 0) {
    to -= 1;
  }
  if (from > to) {
    return null;
  }

  // Блоки не вкладываются: выделение не должно захватывать чужие маркеры
  // и не должно начинаться внутри уже убранного блока.
  for (let k = from; k <= to; k++) {
    if (DONE_BLOCK_START_RE.test(lines[k]) || DONE_BLOCK_END_RE.test(lines[k])) {
      return null;
    }
  }
  let insideBlock = false;
  for (let k = bodyStart; k < from; k++) {
    if (DONE_BLOCK_START_RE.test(lines[k])) {
      insideBlock = true;
    } else if (DONE_BLOCK_END_RE.test(lines[k])) {
      insideBlock = false;
    }
  }
  if (insideBlock) {
    return null;
  }

  const content = lines.slice(from, to + 1);
  const moved = content.filter((line) => line.trim().length > 0).length;
  if (moved === 0) {
    return null;
  }

  const startMarker = label !== undefined && label.length > 0 ? `<!-- готово: ${label} -->` : '<!-- готово: -->';
  const block: string[] = [];
  if (from > 0 && lines[from - 1].trim().length !== 0) {
    block.push('');
  }
  block.push(startMarker, ...content, '<!-- /готово -->');
  if (to + 1 >= lines.length || lines[to + 1].trim().length !== 0) {
    block.push('');
  }

  const out = [...lines.slice(0, from), ...block, ...lines.slice(to + 1)];
  return { text: out.join(eol), moved };
}

/** Flip the checkbox state on a single source line, preserving the rest byte-for-byte. */
export function toggleTaskOnLine(source: string, lineIndex: number): string | null {
  const lines = source.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }
  const replaced = lines[lineIndex].replace(/\[([ xX])\]/, (_full, mark: string) =>
    mark === ' ' ? '[x]' : '[ ]',
  );
  if (replaced === lines[lineIndex]) {
    return null;
  }
  lines[lineIndex] = replaced;
  return lines.join('\n');
}
