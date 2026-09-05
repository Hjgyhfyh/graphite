import type { CaptureDest } from '../../lib/quickCapture';
import { cx } from '@graphite/ui';

interface CaptureDestSwitchProps {
  dest: CaptureDest;
  onChange: (dest: CaptureDest) => void;
}

export function CaptureDestSwitch({ dest, onChange }: CaptureDestSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Куда записать"
      className="flex shrink-0 rounded-full border border-stroke-0 p-0.5"
    >
      {(
        [
          { id: 'inbox', label: 'Входящие' },
          { id: 'journal', label: 'Дневник' },
        ] as const
      ).map((item) => {
        const active = dest === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onChange(item.id)}
            className={cx(
              'h-6 rounded-full px-2 text-micro font-medium transition-colors duration-[120ms]',
              active ? 'bg-bg-3 text-text-0' : 'text-text-3 hover:text-text-1',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
