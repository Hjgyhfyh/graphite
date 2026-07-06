import { splitFrontmatter } from './frontmatter';
import { parseInline } from './markdown';
import type { MdInline } from './markdown';

export interface MdHeading {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Чистый текст заголовка без инлайн-разметки. */
  readonly text: string;
  /** 0-based номер строки заголовка в полном документе (включая frontmatter). */
  readonly line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([^`]*)$/;

/** Сплющивает инлайн-дерево до видимого текста: разметка отбрасывается, подписи остаются. */
function flattenInline(nodes: readonly MdInline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out += flattenInline(node.children);
        break;
      case 'wikilink':
        out += node.label;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Сканер заголовков для оглавления: H1–H6 тела документа с номерами строк,
 * пригодными для прыжка курсором. Frontmatter пропускается через смещение
 * `bodyLine`, содержимое fenced-блоков не сканируется, инлайн-разметка в
 * тексте заголовка сплющивается до читаемой строки. Никогда не бросает.
 */
export function parseHeadings(source: string): MdHeading[] {
  const split = splitFrontmatter(source);
  const lines = (split?.body ?? source).split('\n');
  const offset = split?.bodyLine ?? 0;
  const out: MdHeading[] = [];

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence !== null) {
      // Закрывающая ограда — тот же символ и длина не короче открывающей
      // (CommonMark); иначе `# строка` внутри код-блока попала бы в список.
      const marker = fence[1][0];
      const closeRe = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      i += 1;
      while (i < n && !closeRe.test(lines[i])) {
        i += 1;
      }
      if (i < n) {
        i += 1;
      }
      continue;
    }

    const heading = HEADING_RE.exec(lines[i]);
    if (heading !== null) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ level, text: flattenInline(parseInline(heading[2])).trim(), line: offset + i });
    }
    i += 1;
  }

  return out;
}
