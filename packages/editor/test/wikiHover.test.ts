import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { snippetFromBody, wikiLinkAround, wikiLinkAt, wikiLinksInLine } from '../src/wikiHover';

describe('wikiLinksInLine', () => {
  it('находит цель и подпись', () => {
    const hits = wikiLinksInLine('см. [[Проект|план]] и всё');
    expect(hits).toEqual([{ from: 4, to: 19, target: 'Проект', label: 'план' }]);
  });

  it('без палки подпись = цель', () => {
    expect(wikiLinkAt('[[Заметка]]', 3)?.target).toBe('Заметка');
    expect(wikiLinkAt('[[Заметка]]', 3)?.label).toBe('Заметка');
  });

  it('не ловит ссылку внутри инлайн-кода', () => {
    expect(wikiLinksInLine('код `[[нет]]` снаружи [[да]]').map((hit) => hit.target)).toEqual(['да']);
  });

  it('незакрытую скобку игнорирует', () => {
    expect(wikiLinksInLine('[[черновик')).toEqual([]);
  });
});

describe('snippetFromBody', () => {
  it('снимает заголовки и сжимает пробелы', () => {
    expect(snippetFromBody('# Заголовок\n\nпривет   **мир**')).toBe('Заголовок привет мир');
  });

  it('обрезает длинный текст', () => {
    const long = 'слово '.repeat(80);
    const snip = snippetFromBody(long, 40);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip.length).toBeLessThanOrEqual(41);
  });
});

describe('wikiLinkAround', () => {
  it('отдаёт абсолютные смещения в документе', () => {
    const state = EditorState.create({
      doc: 'абзац\nтекст [[Цель]] хвост',
      extensions: [markdown({ base: markdownLanguage })],
    });
    const hit = wikiLinkAround(state, 14);
    expect(hit?.target).toBe('Цель');
    expect(state.sliceDoc(hit?.from ?? 0, hit?.to ?? 0)).toBe('[[Цель]]');
  });
});
