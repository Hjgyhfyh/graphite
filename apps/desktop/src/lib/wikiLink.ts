import type { NoteRef } from '@graphite/bindings';
import { titleFromRef } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';

export function wikiLinkMarkup(title: string, heading?: string): string {
  const name = title.trim();
  const section = heading?.trim();
  if (section !== undefined && section.length > 0) {
    return `[[${name}#${section}]]`;
  }
  return `[[${name}]]`;
}

function titleOf(ref: NoteRef): string {
  const vault = useVaultStore.getState();
  const fromTree = vault.tree.find((item) => item.ref === ref)?.title;
  if (fromTree !== undefined && fromTree.length > 0) {
    return fromTree;
  }
  for (const nodes of Object.values(vault.childrenByRef)) {
    const title = nodes.find((item) => item.ref === ref)?.title;
    if (title !== undefined && title.length > 0) {
      return title;
    }
  }
  return titleFromRef(ref);
}

export async function copyWikiLink(ref: NoteRef, heading?: string): Promise<void> {
  const text = wikiLinkMarkup(titleOf(ref), heading);
  try {
    await navigator.clipboard.writeText(text);
    useUiStore.getState().pushToast({ kind: 'success', text: `Скопировано ${text}` });
  } catch {
    useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось скопировать ссылку' });
  }
}
