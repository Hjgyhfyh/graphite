import { folderAncestorIds } from './noteCrumbs';
import { useTreeStateStore } from '../stores/treeStateStore';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';
import { vaultKey } from '../stores/vaultsStore';

/** Раскрывает предков, показывает дерево и просит панель прокрутить к узлу. */
export function revealInTree(targetId: string, vaultRelPath: string): void {
  const root = useVaultStore.getState().info?.root;
  if (root !== undefined) {
    const key = vaultKey(root);
    const extra = folderAncestorIds(vaultRelPath);
    const current = useTreeStateStore.getState().getExpanded(key);
    useTreeStateStore.getState().setExpanded(key, [...current, ...extra]);
  }
  useUiStore.getState().requestTreeReveal(targetId);
}
