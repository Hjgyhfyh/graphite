import { splitFrontmatter } from '@graphite/editor';

const WORD_RE = /[\p{L}\p{N}]+/gu;
/** Средняя скорость чтения по-русски. */
const RU_WPM = 180;

export interface NoteStats {
  words: number;
  chars: number;
  readingMin: number;
}

export function noteStats(markdown: string): NoteStats {
  const body = splitFrontmatter(markdown)?.body ?? markdown;
  const stripped = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ');
  const words = stripped.match(WORD_RE)?.length ?? 0;
  const chars = body.replace(/\s+/g, '').length;
  return {
    words,
    chars,
    readingMin: words === 0 ? 0 : Math.max(1, Math.round(words / RU_WPM)),
  };
}
