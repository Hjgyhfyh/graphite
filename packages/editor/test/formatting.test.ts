import { describe, expect, it } from 'vitest';
import { hasInlineFormat, inlineFormatState, toggleInlineFormat } from '../src/formatting';
import { makeState, TestView } from './_view';

describe('inlineFormatState / hasInlineFormat', () => {
  it('распознаёт зачёркивание, когда маркеры сразу снаружи выделения', () => {
    const state = makeState('~~struck~~', { anchor: 2, head: 8 });
    expect(hasInlineFormat(state, '~~')).toBe(true);
    expect(inlineFormatState(state)).toEqual({
      strong: false,
      em: false,
      strike: true,
      code: false,
    });
  });

  it('распознаёт зачёркивание, когда выделены и сами маркеры', () => {
    const state = makeState('~~struck~~', { anchor: 0, head: 10 });
    expect(hasInlineFormat(state, '~~')).toBe(true);
  });

  it('на чистом тексте форматов нет', () => {
    const state = makeState('plain text', { anchor: 0, head: 5 });
    expect(inlineFormatState(state)).toEqual({
      strong: false,
      em: false,
      strike: false,
      code: false,
    });
  });

  it('различает жирный, курсив и код (** не читается как *)', () => {
    expect(inlineFormatState(makeState('**bold**', { anchor: 2, head: 6 }))).toMatchObject({
      strong: true,
      em: false,
    });
    expect(inlineFormatState(makeState('*it*', { anchor: 1, head: 3 }))).toMatchObject({
      strong: false,
      em: true,
    });
    expect(inlineFormatState(makeState('`c`', { anchor: 1, head: 2 }))).toMatchObject({
      code: true,
    });
  });
});

describe('toggleInlineFormat — зачёркивание (~~)', () => {
  it('добавляет ~~ вокруг выделения и оставляет его на слове', () => {
    const v = new TestView('hello world', { anchor: 6, head: 11 });
    expect(toggleInlineFormat(v.view, '~~')).toBe(true);
    expect(v.doc).toBe('hello ~~world~~');
    expect(v.range).toEqual({ from: 8, to: 13 });
  });

  it('повторный тоггл снимает ~~ (круговой обход)', () => {
    const v = new TestView('hello world', { anchor: 6, head: 11 });
    toggleInlineFormat(v.view, '~~');
    toggleInlineFormat(v.view, '~~');
    expect(v.doc).toBe('hello world');
    expect(v.range).toEqual({ from: 6, to: 11 });
  });

  it('снимает ~~, когда маркеры сразу снаружи выделения', () => {
    const v = new TestView('~~world~~', { anchor: 2, head: 7 });
    toggleInlineFormat(v.view, '~~');
    expect(v.doc).toBe('world');
    expect(v.range).toEqual({ from: 0, to: 5 });
  });

  it('снимает ~~, когда маркеры внутри выделения', () => {
    const v = new TestView('~~world~~', { anchor: 0, head: 9 });
    toggleInlineFormat(v.view, '~~');
    expect(v.doc).toBe('world');
  });

  it('на пустом выделении вставляет пустую пару ~~ и парковка курсора внутри', () => {
    const v = new TestView('ab', 1);
    toggleInlineFormat(v.view, '~~');
    expect(v.doc).toBe('a~~~~b');
    expect(v.caret).toBe(3);
  });
});

describe('toggleInlineFormat — остальные маркеры', () => {
  it('жирный', () => {
    const v = new TestView('x', { anchor: 0, head: 1 });
    toggleInlineFormat(v.view, '**');
    expect(v.doc).toBe('**x**');
    expect(v.range).toEqual({ from: 2, to: 3 });
  });

  it('курсив', () => {
    const v = new TestView('x', { anchor: 0, head: 1 });
    toggleInlineFormat(v.view, '*');
    expect(v.doc).toBe('*x*');
  });

  it('код', () => {
    const v = new TestView('x', { anchor: 0, head: 1 });
    toggleInlineFormat(v.view, '`');
    expect(v.doc).toBe('`x`');
  });
});

describe('toggleInlineFormat — readOnly', () => {
  it('в readOnly ничего не меняет и возвращает false', () => {
    const v = new TestView('hello', { anchor: 0, head: 5 }, true);
    expect(toggleInlineFormat(v.view, '~~')).toBe(false);
    expect(v.doc).toBe('hello');
  });
});
