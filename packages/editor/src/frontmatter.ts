import type { Text } from '@codemirror/state';

export const FM_OPEN_RE = /^\uFEFF?---\s*$/;
export const FM_CLOSE_RE = /^(?:---|\.\.\.)\s*$/;
export const FM_MAX_SCAN = 200;

/** End char offset of a leading YAML frontmatter block, or 0 when the doc has none. */
export function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || !FM_OPEN_RE.test(doc.line(1).text)) {
    return 0;
  }
  const last = Math.min(doc.lines, FM_MAX_SCAN);
  for (let ln = 2; ln <= last; ln += 1) {
    if (FM_CLOSE_RE.test(doc.line(ln).text)) {
      return doc.line(ln).to;
    }
  }
  return 0;
}

export interface FrontmatterEntry {
  readonly key: string;
  /** Scalar value; empty string for list or nested entries. */
  readonly value: string;
  /** Items of an inline `[a, b]` or block `- a` list. */
  readonly items: readonly string[];
}

export interface ParsedFrontmatter {
  /** Lines the block occupies including both `---` fences. */
  readonly lineCount: number;
  /** Char offset right after the closing fence line (before its newline). */
  readonly end: number;
  readonly entries: readonly FrontmatterEntry[];
}

const KEY_LINE_RE = /^([A-Za-zА-Яа-яЁё0-9_.-]+)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitInlineList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/**
 * Tolerant reader for the small YAML dialect Graphite writes into note
 * frontmatter: scalar `key: value`, inline `[a, b]` lists and indented
 * `- item` block lists. Unknown shapes are kept as opaque entries so the
 * key still shows up in summaries; nothing here ever throws.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter | null {
  const rawLines = source.split('\n');
  const lines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length < 2 || !FM_OPEN_RE.test(lines[0])) {
    return null;
  }
  let close = -1;
  const last = Math.min(lines.length, FM_MAX_SCAN);
  for (let i = 1; i < last; i += 1) {
    if (FM_CLOSE_RE.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return null;
  }

  const entries: FrontmatterEntry[] = [];
  let i = 1;
  while (i < close) {
    const line = lines[i];
    const key = KEY_LINE_RE.exec(line);
    if (key === null) {
      i += 1;
      continue;
    }
    const rest = key[2].trim();
    if (rest.length === 0) {
      const items: string[] = [];
      let j = i + 1;
      while (j < close) {
        const item = LIST_ITEM_RE.exec(lines[j]);
        if (item === null) {
          break;
        }
        const value = unquote(item[1]);
        if (value.length > 0) {
          items.push(value);
        }
        j += 1;
      }
      entries.push({ key: key[1], value: '', items });
      i = Math.max(j, i + 1);
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      entries.push({ key: key[1], value: '', items: splitInlineList(rest.slice(1, -1)) });
    } else {
      entries.push({ key: key[1], value: unquote(rest), items: [] });
    }
    i += 1;
  }

  let end = 0;
  for (let n = 0; n <= close; n += 1) {
    end += rawLines[n].length + (n < close ? 1 : 0);
  }

  return { lineCount: close + 1, end, entries };
}

export interface FrontmatterSplit {
  readonly frontmatter: ParsedFrontmatter;
  /** Document text after the closing fence (leading newline stripped). */
  readonly body: string;
  /** 0-based index of the first body line inside the full document. */
  readonly bodyLine: number;
}

/** Splits a document into parsed frontmatter and body, or null when there is no block. */
export function splitFrontmatter(source: string): FrontmatterSplit | null {
  const frontmatter = parseFrontmatter(source);
  if (frontmatter === null) {
    return null;
  }
  const afterFence = frontmatter.end < source.length ? frontmatter.end + 1 : frontmatter.end;
  return {
    frontmatter,
    body: source.slice(afterFence),
    bodyLine: frontmatter.lineCount,
  };
}
