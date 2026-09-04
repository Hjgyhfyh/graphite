import { closesFence, parseFenceOpen } from './fence';
import type { OpenFence } from './fence';

const HEADING_RE = /^(#{1,6})\s+/;

interface Section {
  readonly key: string;
  readonly body: string;
}

/**
 * Режет документ на секции по ATX-заголовкам, не заглядывая внутрь код-заборов.
 * Преамбула (текст до первого заголовка, включая frontmatter) — секция с пустым ключом.
 */
export function splitSections(source: string): Section[] {
  const lines = source.split('\n');
  const chunks: { key: string; lines: string[] }[] = [{ key: '', lines: [] }];
  let current = chunks[0];
  let openFence: OpenFence | undefined;

  for (const line of lines) {
    if (openFence !== undefined) {
      current.lines.push(line);
      if (closesFence(line, openFence)) {
        openFence = undefined;
      }
      continue;
    }
    const fence = parseFenceOpen(line);
    if (fence !== null) {
      openFence = fence;
      current.lines.push(line);
      continue;
    }
    if (HEADING_RE.test(line) && current.lines.length > 0) {
      current = { key: line.trim(), lines: [line] };
      chunks.push(current);
      continue;
    }
    if (current.lines.length === 0 && HEADING_RE.test(line)) {
      current.key = line.trim();
    }
    current.lines.push(line);
  }

  return chunks.map((chunk) => ({ key: chunk.key, body: chunk.lines.join('\n') }));
}

function mergeBodies(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) {
    return ours;
  }
  if (ours === base) {
    return theirs;
  }
  return null;
}

function joinBodies(parts: readonly string[]): string {
  return parts.join('\n');
}

/**
 * Тихий 3-way merge буфера редактора с диском: непересекающиеся секции и чистые
 * append сливаются, пересечение по одной секции — `null` (нужна панель конфликта).
 */
export function trySectionMerge(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) {
    return ours;
  }
  if (ours === base) {
    return theirs;
  }

  if (ours.startsWith(base) && theirs.startsWith(base)) {
    const ourTail = ours.slice(base.length);
    const theirTail = theirs.slice(base.length);
    if (ourTail.length === 0) {
      return theirs;
    }
    if (theirTail.length === 0) {
      return ours;
    }
    if (ourTail === theirTail) {
      return ours;
    }
    const glue =
      theirTail.endsWith('\n') || ourTail.startsWith('\n') || theirTail.length === 0 || ourTail.length === 0
        ? ''
        : '\n';
    return base + theirTail + glue + ourTail;
  }

  const baseParts = splitSections(base);
  const oursParts = splitSections(ours);
  const theirsParts = splitSections(theirs);
  const shared = Math.min(baseParts.length, oursParts.length, theirsParts.length);
  const out: string[] = [];
  let index = 0;
  for (; index < shared; index += 1) {
    if (oursParts[index].key !== baseParts[index].key || theirsParts[index].key !== baseParts[index].key) {
      break;
    }
    const merged = mergeBodies(baseParts[index].body, oursParts[index].body, theirsParts[index].body);
    if (merged === null) {
      return null;
    }
    out.push(merged);
  }

  const baseRest = baseParts.slice(index);
  const oursRest = oursParts.slice(index);
  const theirsRest = theirsParts.slice(index);

  if (baseRest.length === 0) {
    const ourKeys = new Set(oursRest.map((part) => part.key).filter((key) => key.length > 0));
    for (const part of theirsRest) {
      if (part.key.length > 0 && ourKeys.has(part.key)) {
        return null;
      }
    }
    out.push(...theirsRest.map((part) => part.body));
    out.push(...oursRest.map((part) => part.body));
    return joinBodies(out);
  }

  const baseRestText = joinBodies(baseRest.map((part) => part.body));
  const oursRestText = joinBodies(oursRest.map((part) => part.body));
  const theirsRestText = joinBodies(theirsRest.map((part) => part.body));
  if (oursRestText === baseRestText) {
    out.push(...theirsRest.map((part) => part.body));
    return joinBodies(out);
  }
  if (theirsRestText === baseRestText) {
    out.push(...oursRest.map((part) => part.body));
    return joinBodies(out);
  }
  return null;
}
