import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, sweepDoneTasks, sweepLinesDone } from '../src/markdown';
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

describe('parseInline — теги (зеркало правил ядра)', () => {
  it('простой, вложенный и латинский теги распознаются', () => {
    expect(parseInline('#тег')).toEqual([{ kind: 'tag', value: 'тег' }]);
    const nodes = parseInline('вложенный #вложенный/тег и #tag-mix_2');
    expect(nodes).toContainEqual({ kind: 'tag', value: 'вложенный/тег' });
    expect(nodes).toContainEqual({ kind: 'tag', value: 'tag-mix_2' });
  });

  it('число и слово вплотную — не теги', () => {
    expect(parseInline('Число #2026 не тег').some((n) => n.kind === 'tag')).toBe(false);
    expect(parseInline('слово#нет не тег').some((n) => n.kind === 'tag')).toBe(false);
  });

  it('внутри инлайн-кода и wiki-ссылки тегов нет', () => {
    expect(parseInline('в коде `#нет` тоже').some((n) => n.kind === 'tag')).toBe(false);
    expect(parseInline('в ссылке [[Тема#Палитра]] нет').some((n) => n.kind === 'tag')).toBe(false);
  });

  it('тег обрезается по недопустимому символу', () => {
    expect(parseInline('#тег.')).toEqual([
      { kind: 'tag', value: 'тег' },
      { kind: 'text', value: '.' },
    ]);
  });
});

describe('sweepDoneTasks — уборка сделанного в «Готово»', () => {
  it('переносит выполненный пункт с вложенными строками и создаёт секцию', () => {
    const res = sweepDoneTasks('# План\n\n- [x] сделано ^t-a1\n  - заметка\n- [ ] в работе\n', '2026-07-12');
    expect(res).not.toBeNull();
    expect(res!.moved).toBe(1);
    expect(res!.text).toBe(
      '# План\n\n- [ ] в работе\n\n## Готово\n### 2026-07-12\n- [x] сделано ^t-a1\n  - заметка\n',
    );
  });

  it('пункт с невыполненным дочерним чекбоксом остаётся на месте', () => {
    expect(sweepDoneTasks('- [x] верх\n  - [ ] хвост\n')).toBeNull();
    expect(sweepDoneTasks('- [x] верх\n  - [/] в работе\n')).toBeNull();
  });

  it('чекбоксы в код-заборе и в секции «Готово» не двигаются', () => {
    expect(sweepDoneTasks('```\n- [x] в коде\n```\n')).toBeNull();
    expect(sweepDoneTasks('## Готово\n- [x] уже там\n')).toBeNull();
  });

  it('дописывает в конец существующей секции без дубля дневного подзаголовка', () => {
    const res = sweepDoneTasks(
      '- [x] новое\n\n## Готово\n### 2026-07-12\n- [x] старое\n\n## Дальше\nтекст\n',
      '2026-07-12',
    );
    expect(res!.text).toBe('## Готово\n### 2026-07-12\n- [x] старое\n- [x] новое\n\n## Дальше\nтекст\n');
  });

  it('frontmatter не сканируется, CRLF исходника сохраняется', () => {
    const res = sweepDoneTasks('---\r\ntype: plan\r\n---\r\n\r\n- [x] дело\r\n');
    expect(res).not.toBeNull();
    expect(res!.text).toBe('---\r\ntype: plan\r\n---\r\n\r\n## Готово\r\n- [x] дело\r\n');
  });

  it('без выполненных пунктов возвращает null', () => {
    expect(sweepDoneTasks('- [ ] дело\nпросто текст\n')).toBeNull();
  });
});

describe('sweepLinesDone — уборка произвольного выделения в «Готово»', () => {
  it('переносит выделенные строки обычного текста как есть', () => {
    const src = '# План\n\n1 - первое дело\n2 - второе дело\n3 - ещё в работе\n';
    const res = sweepLinesDone(src, 2, 3, '2026-07-12');
    expect(res).not.toBeNull();
    expect(res!.moved).toBe(2);
    expect(res!.text).toBe(
      '# План\n\n3 - ещё в работе\n\n## Готово\n### 2026-07-12\n1 - первое дело\n2 - второе дело\n',
    );
  });

  it('строки внутри секции «Готово» не двигаются', () => {
    expect(sweepLinesDone('## Готово\nуже там\n', 0, 1)).toBeNull();
  });

  it('пустое выделение возвращает null', () => {
    expect(sweepLinesDone('текст\n\n\n', 1, 2)).toBeNull();
  });
});
