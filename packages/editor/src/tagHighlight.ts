import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';
import { isWikiFollowClick } from './wikiHover';

export interface InlineTagRange {
  readonly from: number;
  readonly to: number;
}

// Зеркало правил ядра (vault-core parser.rs): тег не начинается сразу после
// буквы/цифры/`_`/`-`/`/`/`#`, состоит из букв, цифр, `_`, `-` и `/`.
const TAG_RE = /(?<![\p{L}\p{N}_#/-])#([\p{L}\p{N}_/-]+)/gu;
const WIKILINK_RE = /\[\[[^\]\n]*\]\]/g;
const DIGITS_ONLY_RE = /^[0-9]+$/;

/**
 * Inline tag ranges within a single line of text, mirroring the core parser
 * rules: purely numeric candidates (`#2026`) and hashes inside wiki links
 * (`[[Тема#Палитра]]`) are not tags. Offsets are relative to the line start.
 */
export function findInlineTags(text: string): InlineTagRange[] {
  if (!text.includes('#')) {
    return [];
  }
  const masked: InlineTagRange[] = [];
  WIKILINK_RE.lastIndex = 0;
  for (let m = WIKILINK_RE.exec(text); m !== null; m = WIKILINK_RE.exec(text)) {
    masked.push({ from: m.index, to: m.index + m[0].length });
  }
  const out: InlineTagRange[] = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(text); m !== null; m = TAG_RE.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    if (DIGITS_ONLY_RE.test(m[1]) || masked.some((range) => from >= range.from && from < range.to)) {
      continue;
    }
    out.push({ from, to });
  }
  return out;
}

/** Имя тега без `#`, если `offset` попадает в диапазон `#тега` на строке. */
export function tagAt(text: string, offset: number): string | null {
  for (const range of findInlineTags(text)) {
    if (offset >= range.from && offset <= range.to) {
      return text.slice(range.from + 1, range.to);
    }
  }
  return null;
}

const TAG_MARK = Decoration.mark({ class: 'cm-gr-tag' });

// В коде, ссылках и URL решётка — просто символ; ядро эти диапазоны маскирует.
const SKIP_CONTEXT = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'Link', 'URL', 'Autolink']);

function inSkippedContext(state: EditorState, pos: number): boolean {
  const cursor = syntaxTree(state).resolveInner(pos, 1).cursor();
  do {
    if (SKIP_CONTEXT.has(cursor.name)) {
      return true;
    }
  } while (cursor.parent());
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const fmEnd = frontmatterEnd(doc);

  for (const range of view.visibleRanges) {
    let line = doc.lineAt(range.from);
    for (;;) {
      if (line.from >= fmEnd) {
        for (const tag of findInlineTags(line.text)) {
          const from = line.from + tag.from;
          if (!inSkippedContext(view.state, from)) {
            items.push(TAG_MARK.range(from, line.from + tag.to));
          }
        }
      }
      if (line.to >= range.to) {
        break;
      }
      line = doc.lineAt(line.to + 1);
    }
  }

  return Decoration.set(items, true);
}

export function tagAround(state: EditorState, pos: number): string | null {
  const fmEnd = frontmatterEnd(state.doc);
  if (pos < fmEnd || inSkippedContext(state, pos)) {
    return null;
  }
  const line = state.doc.lineAt(pos);
  return tagAt(line.text, pos - line.from);
}

const tagDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function tagFollowClicks(onOpen: (tag: string) => void): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!isWikiFollowClick(event)) {
        return false;
      }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        return false;
      }
      const tag = tagAround(view.state, pos);
      if (tag === null) {
        return false;
      }
      event.preventDefault();
      onOpen(tag);
      return true;
    },
  });
}

/**
 * Highlights inline `#tags` in the editor with the same recognition rules the
 * core indexer uses, so the styling always matches what actually lands in the
 * tag index. Frontmatter, code and link contexts are left untouched.
 * Ctrl/Cmd+клик открывает тег, если передан `onOpen`.
 */
export function tagHighlight(onOpen?: (tag: string) => void): Extension {
  return onOpen !== undefined ? [tagDecorations, tagFollowClicks(onOpen)] : tagDecorations;
}
