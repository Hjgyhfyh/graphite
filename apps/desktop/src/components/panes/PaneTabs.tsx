import { Columns2, PanelRightClose, SquareArrowOutUpRight } from 'lucide-react';
import { Tooltip } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import { MAX_PANES, usePanesStore } from '../../stores/panesStore';
import { useTabsStore } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { TabBar } from '../tabs/TabBar';

export { TAB_DND_TYPE } from '../tabs/TabBar';

export interface PaneTabsProps {
  paneId: string;
}

const CONTROL =
  'flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors hover:bg-bg-3 hover:text-text-0';

export function PaneTabs({ paneId }: PaneTabsProps) {
  const activeTabId = usePanesStore((s) => s.panes.find((p) => p.id === paneId)?.activeTabId);
  const paneCount = usePanesStore((s) => s.panes.length);
  const addPane = usePanesStore((s) => s.addPane);
  const removePane = usePanesStore((s) => s.removePane);
  const moveTabToPane = usePanesStore((s) => s.moveTabToPane);
  const close = useTabsStore((s) => s.close);
  const pushToast = useUiStore((s) => s.pushToast);

  const splitActiveToPane = () => {
    if (activeTabId === undefined) {
      pushToast({ kind: 'info', text: 'Нет активной вкладки для разделения' });
      return;
    }
    const newPaneId = addPane();
    if (newPaneId === undefined) {
      pushToast({ kind: 'info', text: `Достигнут предел областей (${MAX_PANES}).` });
      return;
    }
    moveTabToPane(activeTabId, newPaneId);
  };

  const detachActive = () => {
    if (activeTabId === undefined) {
      pushToast({ kind: 'info', text: 'Нет активной вкладки для выноса' });
      return;
    }
    const noteRef = useTabsStore.getState().tabs.find((tab) => tab.id === activeTabId)?.noteRef;
    if (noteRef === undefined) {
      splitActiveToPane();
      return;
    }
    commands
      .openNoteWindow(noteRef)
      .then(() => close(activeTabId))
      .catch(() => {
        splitActiveToPane();
        pushToast({ kind: 'info', text: 'Отдельное окно недоступно — вынес в новую область' });
      });
  };

  const trailing = (
    <>
      {paneCount < MAX_PANES ? (
        <Tooltip content="Разделить область" side="bottom">
          <button type="button" aria-label="Разделить область" className={CONTROL} onClick={splitActiveToPane}>
            <Columns2 size={15} strokeWidth={1.75} />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip content="В отдельное окно" side="bottom">
        <button type="button" aria-label="В отдельное окно" className={CONTROL} onClick={detachActive}>
          <SquareArrowOutUpRight size={15} strokeWidth={1.75} />
        </button>
      </Tooltip>
      {paneCount > 1 ? (
        <Tooltip content="Закрыть область" side="bottom">
          <button type="button" aria-label="Закрыть область" className={CONTROL} onClick={() => removePane(paneId)}>
            <PanelRightClose size={15} strokeWidth={1.75} />
          </button>
        </Tooltip>
      ) : null}
    </>
  );

  return <TabBar paneId={paneId} trailing={trailing} />;
}
