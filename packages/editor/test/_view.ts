import { EditorSelection, EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type SelInput = number | { anchor: number; head?: number };

export function makeState(doc: string, sel?: SelInput, readOnly = false): EditorState {
  const selection =
    sel === undefined
      ? undefined
      : typeof sel === 'number'
        ? EditorSelection.cursor(sel)
        : EditorSelection.range(sel.anchor, sel.head ?? sel.anchor);
  return EditorState.create({
    doc,
    selection,
    extensions: readOnly ? [EditorState.readOnly.of(true)] : [],
  });
}

/**
 * Замена EditorView для юнит-тестов команд редактора: держит EditorState и
 * применяет dispatch ровно как настоящий вью — прогоняя спеку транзакции через
 * state.update. Этого хватает всему, что команде нужно от вью (state + dispatch),
 * и не требует DOM.
 */
export class TestView {
  state: EditorState;

  constructor(doc: string, sel?: SelInput, readOnly = false) {
    this.state = makeState(doc, sel, readOnly);
  }

  readonly dispatch = (spec: TransactionSpec): void => {
    this.state = this.state.update(spec).state;
  };

  get view(): EditorView {
    return this as unknown as EditorView;
  }

  get doc(): string {
    return this.state.doc.toString();
  }

  get caret(): number {
    return this.state.selection.main.head;
  }

  get range(): { from: number; to: number } {
    const r = this.state.selection.main;
    return { from: r.from, to: r.to };
  }
}
