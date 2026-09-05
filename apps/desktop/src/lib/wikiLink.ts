import type { NoteRef } from '@graphite/bindings';
import { titleFromRef } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';

export function wikiLinkMarkup(title: string): string {
  return `[[${title.trim()}]]`;
}

export async function copyWikiLink(ref: NoteRef): Promise<void> {
  const node = useVaultStore.getState().tree.find((item) => item.ref === ref);
  const text = wikiLinkMarkup(node?.title ?? titleFromRef(ref));
  try {
    await navigator.clipboard.writeText(text);
    useUiStore.getState().pushToast({ kind: 'success', text: `Скопировано ${text}` });
  } catch {
    useUiStore.getState().pushToast({ kind: 'error', text: 'Не удалось скопировать ссылку' });
  }
}
