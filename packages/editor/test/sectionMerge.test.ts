import { describe, expect, it } from 'vitest';
import { trySectionMerge } from '../src/sectionMerge';

describe('trySectionMerge', () => {
  it('берёт диск, если локальный буфер не менялся', () => {
    expect(trySectionMerge('base', 'base', 'theirs')).toBe('theirs');
  });

  it('берёт буфер, если диск совпадает с базой', () => {
    expect(trySectionMerge('base', 'ours', 'base')).toBe('ours');
  });

  it('сливает два чистых append', () => {
    const base = '# Заметка\nтекст\n';
    const ours = `${base}\nмоя правка\n`;
    const theirs = `${base}\n## Риски\n- зависимость\n`;
    expect(trySectionMerge(base, ours, theirs)).toBe(`${base}\n## Риски\n- зависимость\n\nмоя правка\n`);
  });

  it('сливает правку одной секции и append другой', () => {
    const base = 'вступление\n\n## Цель\nстарая цель\n';
    const ours = 'вступление\n\n## Цель\nновая цель\n';
    const theirs = 'вступление\n\n## Цель\nстарая цель\n\n## Риски\n- один канал\n';
    expect(trySectionMerge(base, ours, theirs)).toBe(
      'вступление\n\n## Цель\nновая цель\n\n## Риски\n- один канал\n',
    );
  });

  it('конфликт в одной секции не сливает молча', () => {
    const base = '## Цель\nстарая\n';
    const ours = '## Цель\nмоя\n';
    const theirs = '## Цель\nчужая\n';
    expect(trySectionMerge(base, ours, theirs)).toBeNull();
  });
});
