import { syntaxTree } from '@codemirror/language';
import type { Range, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

const lineDeco = (cls: string): Decoration => Decoration.line({ class: cls });
const markDeco = (cls: string): Decoration => Decoration.mark({ class: cls });

const HEADING_LINE: Record<string, Decoration> = {
  ATXHeading1: lineDeco('cm-gr-h1'),
  ATXHeading2: lineDeco('cm-gr-h2'),
  ATXHeading3: lineDeco('cm-gr-h3'),
  ATXHeading4: lineDeco('cm-gr-h4'),
  ATXHeading5: lineDeco('cm-gr-h5'),
  ATXHeading6: lineDeco('cm-gr-h6'),
  SetextHeading1: lineDeco('cm-gr-h1'),
  SetextHeading2: lineDeco('cm-gr-h2'),
};

const MARK_DIM = markDeco('cm-gr-mark');
const STRONG = markDeco('cm-gr-strong');
const EM = markDeco('cm-gr-em');
const CODE = markDeco('cm-gr-code');
const LINK = markDeco('cm-gr-link');
const LIST_MARK = markDeco('cm-gr-list-mark');
const QUOTE_LINE = lineDeco('cm-gr-quote');
const FENCE_LINE = lineDeco('cm-gr-fence');
const HR_LINE = lineDeco('cm-gr-hr');
const FRONTMATTER_LINE = lineDeco('cm-gr-frontmatter');

const FM_OPEN_RE = /^\uFEFF?---\s*$/;
const FM_CLOSE_RE = /^(?:---|\.\.\.)\s*$/;
const FM_MAX_SCAN = 200;

/** End char offset of a leading YAML frontmatter block, or 0 when the doc has none. */
function frontmatterEnd(doc: Text): number {
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

function buildDecorations(view: EditorView): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;

  const fmEnd = frontmatterEnd(doc);

  const pushLines = (from: number, to: number, deco: Decoration): void => {
    let line = doc.lineAt(from);
    for (;;) {
      items.push(deco.range(line.from));
      if (line.to >= to) {
        break;
      }
      line = doc.lineAt(line.to + 1);
    }
  };
  const pushMark = (from: number, to: number, deco: Decoration): void => {
    if (to > from) {
      items.push(deco.range(from, to));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    if (fmEnd > 0 && from < fmEnd) {
      let line = doc.lineAt(from);
      while (line.from < fmEnd) {
        items.push(FRONTMATTER_LINE.range(line.from));
        if (line.to >= to || line.to + 1 > doc.length) {
          break;
        }
        line = doc.lineAt(line.to + 1);
      }
    }
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (fmEnd > 0 && node.to <= fmEnd) {
          return;
        }
        const name = node.name;
        const heading = HEADING_LINE[name];
        if (heading !== undefined) {
          pushLines(node.from, node.to, heading);
          return;
        }
        switch (name) {
          case 'HeaderMark':
          case 'EmphasisMark':
          case 'CodeMark':
          case 'QuoteMark':
          case 'LinkMark':
          case 'URL':
            pushMark(node.from, node.to, MARK_DIM);
            break;
          case 'StrongEmphasis':
            pushMark(node.from, node.to, STRONG);
            break;
          case 'Emphasis':
            pushMark(node.from, node.to, EM);
            break;
          case 'InlineCode':
            pushMark(node.from, node.to, CODE);
            break;
          case 'FencedCode':
            pushLines(node.from, node.to, FENCE_LINE);
            break;
          case 'Blockquote':
            pushLines(node.from, node.to, QUOTE_LINE);
            break;
          case 'ListMark':
            pushMark(node.from, node.to, LIST_MARK);
            break;
          case 'Link':
            pushMark(node.from, node.to, LINK);
            break;
          case 'HorizontalRule':
            pushLines(node.from, node.to, HR_LINE);
            pushMark(node.from, node.to, MARK_DIM);
            break;
          default:
            break;
        }
      },
    });
  }

  return Decoration.set(items, true);
}

/**
 * View-only markdown live-preview: heading scale, emphasis/code/link styling and dimmed
 * syntax markers, all derived from the parse tree so the underlying bytes never change.
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
