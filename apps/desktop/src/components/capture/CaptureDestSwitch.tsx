import type { CaptureDest } from '../../lib/quickCapture';
import { cx } from '@graphite/ui';

interface CaptureDestSwitchProps {
  dest: CaptureDest;
  onChange: (dest: CaptureDest) => void;
  noteAvailable?: boolean;
}

const ITEMS: ReadonlyArray<{ id: CaptureDest; label: string }> = [
  { id: 'inbox', label: 'Входящие' },
  { id: 'journal', label: 'Дневник' },
  { id: 'note', label: 'Заметка' },
];

export function CaptureDestSwitch({ dest, onChange, noteAvailable = true }: CaptureDestSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Куда записать"
      className="flex shrink-0 rounded-full border border-stroke-0 p-0.5"
    >
      {ITEMS.map((item) => {
        const active = dest === item.id;
        const disabled = item.id === 'note' && !noteAvailable;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={disabled ? 'Откройте заметку' : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onChange(item.id)}
            className={cx(
              'h-6 rounded-full px-2 text-micro font-medium transition-colors duration-[120ms]',
              active ? 'bg-bg-3 text-text-0' : 'text-text-3 hover:text-text-1',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-3',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
