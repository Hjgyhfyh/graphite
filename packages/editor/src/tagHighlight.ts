import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

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

/**
 * Highlights inline `#tags` in the editor with the same recognition rules the
 * core indexer uses, so the styling always matches what actually lands in the
 * tag index. Frontmatter, code and link contexts are left untouched.
 */
export const tagHighlight = ViewPlugin.fromClass(
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
