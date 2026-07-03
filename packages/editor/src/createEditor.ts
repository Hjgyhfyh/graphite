import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import { aiTouchField, setAiTouched } from './aiTouch';
import { livePreview } from './livePreview';
import { taskCheckboxes } from './taskList';
import { graphiteDark } from './theme';
import { wikiLinkCompletion } from './wikilink';
import type { WikiLinkSource } from './wikilink';

const external = Annotation.define<boolean>();

export interface CreateEditorOptions {
  initialDoc?: string;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  linkSource?: WikiLinkSource;
}

export interface EditorHandle {
  readonly view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  markAi(from: number, to: number): void;
  focus(): void;
  destroy(): void;
}

export function createEditor(container: HTMLElement, options: CreateEditorOptions = {}): EditorHandle {
  const { initialDoc = '', readOnly = false, onChange, linkSource } = options;

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || onChange === undefined) {
      return;
    }
    if (update.transactions.some((tr) => tr.annotation(external) !== true)) {
      onChange(update.state.doc.toString());
    }
  });

  const completion: Extension = linkSource !== undefined ? wikiLinkCompletion(linkSource) : autocompletion();

  const readOnlyExtensions: Extension[] = readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];

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
      completion,
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      livePreview,
      taskCheckboxes,
      aiTouchField,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
      graphiteDark,
      updateListener,
      ...readOnlyExtensions,
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
    markAi: (from, to) => {
      const max = view.state.doc.length;
      const start = Math.max(0, Math.min(from, max));
      const end = Math.max(start, Math.min(to, max));
      view.dispatch({ effects: setAiTouched.of({ from: start, to: end }) });
    },
    focus: () => {
      view.focus();
    },
    destroy: () => {
      view.destroy();
    },
  };
}
