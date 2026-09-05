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
  await copyMarkup(wikiLinkMarkup(titleOf(ref), heading), 'Не удалось скопировать ссылку');
}

export async function copyTag(tag: string): Promise<void> {
  const name = tag.trim().replace(/^#+/, '');
  if (name.length === 0) {
    return;
  }
  await copyMarkup(`#${name}`, 'Не удалось скопировать тег');
}

async function copyMarkup(text: string, fail: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useUiStore.getState().pushToast({ kind: 'success', text: `Скопировано ${text}` });
  } catch {
    useUiStore.getState().pushToast({ kind: 'error', text: fail });
  }
}
