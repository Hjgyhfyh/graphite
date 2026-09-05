import { commands } from '@graphite/bindings';
import type { NoteRef, NoteType, TreeNode } from '@graphite/bindings';

/** Совпадает с потолком `vault_tree` на стороне ядра. */
export const VAULT_TREE_PAGE = 10_000;
const VAULT_TREE_HARD_CAP = 50_000;

export interface VaultTreeAllParams {
  root?: NoteRef;
  depth?: number;
  types?: NoteType[];
}

/**
 * Собирает все страницы `vault_tree`: ядро режет ответ, иначе дерево,
 * крошки и канбан видели бы только первые 500 заметок.
 */
export async function fetchVaultTreeAll(params: VaultTreeAllParams = {}): Promise<TreeNode[]> {
  const seen = new Set<NoteRef>();
  const nodes: TreeNode[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total && nodes.length < VAULT_TREE_HARD_CAP) {
    const page = await commands.vaultTree({
      ...params,
      limit: VAULT_TREE_PAGE,
      offset,
    });
    total = page.total;
    if (page.nodes.length === 0) {
      break;
    }
    for (const node of page.nodes) {
      if (!seen.has(node.ref)) {
        seen.add(node.ref);
        nodes.push(node);
      }
    }
    offset += page.nodes.length;
  }
  return nodes;
}
