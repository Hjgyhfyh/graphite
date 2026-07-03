import { Copy, Sparkles } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';

const MCP_ADD_COMMAND = 'claude mcp add graphite';

export function AiFeedTab() {
  const pushToast = useUiStore((s) => s.pushToast);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(MCP_ADD_COMMAND);
      pushToast({ kind: 'success', text: 'Команда скопирована' });
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось скопировать команду' });
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Sparkles size={24} strokeWidth={1.5} className="text-text-3" />
      <p className="text-ui text-text-1">Ассистент ещё не подключён</p>
      <p className="text-caption text-text-2">Подключите Claude Code к вашему vault:</p>
      <button
        type="button"
        onClick={() => {
          void copyCommand();
        }}
        className="group flex items-center gap-2 rounded-s border border-stroke-1 bg-bg-2 px-2.5 py-1.5 font-mono text-caption text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
      >
        {MCP_ADD_COMMAND}
        <Copy size={13} strokeWidth={1.75} className="text-text-2 group-hover:text-text-0" />
      </button>
    </div>
  );
}
