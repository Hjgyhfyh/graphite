import { Fragment, Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  FileWarning,
  FolderOpen,
  LoaderCircle,
  RotateCw,
  Star,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Tooltip, cx } from '@graphite/ui';
import { useExplorerStore } from '../../stores/explorerStore';
import type { ExplorerPane as ExplorerPaneModel } from '../../stores/explorerStore';
import { useUiStore } from '../../stores/uiStore';
import { FolderList } from './FolderList';
import { breadcrumbs } from './explorerFormat';
import { fsAvailable, fsErrorMessage, listDir, openPath, openTerminal, revealPath } from './fsApi';
import type { FsEntry } from './fsApi';

const FilePreview = lazy(() => import('./FilePreview').then((module) => ({ default: module.FilePreview })));

type ListingState =
  | { status: 'loading' }
  | { status: 'ready'; entries: FsEntry[] }
  | { status: 'error'; message: string };

function IconBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cx(
          'flex size-7 shrink-0 items-center justify-center rounded-s transition-colors duration-[100ms] disabled:pointer-events-none disabled:opacity-35',
          active === true ? 'text-accent hover:bg-bg-3' : 'text-text-2 hover:bg-bg-3 hover:text-text-0',
        )}
      >
        <Icon size={15} strokeWidth={1.75} fill={active === true ? 'currentColor' : 'none'} />
      </button>
    </Tooltip>
  );
}

