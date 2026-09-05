export interface GraphFindItem {
  ref: string;
  title: string;
}

export function foldGraphText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

function scoreTitle(query: string, title: string): number | null {
  const q = foldGraphText(query.trim());
  if (q.length === 0) {
    return 0;
  }
  const hay = foldGraphText(title);
  if (hay.startsWith(q)) {
    return 300 - Math.min(hay.length, 80);
  }
  const at = hay.indexOf(q);
  if (at >= 0) {
    return 200 - at;
  }
  let cursor = 0;
  for (let i = 0; i < hay.length && cursor < q.length; i += 1) {
    if (hay[i] === q[cursor]) {
      cursor += 1;
    }
  }
  if (cursor === q.length) {
    return 50 - Math.min(hay.length, 40);
  }
  return null;
}

export function rankGraphHits<T extends GraphFindItem>(
  query: string,
  items: readonly T[],
  limit = 8,
): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = scoreTitle(trimmed, item.title);
    if (score !== null) {
      scored.push({ item, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'ru'));
  return scored.slice(0, limit).map((row) => row.item);
}
