import type { NoteRef } from '@graphite/bindings';

const MIN_LEN = 3;
const GENERIC = /^(новая заметка|без названия|untitled|new note)$/iu;

export interface MentionHit {
  readonly ref: NoteRef;
  readonly title: string;
  readonly snippet: string;
}

export function mentionNeedle(title: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed.length < MIN_LEN || GENERIC.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** Поисковые хиты минус сама заметка и уже связанные входящими ссылками. */
export function pickUnlinkedMentions(
  hits: readonly { ref: NoteRef; title: string; snippets: readonly string[] }[],
  self: NoteRef,
  linkedFrom: ReadonlySet<string>,
): MentionHit[] {
  const out: MentionHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.ref === self || linkedFrom.has(hit.ref) || seen.has(hit.ref)) {
      continue;
    }
    seen.add(hit.ref);
    const snippet = hit.snippets.find((item) => item.trim().length > 0)?.replace(/\s+/g, ' ').trim() ?? '';
    out.push({ ref: hit.ref, title: hit.title, snippet });
  }
  return out;
}
