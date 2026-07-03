import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorSelection, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
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

const CHECKBOX_LINE_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

function wrapSelection(view: EditorView, marker: string): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const width = marker.length;
  view.dispatch({
    ...view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + width, range.to + width),
    })),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

function toggleChecklist(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const task = CHECKBOX_LINE_RE.exec(line.text);
  if (task !== null) {
    const mark = line.from + task[1].length + 1;
    view.dispatch({
      changes: { from: mark, to: mark + 1, insert: task[2].toLowerCase() === 'x' ? ' ' : 'x' },
      userEvent: 'input',
    });
    return true;
  }
  const marker = LIST_MARKER_RE.exec(line.text);
  const insert = marker !== null ? '[ ] ' : '- [ ] ';
  const at = line.from + (marker !== null ? marker[0].length : line.text.length - line.text.trimStart().length);
  const head = state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: head >= at ? head + insert.length : head },
    userEvent: 'input',
  });
  return true;
}

const markdownKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', preventDefault: true, run: (view) => wrapSelection(view, '**') },
  { key: 'Mod-i', preventDefault: true, run: (view) => wrapSelection(view, '*') },
  { key: 'Ctrl-l', preventDefault: true, run: toggleChecklist },
];

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
      keymap.of(markdownKeymap),
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
