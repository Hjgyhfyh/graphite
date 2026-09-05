import { describe, expect, it } from 'vitest';
import { parseHeadings, pickActiveIndex } from '../src/headings';

describe('pickActiveIndex', () => {
  it('ничего выше верха — нет активного', () => {
    expect(pickActiveIndex([2, 10, 20], 1)).toBeUndefined();
  });

  it('берёт последний заголовок, который уже прошли', () => {
    expect(pickActiveIndex([0, 10, 20], 0)).toBe(0);
    expect(pickActiveIndex([0, 10, 20], 10)).toBe(1);
    expect(pickActiveIndex([0, 10, 20], 15)).toBe(1);
    expect(pickActiveIndex([0, 10, 20], 20)).toBe(2);
    expect(pickActiveIndex([0, 10, 20], 999)).toBe(2);
  });

  it('пустой список', () => {
    expect(pickActiveIndex([], 0)).toBeUndefined();
  });
});

describe('parseHeadings', () => {
  it('номера строк считают frontmatter', () => {
    const src = '---\ntitle: X\n---\n\n# A\n\n## B\n';
    const headings = parseHeadings(src);
    expect(headings.map((h) => ({ text: h.text, line: h.line }))).toEqual([
      { text: 'A', line: 4 },
      { text: 'B', line: 6 },
    ]);
  });
});
