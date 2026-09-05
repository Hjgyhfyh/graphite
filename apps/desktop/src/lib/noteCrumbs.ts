import type { NoteRef, TreeNode } from '@graphite/bindings';
import { titleFromRef } from '../stores/tabsStore';

const PATH_PREFIX = 'path:';
const INDEX_SUFFIX = '/_index.md';

export interface NoteCrumb {
  label: string;
  kind: 'folder' | 'note';
  /** Относительный путь папки в хранилище — только у folder-крошек. */
  dir?: string;
}

function vaultPath(ref: NoteRef): string {
  const raw = ref.startsWith(PATH_PREFIX) ? ref.slice(PATH_PREFIX.length) : ref;
  return raw.replace(/\\/g, '/');
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Id узла дерева для папки: folder-note, если есть, иначе виртуальная. */
export function treeIdForDir(dir: string, tree: readonly TreeNode[]): string {
  const indexRef = `${PATH_PREFIX}${dir}${INDEX_SUFFIX}`;
  if (tree.some((node) => node.ref === indexRef)) {
    return indexRef;
  }
  return `${PATH_PREFIX}${dir}`;
}

/**
 * Id папок-предков, которые надо раскрыть в дереве, чтобы увидеть `vaultRelPath`.
 * Кладём и `_index.md`, и виртуальный `path:dir` — живой узел будет одним из двух.
 */
export function folderAncestorIds(vaultRelPath: string): string[] {
  let rel = vaultRelPath.replace(/\\/g, '/');
  if (rel.endsWith(INDEX_SUFFIX)) {
    rel = rel.slice(0, -INDEX_SUFFIX.length);
  } else if (rel.toLowerCase().endsWith('.md')) {
    const slash = rel.lastIndexOf('/');
    rel = slash === -1 ? '' : rel.slice(0, slash);
  }
  if (rel.length === 0) {
    return [];
  }
  const parts = rel.split('/').filter((part) => part.length > 0);
  const ids: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc = acc.length === 0 ? part : `${acc}/${part}`;
    ids.push(`${PATH_PREFIX}${acc}${INDEX_SUFFIX}`, `${PATH_PREFIX}${acc}`);
  }
  return ids;
}

/** Крошки пути заметки: папки кликабельны, последняя — сама заметка. */
export function noteCrumbs(ref: NoteRef, tree: readonly TreeNode[]): NoteCrumb[] {
  const rel = vaultPath(ref);
  const isIndex = rel.endsWith(INDEX_SUFFIX);
  const isMd = rel.toLowerCase().endsWith('.md');
  let dir = rel;
  let noteLabel: string | undefined;
  if (isIndex) {
    dir = rel.slice(0, -INDEX_SUFFIX.length);
    noteLabel = tree.find((node) => node.ref === ref)?.title ?? (dir.length > 0 ? baseName(dir) : titleFromRef(ref));
  } else if (isMd) {
    const slash = rel.lastIndexOf('/');
    dir = slash === -1 ? '' : rel.slice(0, slash);
    noteLabel = tree.find((node) => node.ref === ref)?.title ?? titleFromRef(ref);
  } else {
    noteLabel = titleFromRef(ref);
    dir = '';
  }

  const crumbs: NoteCrumb[] = [];
  if (dir.length > 0) {
    const parts = dir.split('/').filter((part) => part.length > 0);
    let acc = '';
    const folderCount = isIndex ? parts.length - 1 : parts.length;
    for (let index = 0; index < folderCount; index += 1) {
      const part = parts[index];
      acc = acc.length === 0 ? part : `${acc}/${part}`;
      const indexRef = `${PATH_PREFIX}${acc}${INDEX_SUFFIX}`;
      const folderNode = tree.find((node) => node.ref === indexRef);
      crumbs.push({ label: folderNode?.title ?? part, kind: 'folder', dir: acc });
    }
  }
  if (noteLabel !== undefined && noteLabel.length > 0) {
    crumbs.push({ label: noteLabel, kind: 'note' });
  }
  return crumbs;
}
