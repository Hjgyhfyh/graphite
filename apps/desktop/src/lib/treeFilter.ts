export interface NamedTreeNode {
  id: string;
  name: string;
  children: NamedTreeNode[] | null;
}

export interface NamePart {
  text: string;
  hit: boolean;
}

/** Нормализованная игла фильтра: trim + нижний регистр. */
export function filterNeedle(query: string): string {
  return query.trim().toLocaleLowerCase('ru');
}

export function nameMatchesFilter(name: string, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  return name.toLocaleLowerCase('ru').includes(needle);
}

/**
 * Какие узлы показать: совпало имя, лежит в совпавшей папке,
 * или среди потомков есть совпадение (чтобы крошки пути не пропадали).
 */
export function collectVisibleIds(nodes: readonly NamedTreeNode[], needle: string): Set<string> {
  const ids = new Set<string>();
  if (needle.length === 0) {
    return ids;
  }
  const walk = (node: NamedTreeNode, ancestorHit: boolean): boolean => {
    const self = nameMatchesFilter(node.name, needle);
    let childHit = false;
    if (node.children !== null) {
      for (const child of node.children) {
        if (walk(child, ancestorHit || self)) {
          childHit = true;
        }
      }
    }
    if (self || ancestorHit || childHit) {
      ids.add(node.id);
    }
    return self || childHit;
  };
  for (const node of nodes) {
    walk(node, false);
  }
  return ids;
}

export function countNameHits(nodes: readonly NamedTreeNode[], needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  const walk = (node: NamedTreeNode) => {
    if (nameMatchesFilter(node.name, needle)) {
      count += 1;
    }
    if (node.children !== null) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  return count;
}

export function highlightNameParts(name: string, needle: string): NamePart[] {
  if (needle.length === 0) {
    return [{ text: name, hit: false }];
  }
  const lower = name.toLocaleLowerCase('ru');
  const parts: NamePart[] = [];
  let from = 0;
  while (from < name.length) {
    const at = lower.indexOf(needle, from);
    if (at < 0) {
      parts.push({ text: name.slice(from), hit: false });
      break;
    }
    if (at > from) {
      parts.push({ text: name.slice(from, at), hit: false });
    }
    parts.push({ text: name.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
    if (needle.length === 0) {
      break;
    }
  }
  return parts.length > 0 ? parts : [{ text: name, hit: false }];
}
