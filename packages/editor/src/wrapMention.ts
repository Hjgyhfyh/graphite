import { splitFrontmatter } from './frontmatter';

export interface WikiMentionReplace {
  readonly oldString: string;
  readonly newString: string;
}

const WORD = /[\p{L}\p{N}_-]/u;
const MAX_CONTEXT = 320;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

function countNonOverlap(hay: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let n = 0;
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) {
      return n;
    }
    n += 1;
    i = at + needle.length;
  }
  return n;
}

function bodyStart(doc: string): number {
  const split = splitFrontmatter(doc);
  return split === null ? 0 : doc.length - split.body.length;
}

/** Диапазоны, куда нельзя ставить ссылку: код и уже готовые `[[вики]]`. */
function protectedSpans(doc: string, from: number): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  let i = from;
  while (i < doc.length) {
    if (doc.startsWith('```', i)) {
      const end = doc.indexOf('```', i + 3);
      if (end < 0) {
        spans.push({ from: i, to: doc.length });
        break;
      }
      spans.push({ from: i, to: end + 3 });
      i = end + 3;
      continue;
    }
    const ch = doc[i];
    if (ch === '`') {
      const end = doc.indexOf('`', i + 1);
      if (end < 0) {
        break;
      }
      spans.push({ from: i, to: end + 1 });
      i = end + 1;
      continue;
    }
    if (ch === '[' && doc[i + 1] === '[') {
      const end = doc.indexOf(']]', i + 2);
      if (end < 0) {
        break;
      }
      spans.push({ from: i, to: end + 2 });
      i = end + 2;
      continue;
    }
    i += 1;
  }
  return spans;
}

function inProtected(spans: readonly { from: number; to: number }[], from: number, to: number): boolean {
  for (const span of spans) {
    if (from < span.to && to > span.from) {
      return true;
    }
  }
  return false;
}

function uniquify(doc: string, from: number, to: number, wrapped: string): WikiMentionReplace | undefined {
  let start = from;
  let end = to;
  while (end - start <= MAX_CONTEXT) {
    const oldString = doc.slice(start, end);
    if (countNonOverlap(doc, oldString) === 1) {
      return {
        oldString,
        newString: `${doc.slice(start, from)}${wrapped}${doc.slice(to, end)}`,
      };
    }
    if (start > 0) {
      start -= 1;
    } else if (end < doc.length) {
      end += 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Первое голое упоминание `title` в теле → уникальный `replace` в `[[title]]`.
 * Регистр в файле может отличаться; в скобки идёт каноническое имя.
 */
export function wrapPlainMention(doc: string, title: string): WikiMentionReplace | undefined {
  const needle = title.trim();
  if (needle.length < 3) {
    return undefined;
  }
  const start = bodyStart(doc);
  const protectedInBody = protectedSpans(doc, start);
  const hay = doc.slice(start).toLowerCase();
  const needleLower = needle.toLowerCase();
  const wrapped = `[[${needle}]]`;
  let cursor = 0;
  while (cursor <= hay.length - needleLower.length) {
    const rel = hay.indexOf(needleLower, cursor);
    if (rel < 0) {
      return undefined;
    }
    const from = start + rel;
    const to = from + needle.length;
    cursor = rel + 1;
    if (isWordChar(doc[from - 1]) || isWordChar(doc[to])) {
      continue;
    }
    if (inProtected(protectedInBody, from, to)) {
      continue;
    }
    const replace = uniquify(doc, from, to, wrapped);
    if (replace !== undefined) {
      return replace;
    }
  }
  return undefined;
}
