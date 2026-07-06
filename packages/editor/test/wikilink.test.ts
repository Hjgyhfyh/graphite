import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import type { Completion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { buildSource, openWikiLinkPicker } from '../src/wikilink';
import { makeState, TestView } from './_view';

const source = () => [{ label: 'Моя заметка', detail: 'заметка' }];

function runApply(opt: Completion, view: EditorView, from: number, to: number): void {
  const apply = opt.apply;
  if (typeof apply !== 'function') {
    throw new Error('у варианта автодополнения нет функции apply');
  }
  apply(view, opt, from, to);
}

describe('openWikiLinkPicker (команда Ctrl+L)', () => {
  it('на пустом выделении вставляет [[ ]] и ставит курсор внутрь', () => {
    const v = new TestView('see ', 4);
    expect(openWikiLinkPicker(v.view)).toBe(true);
    expect(v.doc).toBe('see [[]]');
    expect(v.caret).toBe(6);
  });

  it('оборачивает выделение в [[ ]]', () => {
    const v = new TestView('see Note here', { anchor: 4, head: 8 });
    openWikiLinkPicker(v.view);
    expect(v.doc).toBe('see [[Note]] here');
    expect(v.caret).toBe(10);
  });

  it('не оборачивает выделение через перевод строки — вставляет пустую пару у курсора', () => {
    const v = new TestView('a\nb', { anchor: 0, head: 3 });
    openWikiLinkPicker(v.view);
    expect(v.doc).toBe('a\nb[[]]');
    expect(v.caret).toBe(5);
  });

  it('в readOnly ничего не меняет и возвращает false', () => {
    const v = new TestView('x', 1, true);
    expect(openWikiLinkPicker(v.view)).toBe(false);
    expect(v.doc).toBe('x');
  });
});

describe('пикер связей — источник автодополнения (@ и [[)', () => {
  it('@ разворачивает выбранную заметку в готовую [[ссылку]]', () => {
    const src = buildSource(source);
    const res = src(new CompletionContext(makeState('@мо', 3), 3, false));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(1);
    const opts = res!.options as Completion[];
    expect(opts.map((o) => o.label)).toEqual(['Моя заметка']);

    const v = new TestView('@мо', 3);
    runApply(opts[0], v.view, 1, 3);
    expect(v.doc).toBe('[[Моя заметка]]');
    expect(v.caret).toBe(15);
  });

  it('@ не срабатывает внутри слова (почта/ник)', () => {
    const src = buildSource(source);
    expect(src(new CompletionContext(makeState('mail@do', 7), 7, false))).toBeNull();
  });

  it('внутри [[…]] автодополняет заметку и закрывает скобки', () => {
    const src = buildSource(source);
    const res = src(new CompletionContext(makeState('[[Mo', 4), 4, false));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(2);
    const opts = res!.options as Completion[];

    const v = new TestView('[[Mo', 4);
    runApply(opts[0], v.view, 2, 4);
    expect(v.doc).toBe('[[Моя заметка]]');
    expect(v.caret).toBe(15);
  });

  it('пустой источник — автодополнения нет', () => {
    const src = buildSource(() => []);
    expect(src(new CompletionContext(makeState('@x', 2), 2, false))).toBeNull();
  });
});
