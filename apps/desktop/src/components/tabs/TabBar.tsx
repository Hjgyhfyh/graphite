import { X } from 'lucide-react';
import { cx } from '@graphite/ui';
import { useTabsStore } from '../../stores/tabsStore';

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);

  return (
    <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke-0 bg-bg-0 px-2">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => activate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate(tab.id);
              }
            }}
            className={cx(
              'group flex h-7 max-w-52 cursor-default select-none items-center gap-1.5 rounded-s px-2.5 text-ui transition-colors duration-[120ms]',
              active ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
            )}
          >
            {tab.dirty ? <span aria-label="Не сохранено" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
            <span className="truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`Закрыть ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                close(tab.id);
              }}
              className="rounded-xs p-0.5 text-text-2 opacity-0 transition-opacity duration-[120ms] hover:bg-bg-4 hover:text-text-0 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X size={13} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
