import { describe, expect, it } from 'vitest';
import { closesFence, parseFenceOpen } from '../src/fence';

describe('parseFenceOpen / closesFence', () => {
  it('открывает backtick и tilde заборы', () => {
    expect(parseFenceOpen('```js')).toEqual({ marker: '`', length: 3 });
    expect(parseFenceOpen('~~~~')).toEqual({ marker: '~', length: 4 });
    expect(parseFenceOpen('  ```')).toEqual({ marker: '`', length: 3 });
  });

  it('строка с кавычкой в info не считается backtick-забором', () => {
    expect(parseFenceOpen('``` foo ` bar')).toBeNull();
  });

  it('закрывает только тот же маркер не короче открывающего', () => {
    const fence = { marker: '`' as const, length: 4 };
    expect(closesFence('```', fence)).toBe(false);
    expect(closesFence('````', fence)).toBe(true);
    expect(closesFence('~~~~', fence)).toBe(false);
    expect(closesFence('```` leftover', fence)).toBe(false);
  });
});
