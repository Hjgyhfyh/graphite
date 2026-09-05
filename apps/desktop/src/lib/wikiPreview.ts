import { commands } from '@graphite/bindings';
import type { TreeNode } from '@graphite/bindings';
import { snippetFromBody, splitFrontmatter } from '@graphite/editor';
import type { WikiPreview } from '@graphite/editor';
import { useVaultStore } from '../stores/vaultStore';

export function resolveWikiTarget(target: string): TreeNode | undefined {
  const wanted = target.trim().toLowerCase();
  if (wanted.length === 0) {
    return undefined;
  }
  const nodes = useVaultStore.getState().tree;
  return (
    nodes.find((node) => node.title.trim().toLowerCase() === wanted) ??
    nodes.find((node) => node.path.toLowerCase().replace(/\.md$/i, '').endsWith(wanted))
  );
}

export async function loadWikiPreview(target: string): Promise<WikiPreview> {
  const trimmed = target.trim();
  const hit = resolveWikiTarget(trimmed);
  if (hit === undefined) {
    return { title: trimmed, snippet: '', missing: true };
  }
  try {
    const read = await commands.noteRead({ ref: hit.ref, maxChars: 1600 });
    const body = splitFrontmatter(read.content)?.body ?? read.content;
    return { title: hit.title, snippet: snippetFromBody(body), missing: false };
  } catch {
    return { title: hit.title, snippet: '', missing: false };
  }
}
