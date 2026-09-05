import { describe, expect, it } from 'vitest';
import { appendCaptureToDoc } from '../src/appendCapture';

describe('appendCaptureToDoc', () => {
  it('пустой документ — только пункт', () => {
    expect(appendCaptureToDoc('', '- 10:00 мысль')).toBe('- 10:00 мысль\n');
  });

  it('к телу добавляет пустую строку и пункт', () => {
    expect(appendCaptureToDoc('# Заметка\n\nтекст', '- 10:00 мысль')).toBe('# Заметка\n\nтекст\n\n- 10:00 мысль\n');
  });

  it('не ломает уже стоящий перевод строки в конце', () => {
    expect(appendCaptureToDoc('тело\n', '- 10:00 мысль')).toBe('тело\n\n- 10:00 мысль\n');
  });
});
