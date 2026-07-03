import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import { aiTouchField, clearAiTouched, setAiTouched } from './aiTouch';
import { livePreview } from './livePreview';
import { taskCheckboxes } from './taskList';
import { graphiteDark } from './theme';
import { wikiLinkCompletion } from './wikilink';
import type { WikiLinkSource } from './wikilink';

const external = Annotation.define<boolean>();

const AI_CLEAR_DELAY_MS = 1500;

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
      onChange(update.state.sliceDoc());
    }
  });

  const completion: Extension = linkSource !== undefined ? wikiLinkCompletion(linkSource) : autocompletion();

  const readOnlyExtensions: Extension[] = readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];

  const eolExtensions: Extension[] = initialDoc.includes('\r\n')
    ? [EditorState.lineSeparator.of('\r\n')]
    : [];

  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      ...eolExtensions,
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

  let aiClearTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    view,
    getDoc: () => view.state.sliceDoc(),
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
      if (aiClearTimer !== undefined) {
        clearTimeout(aiClearTimer);
      }
      aiClearTimer = setTimeout(() => {
        aiClearTimer = undefined;
        view.dispatch({ effects: clearAiTouched.of(null) });
      }, AI_CLEAR_DELAY_MS);
    },
    focus: () => {
      view.focus();
    },
    destroy: () => {
      if (aiClearTimer !== undefined) {
        clearTimeout(aiClearTimer);
        aiClearTimer = undefined;
      }
      view.destroy();
    },
  };
}
