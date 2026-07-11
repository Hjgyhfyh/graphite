import { describe, expect, it } from 'vitest';
import { findInlineTags } from '../src/tagHighlight';

/** Текст найденных диапазонов — так проверяются и границы, и содержимое. */
function tags(text: string): string[] {
  return findInlineTags(text).map((range) => text.slice(range.from, range.to));
}

describe('findInlineTags — зеркало правил ядра', () => {
  it('простой, вложенный и латинский теги', () => {
    expect(tags('Простой #тег, вложенный #вложенный/тег, латинский #tag-mix_2.')).toEqual([
      '#тег',
      '#вложенный/тег',
      '#tag-mix_2',
    ]);
  });

  it('чисто цифровой кандидат — не тег', () => {
    expect(tags('Число #2026 не тег')).toEqual([]);
    expect(tags('а #2026год — тег')).toEqual(['#2026год']);
  });

  it('слово вплотную и повторная решётка не начинают тег', () => {
    expect(tags('слово#нет не тег')).toEqual([]);
    expect(tags('##нет и # тоже')).toEqual([]);
  });

  it('внутри wiki-ссылки тега нет', () => {
    expect(tags('В ссылке [[Тема#Палитра]] тега нет, а #рядом — есть')).toEqual(['#рядом']);
  });

  it('тег обрезается по недопустимому символу', () => {
    expect(tags('#тег.')).toEqual(['#тег']);
  });
});
