export type MdInline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly MdInline[] }
  | { readonly kind: 'em'; readonly children: readonly MdInline[] }
  | { readonly kind: 'code'; readonly value: string }
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
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

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
    isBlank(line)
  );
}

/**
 * Block-level markdown parser scoped to what the reading view renders. Line indices are
 * tracked so interactive checkboxes can toggle the exact source line.
 */
export function parseBlocks(source: string): MdBlock[] {
  const lines = source.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1][0];
      const lang = fence[2].trim();
      const body: string[] = [];
      i += 1;
      while (i < n && !new RegExp(`^\\s{0,3}${marker === '`' ? '```+' : '~~~+'}\\s*$`).test(lines[i])) {
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
      blocks.push({ kind: 'blockquote', children: parseBlocks(inner.join('\n')) });
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
            task: { checked: task[1].toLowerCase() === 'x', line: i },
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
