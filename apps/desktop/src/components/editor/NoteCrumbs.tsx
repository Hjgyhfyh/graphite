import type { MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import type { NoteRef } from '@graphite/bindings';
import { folderNoteRef, noteCrumbs, treeIdForDir } from '../../lib/noteCrumbs';
import { revealInTree } from '../../lib/revealInTree';
import { copyWikiLink, wikiLinkMarkup } from '../../lib/wikiLink';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

export function NoteCrumbs({ noteRef }: { noteRef: NoteRef }) {
  const tree = useVaultStore((s) => s.tree);
  const focusMode = useUiStore((s) => s.focusMode);
  const crumbs = noteCrumbs(noteRef, tree);

  if (focusMode || crumbs.length === 0) {
    return null;
  }

  const openFolder = (dir: string, ref: NoteRef | undefined) => {
    revealInTree(treeIdForDir(dir, tree), dir);
    useVaultStore.getState().openNote(ref ?? folderNoteRef(dir));
  };

  const onFolderClick = (dir: string, ref: NoteRef | undefined, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void copyWikiLink(ref ?? folderNoteRef(dir));
      return;
    }
    openFolder(dir, ref);
  };

  return (
    <nav
      aria-label="Путь заметки"
      className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-stroke-0 bg-bg-1 px-3 text-micro"
    >
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        const folderLink = wikiLinkMarkup(crumb.label);
        return (
          <span key={`${crumb.kind}:${crumb.dir ?? crumb.label}:${index}`} className="flex min-w-0 items-center gap-0.5">
            {index > 0 ? (
              <ChevronRight size={11} strokeWidth={1.75} className="shrink-0 text-text-3" aria-hidden />
            ) : null}
            {last ? (
              <Tooltip content={`Скопировать ${wikiLinkMarkup(crumb.label)}`} side="bottom">
                <button
                  type="button"
                  onClick={() => void copyWikiLink(noteRef)}
                  className="min-w-0 truncate rounded-xs px-1 py-0.5 text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                >
                  {crumb.label}
                </button>
              </Tooltip>
            ) : (
              <Tooltip content={`Открыть папку · Ctrl — скопировать ${folderLink}`} side="bottom">
                <button
                  type="button"
                  onClick={(event) => {
                    if (crumb.dir === undefined) {
                      return;
                    }
                    onFolderClick(crumb.dir, crumb.ref, event);
                  }}
                  className={cx(
                    'max-w-[12rem] truncate rounded-xs px-1 py-0.5 text-text-2 transition-colors duration-[120ms]',
                    'hover:bg-bg-3 hover:text-text-0',
                  )}
                >
                  {crumb.label}
                </button>
              </Tooltip>
            )}
          </span>
        );
      })}
    </nav>
  );
}