export function ExplorerPane({ pane }: { pane: ExplorerPaneModel }) {
  const navigate = useExplorerStore((s) => s.navigate);
  const back = useExplorerStore((s) => s.back);
  const forward = useExplorerStore((s) => s.forward);
  const closePane = useExplorerStore((s) => s.closePane);
  const openFolderPane = useExplorerStore((s) => s.openFolderPane);
  const openFilePane = useExplorerStore((s) => s.openFilePane);
  const addSaved = useExplorerStore((s) => s.addSaved);
  const removeSaved = useExplorerStore((s) => s.removeSaved);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const saved = useExplorerStore((s) => s.saved);
  const pushToast = useUiStore((s) => s.pushToast);

  const [listing, setListing] = useState<ListingState>({ status: 'loading' });
  const [reload, setReload] = useState(0);

  const crumbs = useMemo(() => breadcrumbs(pane.path), [pane.path]);
  const parentPath = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null;
  const folderPath = pane.kind === 'folder' ? pane.path : (parentPath ?? pane.path);
  const savedEntry = saved.find((entry) => entry.path.toLowerCase() === folderPath.toLowerCase());

  useEffect(() => {
    if (pane.kind !== 'folder') {
      return;
    }
    let cancelled = false;
    setListing({ status: 'loading' });
    if (!fsAvailable()) {
      setListing({ status: 'error', message: 'Файловый менеджер доступен только в приложении' });
      return;
    }
    listDir(pane.path, showHidden).then(
      (result) => {
        if (!cancelled) {
          setListing({ status: 'ready', entries: result.entries });
        }
      },
      (error) => {
        if (!cancelled) {
          setListing({ status: 'error', message: fsErrorMessage(error, 'Не удалось открыть папку') });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pane.kind, pane.path, showHidden, reload]);

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path).then(
      () => pushToast({ kind: 'success', text: 'Путь скопирован' }),
      () => pushToast({ kind: 'error', text: 'Не удалось скопировать путь' }),
    );
  };
  const reveal = (path: string) => {
    revealPath(path).catch((error) =>
      pushToast({ kind: 'error', text: fsErrorMessage(error, 'Не удалось показать в Проводнике') }),
    );
  };
  const openExternal = (path: string) => {
    openPath(path).catch((error) => pushToast({ kind: 'error', text: fsErrorMessage(error, 'Не удалось открыть') }));
  };
  const openTerminalHere = (path: string) => {
    openTerminal(path).catch((error) =>
      pushToast({ kind: 'error', text: fsErrorMessage(error, 'Не удалось открыть терминал') }),
    );
  };
  const toggleSaved = () => {
    if (savedEntry !== undefined) {
      removeSaved(savedEntry.id);
      pushToast({ kind: 'info', text: 'Убрано из закладок' });
    } else {
      addSaved(folderPath);
      pushToast({ kind: 'success', text: 'Папка в закладках' });
    }
  };
  const onCrumb = (path: string, isLast: boolean) => {
    if (isLast) {
      return;
    }
    if (pane.kind === 'folder') {
      navigate(pane.id, path);
    } else {
      openFolderPane(path);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-m border border-stroke-0 bg-bg-1 shadow-1">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-stroke-0 px-1.5 py-1">
        <IconBtn icon={ArrowLeft} label="Назад" disabled={pane.back.length === 0} onClick={() => back(pane.id)} />
        <IconBtn
          icon={ArrowRight}
          label="Вперёд"
          disabled={pane.forward.length === 0}
          onClick={() => forward(pane.id)}
        />
        <IconBtn
          icon={ArrowUp}
          label="Вверх"
          disabled={parentPath === null || pane.kind !== 'folder'}
          onClick={() => parentPath !== null && navigate(pane.id, parentPath)}
        />
        <IconBtn icon={RotateCw} label="Обновить" onClick={() => setReload((value) => value + 1)} />
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn
            icon={Star}
            label={savedEntry !== undefined ? 'Убрать из закладок' : 'В закладки'}
            active={savedEntry !== undefined}
            onClick={toggleSaved}
          />
          <IconBtn icon={Terminal} label="Открыть терминал здесь" onClick={() => openTerminalHere(folderPath)} />
          <IconBtn icon={FolderOpen} label="Показать в Проводнике" onClick={() => reveal(pane.path)} />
          <IconBtn icon={Copy} label="Копировать путь" onClick={() => copyPath(pane.path)} />
          <IconBtn icon={X} label="Закрыть панель" onClick={() => closePane(pane.id)} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-stroke-0 px-2 py-1 text-caption text-text-2 [scrollbar-width:none]">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.path}>
              {index > 0 ? <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-text-3" /> : null}
              <button
                type="button"
                onClick={() => onCrumb(crumb.path, isLast)}
                disabled={isLast}
                className={cx(
                  'shrink-0 rounded-xs px-1 py-0.5 transition-colors duration-[90ms]',
                  isLast
                    ? 'font-medium text-text-0'
                    : 'text-text-2 hover:bg-bg-3 hover:text-text-0',
                )}
              >
                {crumb.label}
              </button>
            </Fragment>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {pane.kind === 'file' ? (
          <Suspense
            fallback={
              <div role="status" className="flex flex-1 items-center justify-center text-text-3">
                <LoaderCircle size={18} strokeWidth={1.75} className="animate-spin" aria-hidden />
              </div>
            }
          >
            <FilePreview key={`${pane.path}:${reload}`} path={pane.path} />
          </Suspense>
        ) : listing.status === 'loading' ? (
          <div className="flex flex-1 items-center justify-center text-text-3">
            <LoaderCircle size={18} strokeWidth={1.75} className="animate-spin" />
          </div>
        ) : listing.status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-m border border-stroke-0 bg-bg-2 text-text-3">
              <FileWarning size={18} strokeWidth={1.75} />
            </span>
            <p className="max-w-xs text-ui text-text-1">{listing.message}</p>
            <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)}>
              <RotateCw size={13} strokeWidth={1.75} />
              Повторить
            </Button>
          </div>
        ) : (
          <FolderList
            entries={listing.entries}
            onOpenFolder={(path) => navigate(pane.id, path)}
            onOpenFile={(path) => openFilePane(path)}
            onReveal={reveal}
            onCopyPath={copyPath}
            onOpenExternal={openExternal}
            onOpenTerminal={openTerminalHere}
          />
        )}
      </div>
    </div>
  );
}
