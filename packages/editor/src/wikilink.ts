import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface WikiLinkItem {
  readonly label: string;
  readonly detail?: string;
}

export type WikiLinkSource = (query: string) => readonly WikiLinkItem[];

const OPEN_RE = /\[\[([^\]\n]*)$/;
const AT_RE = /@(?!\s)([^@\][\n]*)$/;
const WORD_CH_RE = /[\p{L}\p{N}_]/u;

const CODE_CONTEXT = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText']);

function inCodeContext(state: EditorState, pos: number): boolean {
  const cursor = syntaxTree(state).resolveInner(pos, -1).cursor();
  do {
    if (CODE_CONTEXT.has(cursor.name)) {
      return true;
    }
  } while (cursor.parent());
  return false;
}

function applyWikiLink(view: EditorView, from: number, to: number, label: string): void {
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

function toOptions(items: readonly WikiLinkItem[], apply: (view: EditorView, label: string, from: number, to: number) => void): Completion[] {
  return items.map((item) => ({
    label: item.label,
    detail: item.detail,
    type: 'text',
    apply: (view, _completion, applyFrom, applyTo) => {
      apply(view, item.label, applyFrom, applyTo);
    },
  }));
}

export function buildSource(source: WikiLinkSource) {
  return (context: CompletionContext): CompletionResult | null => {
    const open = context.matchBefore(OPEN_RE);
    if (open !== null) {
      const query = open.text.slice(2);
      if (!context.explicit && query.length === 0 && open.from !== context.pos - 2) {
        return null;
      }
      const items = source(query);
      if (items.length === 0) {
        return null;
      }
      return {
        from: open.from + 2,
        options: toOptions(items, (view, label, from, to) => {
          applyWikiLink(view, from, to, label);
        }),
        validFor: /^[^\]\n]*$/,
      };
    }

    const at = context.matchBefore(AT_RE);
    if (at === null) {
      return null;
    }
    // «@» срабатывает только как самостоятельный триггер: не внутри слова
    // (почта, ник) и не в коде, где собака — обычный символ.
    const before = context.state.sliceDoc(Math.max(0, at.from - 1), at.from);
    if (WORD_CH_RE.test(before) || inCodeContext(context.state, at.from)) {
      return null;
    }
    const query = at.text.slice(1);
    if (!context.explicit && query.length === 0 && at.from !== context.pos - 1) {
      return null;
    }
    const items = source(query);
    if (items.length === 0) {
      return null;
    }
    return {
      from: at.from + 1,
      options: toOptions(items, (view, label, from, to) => {
        const insert = `[[${label}]]`;
        view.dispatch({
          changes: { from: from - 1, to, insert },
          selection: { anchor: from - 1 + insert.length },
          scrollIntoView: true,
        });
      }),
      validFor: /^[^@\][\n]*$/,
    };
  };
}

/**
 * Пикер заметок в тексте: автодополнение внутри `[[…]]` и быстрый триггер `@`,
 * который разворачивает выбранную заметку в готовую `[[ссылку]]`.
 */
export function wikiLinkCompletion(source: WikiLinkSource): Extension {
  return autocompletion({
    override: [buildSource(source)],
    activateOnTyping: true,
    closeOnBlur: true,
    icons: false,
  });
}

/**
 * Команда «Связать заметку» (Ctrl+L и меню выделения): оборачивает выделение в
 * `[[…]]` (или вставляет пустую пару) и сразу открывает пикер заметок; выбор
 * подставляется на место набранного, курсор выходит за `]]`.
 */
export function openWikiLinkPicker(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const range = view.state.selection.main;
  const inner = view.state.sliceDoc(range.from, range.to);
  const wrappable = !range.empty && !inner.includes('\n');
  const from = wrappable ? range.from : range.head;
  const to = wrappable ? range.to : range.head;
  view.dispatch({
    changes: [
      { from, insert: '[[' },
      { from: to, insert: ']]' },
    ],
    selection: EditorSelection.cursor(to + 2),
    scrollIntoView: true,
    userEvent: 'input',
  });
  startCompletion(view);
  return true;
}
