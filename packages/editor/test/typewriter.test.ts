import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { typewriterScroll } from '../src/typewriter';

describe('typewriterScroll', () => {
  it('вешает scrollMargins на состояние редактора', () => {
    const state = EditorState.create({ doc: 'строка\n'.repeat(40), extensions: [typewriterScroll()] });
    expect(state.facet(EditorView.scrollMargins).length).toBeGreaterThan(0);
  });
});
