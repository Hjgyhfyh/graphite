import { cx } from '@graphite/ui';
import { useUiStore } from '../../stores/uiStore';
import type { RightPanelTab } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { AiFeedTab } from './AiFeedTab';
import { LinksTab } from './LinksTab';
import { PropertiesTab } from './PropertiesTab';

export interface RightPanelProps {
  tab: RightPanelTab;
}

const TABS: ReadonlyArray<{ id: RightPanelTab; label: string }> = [
  { id: 'properties', label: 'Свойства' },
  { id: 'aiFeed', label: 'ИИ' },
  { id: 'links', label: 'Связи' },
];

function NoNote() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-ui text-text-2">
      Откройте заметку, чтобы увидеть её данные
    </div>
  );
}

export function RightPanel({ tab }: RightPanelProps) {
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const currentRef = useVaultStore((s) => s.currentRef);

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-stroke-0 bg-bg-1" aria-label="Правая панель">
      <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke-0 px-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => toggleRightPanel(item.id)}
            className={cx(
              'h-7 rounded-s px-2.5 text-ui transition-colors duration-[120ms]',
              tab === item.id ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'properties' ? (
          currentRef !== undefined ? (
            <PropertiesTab noteRef={currentRef} />
          ) : (
            <NoNote />
          )
        ) : null}
        {tab === 'aiFeed' ? <AiFeedTab /> : null}
        {tab === 'links' ? (
          currentRef !== undefined ? (
            <LinksTab noteRef={currentRef} />
          ) : (
            <NoNote />
          )
        ) : null}
      </div>
    </aside>
  );
}
