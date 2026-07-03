import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/;

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = this.checked ? 'cm-gr-checkbox cm-gr-checkbox-on' : 'cm-gr-checkbox';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    box.innerHTML = this.checked
      ? '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : '';
    const toggle = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const current = view.state.sliceDoc(this.pos, this.pos + 1).toLowerCase();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: current === 'x' ? ' ' : 'x' } });
    };
    box.addEventListener('mousedown', toggle);
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const headLine = doc.lineAt(view.state.selection.main.head).number;

  for (const range of view.visibleRanges) {
    let line = doc.lineAt(range.from);
    for (;;) {
      const match = TASK_RE.exec(line.text);
      if (match !== null && line.number !== headLine) {
        const checked = match[2].toLowerCase() === 'x';
        const bracketFrom = line.from + match[1].length;
        items.push(
          Decoration.replace({ widget: new CheckboxWidget(checked, bracketFrom + 1) }).range(
            bracketFrom,
            bracketFrom + 3,
          ),
        );
        if (checked) {
          items.push(Decoration.line({ class: 'cm-gr-task-done' }).range(line.from));
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
 * Renders `- [ ]` / `- [x]` markers as interactive checkboxes; clicking toggles the single
 * source character. The raw markdown reappears while the caret sits on that line so editing
 * stays direct, and the file is never rewritten beyond the one toggled character.
 */
export const taskCheckboxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);
