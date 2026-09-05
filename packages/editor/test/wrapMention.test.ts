import { describe, expect, it } from 'vitest';
import { wrapPlainMention } from '../src/wrapMention';

function apply(doc: string, title: string): string | undefined {
  const hit = wrapPlainMention(doc, title);
  if (hit === undefined) {
    return undefined;
  }
  const parts = doc.split(hit.oldString);
  expect(parts).toHaveLength(2);
  return `${parts[0]}${hit.newString}${parts[1]}`;
}

describe('wrapPlainMention', () => {
  it('оборачивает первое голое имя', () => {
    expect(apply('см. Цель в тексте', 'Цель')).toBe('см. [[Цель]] в тексте');
  });

  it('не трогает YAML, только тело', () => {
    const doc = '---\ntitle: Цель\n---\n\nпро цель дальше';
    expect(apply(doc, 'Цель')).toBe('---\ntitle: Цель\n---\n\nпро [[Цель]] дальше');
  });

  it('пропускает уже готовую вики-ссылку', () => {
    expect(apply('см. [[Цель]] ещё', 'Цель')).toBeUndefined();
  });

  it('пропускает инлайн-код и забор', () => {
    expect(apply('код `Цель` и ```\nЦель\n```', 'Цель')).toBeUndefined();
    expect(apply('код `Цель` снаружи Цель', 'Цель')).toBe('код `Цель` снаружи [[Цель]]');
  });

  it('не режет слово-продолжение', () => {
    expect(apply('котлета и кот', 'кот')).toBe('котлета и [[кот]]');
    expect(apply('котлета без пробела', 'кот')).toBeUndefined();
  });

  it('расширяет контекст, если имя встречается дважды', () => {
    expect(apply('см. Цель и ещё Цель', 'Цель')).toBe('см. [[Цель]] и ещё Цель');
  });

  it('ищет без учёта регистра, в скобки кладёт канон', () => {
    expect(apply('про графит дальше', 'Графит')).toBe('про [[Графит]] дальше');
  });
});
