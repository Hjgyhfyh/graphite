import { autocompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface WikiLinkItem {
  readonly label: string;
  readonly detail?: string;
}

export type WikiLinkSource = (query: string) => readonly WikiLinkItem[];

const OPEN_RE = /\[\[([^\]\n]*)$/;

function applyCompletion(view: EditorView, from: number, to: number, label: string): void {
  const after = view.state.sliceDoc(to, to + 2);
  const hasClose = after === ']]';
  const insert = hasClose ? label : `${label}]]`;
  const caret = from + (hasClose ? label.length + 2 : insert.length);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: caret },
    scrollIntoView: true,
  });
}

function buildSource(source: WikiLinkSource) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(OPEN_RE);
    if (before === null) {
      return null;
    }
    const query = before.text.slice(2);
    if (!context.explicit && query.length === 0 && before.from !== context.pos - 2) {
      return null;
    }
    const items = source(query);
    if (items.length === 0) {
      return null;
    }
    const from = before.from + 2;
    const options: Completion[] = items.map((item) => ({
      label: item.label,
      detail: item.detail,
      type: 'text',
      apply: (view, _completion, applyFrom, applyTo) => {
        applyCompletion(view, applyFrom, applyTo, item.label);
      },
    }));
    return { from, options, validFor: /^[^\]\n]*$/ };
  };
}

/** Autocomplete inside `[[…]]` sourced from the vault; inserts the title and closes the link. */
export function wikiLinkCompletion(source: WikiLinkSource): Extension {
  return autocompletion({
    override: [buildSource(source)],
    activateOnTyping: true,
    closeOnBlur: true,
    icons: false,
  });
}
