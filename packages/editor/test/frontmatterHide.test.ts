import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { frontmatterHide } from '../src/frontmatterHide';

const FM_DOC = '---\ntitle: Тест\ntags: [a, b]\n---\nТело заметки\nвторая строка\n';
const BODY_AT = FM_DOC.indexOf('Тело');

function makeState(doc: string, at?: number): EditorState {
  return EditorState.create({
    doc,
    selection: at === undefined ? undefined : EditorSelection.cursor(at),
    extensions: [frontmatterHide()],
  });
}

function hiddenRange(state: EditorState): { from: number; to: number } | null {
  for (const value of state.facet(EditorView.decorations)) {
    if (typeof value === 'function') {
      continue;
    }
    const cursor = value.iter();
    if (cursor.value !== null) {
      return { from: cursor.from, to: cursor.to };
    }
  }
  return null;
}

describe('frontmatterHide: декорация', () => {
  it('прячет блок целиком вместе с переносом после закрывающего ---', () => {
    const state = makeState(FM_DOC, BODY_AT);
    expect(hiddenRange(state)).toEqual({ from: 0, to: BODY_AT });
  });

  it('документ без frontmatter не трогает', () => {
    const state = makeState('Просто текст\nбез свойств\n');
    expect(hiddenRange(state)).toBeNull();
    const tr = state.update({ selection: EditorSelection.cursor(0) });
    expect(tr.state.selection.main.head).toBe(0);
  });

  it('прячет frontmatter без перевода строки в конце документа', () => {
    const doc = '---\ntitle: x\n---';
    const state = makeState(doc, doc.length);
    expect(hiddenRange(state)).toEqual({ from: 0, to: doc.length });
  });

  it('пересчитывает границы после правки документа', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const grown = state.update({ changes: { from: 4, insert: 'status: done\n' } }).state;
    expect(hiddenRange(grown)).toEqual({ from: 0, to: BODY_AT + 'status: done\n'.length });
    const broken = state.update({ changes: { from: 0, insert: 'x' } }).state;
    expect(hiddenRange(broken)).toBeNull();
  });

  it('считает перенос при CRLF за одну позицию', () => {
    const state = EditorState.create({
      doc: '---\r\ntitle: x\r\n---\r\nbody',
      extensions: [EditorState.lineSeparator.of('\r\n'), frontmatterHide()],
    });
    const bodyFrom = state.doc.line(4).from;
    expect(hiddenRange(state)).toEqual({ from: 0, to: bodyFrom });
    const tr = state.update({ selection: EditorSelection.cursor(2) });
    expect(tr.state.selection.main.head).toBe(bodyFrom);
  });
});

describe('frontmatterHide: курсор и выделение', () => {
  it('программный курсор внутри скрытой зоны выталкивается на границу', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({ selection: EditorSelection.cursor(0) });
    expect(tr.state.selection.main.anchor).toBe(BODY_AT);
    expect(tr.state.selection.main.head).toBe(BODY_AT);
  });

  it('выделить всё — значит выделить только видимый текст', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({ selection: EditorSelection.single(0, FM_DOC.length) });
    expect(tr.state.selection.main.from).toBe(BODY_AT);
    expect(tr.state.selection.main.to).toBe(FM_DOC.length);
  });

  it('выделение целиком в видимой части не меняется', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({ selection: EditorSelection.single(BODY_AT + 2, BODY_AT + 6) });
    expect(tr.state.selection.main.anchor).toBe(BODY_AT + 2);
    expect(tr.state.selection.main.head).toBe(BODY_AT + 6);
  });
});

describe('frontmatterHide: правки через границу', () => {
  it('удаление, дотянувшееся до скрытой зоны, гасится', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({
      changes: { from: 0, to: BODY_AT, insert: '' },
      userEvent: 'delete.backward',
    });
    expect(tr.docChanged).toBe(false);
    expect(tr.state.doc.toString()).toBe(FM_DOC);
  });

  it('удаление в видимой части проходит', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({
      changes: { from: BODY_AT, to: BODY_AT + 5, insert: '' },
      userEvent: 'delete.forward',
    });
    expect(tr.docChanged).toBe(true);
  });

  it('внешняя правка свойств (без userEvent) проходит', () => {
    const state = makeState(FM_DOC, BODY_AT);
    const tr = state.update({ changes: { from: 4, insert: 'status: done\n' } });
    expect(tr.docChanged).toBe(true);
    expect(tr.state.selection.main.head).toBe(BODY_AT + 'status: done\n'.length);
  });
});
