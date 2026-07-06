import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from '../src/markdown';
import type { MdBlock, MdInline } from '../src/markdown';

type Para = Extract<MdBlock, { kind: 'paragraph' }>;
type Code = Extract<MdBlock, { kind: 'code' }>;

/** Плоский текст из инлайн-дерева — достаточно, чтобы проверить содержимое. */
function text(nodes: readonly MdInline[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text' || n.kind === 'code') {
      out += n.value;
    } else if (n.kind === 'wikilink') {
      out += n.label;
    } else if ('children' in n) {
      out += text(n.children);
    }
  }
  return out;
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

describe('parseBlocks — огороженный код (fenced)', () => {
  it('текст после закрывающей ``` — это НЕ код, а абзац', () => {
    const blocks = parseBlocks(lines('```js', 'const x = 1', '```', 'after text'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'js', value: 'const x = 1' });
    expect(blocks[1].kind).toBe('paragraph');
    expect(text((blocks[1] as Para).content)).toBe('after text');
  });

  it('после ограды корректно парсятся заголовок и абзац', () => {
    const blocks = parseBlocks(lines('```', 'code line', '```', '# Heading', 'para'));
    expect(blocks.map((b) => b.kind)).toEqual(['code', 'heading', 'paragraph']);
    expect(blocks[0]).toMatchObject({ kind: 'code', value: 'code line' });
    expect(text((blocks[2] as Para).content)).toBe('para');
  });

  it('более длинная закрывающая ограда закрывает более короткую открывающую', () => {
    const blocks = parseBlocks(lines('```', 'body', '````', 'after'));
    expect(blocks[0]).toMatchObject({ kind: 'code', value: 'body' });
    expect(blocks[1].kind).toBe('paragraph');
    expect(text((blocks[1] as Para).content)).toBe('after');
  });

  it('короткая ограда не закрывает более длинную открывающую', () => {
    const blocks = parseBlocks(lines('````', 'code', '```', 'more', '````', 'end'));
    expect(blocks[0]).toMatchObject({ kind: 'code', value: 'code\n```\nmore' });
    expect(blocks[1].kind).toBe('paragraph');
    expect(text((blocks[1] as Para).content)).toBe('end');
  });

  it('обратные кавычки и тильды не закрывают друг друга', () => {
    const bt = parseBlocks(lines('```', 'x ~~~ y', '```', 'z'));
    expect(bt[0]).toMatchObject({ kind: 'code', value: 'x ~~~ y' });
    expect(bt[1].kind).toBe('paragraph');

    const tl = parseBlocks(lines('~~~', 'a ``` b', '~~~', 'c'));
    expect(tl[0]).toMatchObject({ kind: 'code', value: 'a ``` b' });
    expect(tl[1].kind).toBe('paragraph');
  });

  it('незакрытая ограда поглощает остаток документа', () => {
    const blocks = parseBlocks(lines('```', 'line1', 'line2'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'code', value: 'line1\nline2' });
  });

  it('info-строка задаёт язык; без неё язык не определён', () => {
    expect(parseBlocks(lines('```python', 'x', '```'))[0]).toMatchObject({
      kind: 'code',
      lang: 'python',
    });
    const noLang = parseBlocks(lines('```', 'x', '```'))[0] as Code;
    expect(noLang.kind).toBe('code');
    expect(noLang.lang).toBeUndefined();
  });

  it('закрывающая ограда с хвостовыми пробелами всё равно закрывает', () => {
    const blocks = parseBlocks(lines('```', 'x', '```   ', 'after'));
    expect(blocks[0]).toMatchObject({ kind: 'code', value: 'x' });
    expect(blocks[1].kind).toBe('paragraph');
  });
});

describe('parseInline — зачёркивание и связи', () => {
  it('~~...~~ разбирается в узел del', () => {
    const nodes = parseInline('~~struck~~');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('del');
    expect(text(nodes)).toBe('struck');
  });

  it('зачёркивание в середине строки', () => {
    const nodes = parseInline('a ~~b~~ c');
    const del = nodes.find((n) => n.kind === 'del');
    expect(del).toBeDefined();
    expect(text([del!])).toBe('b');
  });

  it('~~ с пробелом внутри не образует зачёркивание', () => {
    const nodes = parseInline('~~ not del ~~');
    expect(nodes.some((n) => n.kind === 'del')).toBe(false);
  });

  it('зачёркивание вкладывается в жирный текст', () => {
    const nodes = parseInline('**a ~~b~~**');
    expect(nodes[0].kind).toBe('strong');
    expect(text(nodes)).toBe('a b');
  });

  it('[[Note|Alias]] — wikilink с целью и меткой', () => {
    const nodes = parseInline('[[Note|Alias]]');
    expect(nodes[0]).toMatchObject({ kind: 'wikilink', target: 'Note', label: 'Alias' });
  });

  it('[[Note]] — метка совпадает с целью', () => {
    const nodes = parseInline('[[Note]]');
    expect(nodes[0]).toMatchObject({ kind: 'wikilink', target: 'Note', label: 'Note' });
  });
});
