import { useVaultStore } from '../../stores/vaultStore';

function vaultLabel(root: string | undefined): string {
  if (root === undefined || root.length === 0) {
    return 'Vault не открыт';
  }
  const segments = root.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? root;
}

export function StatusBar() {
  const info = useVaultStore((s) => s.info);
  const indexStatus = useVaultStore((s) => s.indexStatus);
  const notesCount = info?.counts.notes ?? 0;

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-stroke-0 bg-bg-1 px-3 text-caption text-text-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate">{vaultLabel(info?.root)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {indexStatus.state !== 'idle' ? (
          <span>
            Индексация {indexStatus.done}/{indexStatus.total}
          </span>
        ) : null}
        <span>Заметок: {notesCount}</span>
        <span className="flex items-center gap-1.5" aria-label="MCP не подключён">
          <span aria-hidden className="size-1.5 rounded-full bg-text-3" />
          <span className="font-mono text-micro">MCP</span>
        </span>
      </div>
    </footer>
  );
}
