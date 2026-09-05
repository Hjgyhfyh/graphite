export interface TagNoteBucket {
  readonly tag: string;
  readonly refs: readonly string[];
}

export interface SimilarByTagsHit {
  readonly ref: string;
  readonly shared: readonly string[];
}

const DEFAULT_LIMIT = 8;

/**
 * Заметки с пересечением тегов: больше общих тегов — выше.
 * Саму заметку и `exclude` (уже связанные) не предлагаем.
 */
export function similarNotesByTags(
  noteRef: string,
  tags: readonly TagNoteBucket[],
  options?: { exclude?: ReadonlySet<string>; limit?: number },
): SimilarByTagsHit[] {
  if (noteRef.length === 0) {
    return [];
  }
  const mine: string[] = [];
  for (const bucket of tags) {
    if (bucket.tag.length === 0) {
      continue;
    }
    if (bucket.refs.includes(noteRef)) {
      mine.push(bucket.tag);
    }
  }
  if (mine.length === 0) {
    return [];
  }
  const mineSet = new Set(mine);
  const exclude = options?.exclude;
  const sharedByRef = new Map<string, string[]>();
  for (const bucket of tags) {
    if (!mineSet.has(bucket.tag)) {
      continue;
    }
    for (const ref of bucket.refs) {
      if (ref === noteRef || (exclude !== undefined && exclude.has(ref))) {
        continue;
      }
      const list = sharedByRef.get(ref);
      if (list === undefined) {
        sharedByRef.set(ref, [bucket.tag]);
      } else if (!list.includes(bucket.tag)) {
        list.push(bucket.tag);
      }
    }
  }
  const limit = options?.limit ?? DEFAULT_LIMIT;
  return [...sharedByRef.entries()]
    .map(([ref, shared]) => ({
      ref,
      shared: [...shared].sort((a, b) => a.localeCompare(b, 'ru')),
    }))
    .sort((a, b) => {
      const byCount = b.shared.length - a.shared.length;
      if (byCount !== 0) {
        return byCount;
      }
      return a.ref.localeCompare(b.ref);
    })
    .slice(0, Math.max(0, limit));
}
