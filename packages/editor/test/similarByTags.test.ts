import { describe, expect, it } from 'vitest';
import { similarNotesByTags } from '../src/similarByTags';

const TAGS = [
  { tag: 'идея', refs: ['path:A.md', 'path:B.md', 'path:C.md'] },
  { tag: 'проект', refs: ['path:A.md', 'path:B.md'] },
  { tag: 'личное', refs: ['path:C.md', 'path:D.md'] },
];

describe('similarNotesByTags', () => {
  it('ранжирует по числу общих тегов', () => {
    const hits = similarNotesByTags('path:A.md', TAGS);
    expect(hits.map((hit) => hit.ref)).toEqual(['path:B.md', 'path:C.md']);
    expect(hits[0].shared).toEqual(['идея', 'проект']);
    expect(hits[1].shared).toEqual(['идея']);
  });

  it('не предлагает саму заметку и exclude', () => {
    const hits = similarNotesByTags('path:A.md', TAGS, { exclude: new Set(['path:B.md']) });
    expect(hits.map((hit) => hit.ref)).toEqual(['path:C.md']);
  });

  it('без тегов у заметки — пусто', () => {
    expect(similarNotesByTags('path:Z.md', TAGS)).toEqual([]);
  });

  it('режет по лимиту', () => {
    const hits = similarNotesByTags('path:A.md', TAGS, { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe('path:B.md');
  });
});
