import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { tablePreview } from '../src/tablePreview';

function makeState(doc: string, at?: number): EditorState {
  return EditorState.create({
    doc,
    selection: at === undefined ? undefined : EditorSelection.cursor(at),
    extensions: [tablePreview],
  });
}

/** Диапазоны блочных виджетов-таблиц, которые поле отдало в EditorView.decorations. */
function tableRanges(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const value of state.facet(EditorView.decorations)) {
    if (typeof value === 'function') {
      continue;
    }
    const cursor = value.iter();
    while (cursor.value !== null) {
      out.push({ from: cursor.from, to: cursor.to });
      cursor.next();
    }
  }
  return out;
}

const DOC = 'пред\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nпосле\n';

describe('tablePreview: обнаружение и границы', () => {
  it('рендерит таблицу блочным виджетом, когда курсор вне её строк', () => {
    const state = makeState(DOC, 0);
    const ranges = tableRanges(state);
    expect(ranges).toHaveLength(1);
    const doc = state.doc;
    expect(ranges[0]).toEqual({ from: doc.line(3).from, to: doc.line(5).to });
  });

  it('возвращает сырой markdown, когда выделение на строке таблицы', () => {
    const at = EditorState.create({ doc: DOC }).doc.line(4).from + 1;
    expect(tableRanges(makeState(DOC, at))).toHaveLength(0);
  });

  it('курсор строкой выше таблицы её не раскрывает', () => {
    expect(tableRanges(makeState(DOC, 0))).toHaveLength(1);
  });

  it('таблица внутри код-забора не рендерится', () => {
    const doc = '```\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n';
    expect(tableRanges(makeState(doc, doc.length))).toHaveLength(0);
  });

  it('чужой маркер не закрывает код-забор', () => {
    const doc = '```md\nкод\n~~~\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n';
    expect(tableRanges(makeState(doc, doc.length))).toHaveLength(0);
  });

  it('короткий маркер не закрывает более длинный код-забор', () => {
    const doc = '````md\nкод\n```\n| A | B |\n|---|---|\n| 1 | 2 |\n````\n';
    expect(tableRanges(makeState(doc, doc.length))).toHaveLength(0);
  });

  it('закрывающий маркер с хвостом остаётся содержимым код-забора', () => {
    const doc = '```md\n``` не закрытие\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n';
    expect(tableRanges(makeState(doc, doc.length))).toHaveLength(0);
  });

  it('строки-свойства frontmatter не превращаются в таблицу', () => {
    const doc = '---\ntitle: x\ntags: a\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const ranges = tableRanges(makeState(doc, 0));
    expect(ranges).toHaveLength(1);
    const line = makeState(doc, 0).doc.line(6);
    expect(ranges[0].from).toBe(line.from);
  });

  it('пересчитывает границы после дописанной строки', () => {
    const doc = 'x\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const state = makeState(doc, 0);
    const before = tableRanges(state)[0];
    const insertAt = state.doc.line(5).to;
    const grown = state.update({ changes: { from: insertAt, insert: '\n| 3 | 4 |' } }).state;
    const after = tableRanges(grown)[0];
    expect(after.to).toBeGreaterThan(before.to);
    expect(after.to).toBe(grown.doc.line(6).to);
  });

  it('незакрытый разделитель без «|» не даёт ложной таблицы', () => {
    const doc = 'заголовок\n---\nтекст\n';
    expect(tableRanges(makeState(doc, doc.length))).toHaveLength(0);
  });
});
