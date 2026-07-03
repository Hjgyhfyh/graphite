import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import { graphiteDark } from './theme';

const external = Annotation.define<boolean>();

export interface CreateEditorOptions {
  initialDoc?: string;
  onChange?: (doc: string) => void;
}

export interface EditorHandle {
  readonly view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  focus(): void;
  destroy(): void;
}

export function createEditor(container: HTMLElement, options: CreateEditorOptions = {}): EditorHandle {
  const { initialDoc = '', onChange } = options;

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || onChange === undefined) {
      return;
    }
    if (update.transactions.some((tr) => tr.annotation(external) !== true)) {
      onChange(update.state.doc.toString());
    }
  });

  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
      graphiteDark,
      updateListener,
    ],
  });

  const view = new EditorView({ state, parent: container });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (doc) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        annotations: external.of(true),
      });
    },
    focus: () => {
      view.focus();
    },
    destroy: () => {
      view.destroy();
    },
  };
}
