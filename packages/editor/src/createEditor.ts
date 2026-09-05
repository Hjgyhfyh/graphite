import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import { aiTouchField, clearAiTouched, setAiTouched } from './aiTouch';
import { toggleCode, toggleInlineFormat } from './formatting';
import { doneFold } from './doneFold';
import { frontmatterHide } from './frontmatterHide';
import { imageAttachments } from './imageInsert';
import type { AttachmentSaveOptions } from './imageInsert';
import { imagePreviews } from './imagePreview';
import type { ImagePreviewOptions } from './imagePreview';
import { livePreview } from './livePreview';
import { tablePreview } from './tablePreview';
import { tagHighlight } from './tagHighlight';
import { taskCheckboxes } from './taskList';
import { graphiteDark } from './theme';
import { typewriterScroll } from './typewriter';
import { openWikiLinkPicker, wikiLinkCompletion } from './wikilink';
import type { WikiLinkSource } from './wikilink';
import { wikiLinkPreview } from './wikiHover';
import type { WikiPreviewSource } from './wikiHover';

const external = Annotation.define<boolean>();

const AI_CLEAR_DELAY_MS = 1500;

export interface CreateEditorOptions {
  initialDoc?: string;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  linkSource?: WikiLinkSource;
  wikiPreview?: WikiPreviewSource;
  /** Ctrl/Cmd+клик по `[[ссылке]]` и клик по карточке превью. */
  onOpenWiki?: (target: string) => void;
  attachments?: AttachmentSaveOptions;
  images?: ImagePreviewOptions;
  /** Прятать YAML-блок свойств в начале документа (по умолчанию включено). */
  hideFrontmatter?: boolean;
  /** Держать курсор в средней полосе экрана при наборе. */
  typewriter?: boolean;
}

export interface EditorHandle {
  readonly view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  markAi(from: number, to: number): void;
  setHideFrontmatter(hide: boolean): void;
  setTypewriter(on: boolean): void;
  focus(): void;
  destroy(): void;
}

const CHECKBOX_LINE_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

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
  { key: 'Mod-b', preventDefault: true, run: (view) => toggleInlineFormat(view, '**') },
  { key: 'Mod-i', preventDefault: true, run: (view) => toggleInlineFormat(view, '*') },
  { key: 'Mod-Shift-e', preventDefault: true, run: toggleCode },
  { key: 'Mod-Shift-x', preventDefault: true, run: (view) => toggleInlineFormat(view, '~~') },
  { key: 'Mod-l', preventDefault: true, run: openWikiLinkPicker },
  { key: 'Mod-Shift-l', preventDefault: true, run: toggleChecklist },
];

export function createEditor(container: HTMLElement, options: CreateEditorOptions = {}): EditorHandle {
  const {
    initialDoc = '',
    readOnly = false,
    onChange,
    linkSource,
    wikiPreview,
    onOpenWiki,
    attachments,
    images,
    hideFrontmatter = true,
    typewriter = false,
  } = options;

  // Compartment на инстанс: «скрыть/показать свойства» и печатная машинка
  // переключаются на живом редакторе без пересоздания.
  const frontmatterCompartment = new Compartment();
  const typewriterCompartment = new Compartment();

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
      tablePreview,
      tagHighlight,
      ...(wikiPreview !== undefined ? [wikiLinkPreview(wikiPreview, onOpenWiki)] : []),
      frontmatterCompartment.of(hideFrontmatter ? frontmatterHide() : []),
      typewriterCompartment.of(typewriter ? typewriterScroll() : []),
      taskCheckboxes,
      doneFold,
      aiTouchField,
      ...(attachments !== undefined && !readOnly ? [imageAttachments(attachments)] : []),
      ...(images !== undefined ? [imagePreviews(images)] : []),
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
      // Заменяем только реально изменившийся диапазон: выделение и позиция
      // курсора переживают перезагрузку с диска, а скролл не дёргается.
      const prev = view.state.sliceDoc();
      if (prev === doc) {
        return;
      }
      const minLen = Math.min(prev.length, doc.length);
      let start = 0;
      while (start < minLen && prev[start] === doc[start]) {
        start += 1;
      }
      let endPrev = prev.length;
      let endNext = doc.length;
      while (endPrev > start && endNext > start && prev[endPrev - 1] === doc[endNext - 1]) {
        endPrev -= 1;
        endNext -= 1;
      }
      // Строковые индексы → позиции документа: многосимвольный разделитель
      // строк (\r\n) в позициях CodeMirror всегда считается за один символ.
      const sep = view.state.lineBreak;
      const extra = sep.length - 1;
      if (extra > 0) {
        if (prev[start - 1] === '\r' && prev[start] === '\n') {
          start -= 1;
        }
        if (prev[endPrev - 1] === '\r' && prev[endPrev] === '\n') {
          endPrev += 1;
          endNext += 1;
        }
      }
      const sepsBefore = (upto: number): number => {
        if (extra === 0) {
          return 0;
        }
        let count = 0;
        let at = prev.indexOf(sep);
        while (at !== -1 && at < upto) {
          count += 1;
          at = prev.indexOf(sep, at + sep.length);
        }
        return count;
      };
      view.dispatch({
        changes: {
          from: start - sepsBefore(start) * extra,
          to: endPrev - sepsBefore(endPrev) * extra,
          insert: doc.slice(start, endNext),
        },
        annotations: external.of(true),
      });
    },
    setHideFrontmatter: (hide) => {
      view.dispatch({ effects: frontmatterCompartment.reconfigure(hide ? frontmatterHide() : []) });
    },
    setTypewriter: (on) => {
      view.dispatch({ effects: typewriterCompartment.reconfigure(on ? typewriterScroll() : []) });
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
