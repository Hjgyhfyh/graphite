import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

const lineDeco = (cls: string): Decoration => Decoration.line({ class: cls });
const markDeco = (cls: string): Decoration => Decoration.mark({ class: cls });

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const COPY_RESET_MS = 1600;

/** Кнопка «скопировать код» в правом углу открывающей ограды блока. */
class CopyCodeWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  eq(other: CopyCodeWidget): boolean {
    return other.code === this.code;
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-gr-copy';
    button.title = 'Скопировать код';
    button.setAttribute('aria-label', 'Скопировать код');
    button.innerHTML = COPY_ICON;
    let reset: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard
        .writeText(this.code)
        .then(() => {
          button.classList.add('cm-gr-copy-done');
          button.innerHTML = CHECK_ICON;
          if (reset !== undefined) {
            clearTimeout(reset);
          }
          reset = setTimeout(() => {
            reset = undefined;
            if (button.isConnected) {
              button.classList.remove('cm-gr-copy-done');
              button.innerHTML = COPY_ICON;
            }
          }, COPY_RESET_MS);
        })
        .catch(() => undefined);
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

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
const STRIKE = markDeco('cm-gr-strike');
const CODE = markDeco('cm-gr-code');
const LINK = markDeco('cm-gr-link');
const LIST_MARK = markDeco('cm-gr-list-mark');
const QUOTE_LINE = lineDeco('cm-gr-quote');
const FENCE_LINE = lineDeco('cm-gr-fence');
const FENCE_OPEN = lineDeco('cm-gr-fence-open');
const FENCE_CLOSE = lineDeco('cm-gr-fence-close');
const HR_LINE = lineDeco('cm-gr-hr');
const FRONTMATTER_LINE = lineDeco('cm-gr-frontmatter');

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
          case 'CodeInfo':
          case 'QuoteMark':
          case 'LinkMark':
          case 'StrikethroughMark':
          case 'URL':
            pushMark(node.from, node.to, MARK_DIM);
            break;
          case 'StrongEmphasis':
            pushMark(node.from, node.to, STRONG);
            break;
          case 'Emphasis':
            pushMark(node.from, node.to, EM);
            break;
          case 'Strikethrough':
            pushMark(node.from, node.to, STRIKE);
            break;
          case 'InlineCode':
            pushMark(node.from, node.to, CODE);
            break;
          case 'FencedCode': {
            pushLines(node.from, node.to, FENCE_LINE);
            const openLine = doc.lineAt(node.from);
            const lastLine = doc.lineAt(node.to);
            items.push(FENCE_OPEN.range(openLine.from));
            items.push(FENCE_CLOSE.range(lastLine.from));
            // Тело блока — между оградами; у незакрытого блока нижней ограды нет.
            const closed = node.node.getChildren('CodeMark').length >= 2;
            const codeFrom = Math.min(openLine.to + 1, node.to);
            const codeTo = closed ? Math.max(codeFrom, lastLine.from - 1) : node.to;
            if (codeTo > codeFrom) {
              items.push(
                Decoration.widget({
                  widget: new CopyCodeWidget(doc.sliceString(codeFrom, codeTo)),
                  side: 1,
                }).range(openLine.to),
              );
            }
            break;
          }
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
      // Разбор markdown асинхронный: сравнение деревьев ловит транзакции его
      // дозревания, иначе граница fenced-блока остаётся протухшей и текст после
      // закрывающих ``` продолжает выглядеть кодом.
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
