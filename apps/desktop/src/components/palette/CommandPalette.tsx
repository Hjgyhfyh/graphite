import { Command } from 'cmdk';
import { FilePlus, Search, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Kbd } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

interface PaletteItemProps {
  icon: LucideIcon;
  label: string;
  keys: readonly string[];
  onSelect: () => void;
}

function PaletteItem({ icon: Icon, label, keys, onSelect }: PaletteItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex h-9 cursor-default select-none items-center gap-2.5 rounded-s px-2.5 text-ui text-text-1 data-[selected=true]:bg-bg-3 data-[selected=true]:text-text-0"
    >
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
      <span className="flex-1 truncate">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </Command.Item>
  );
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setRailView = useUiStore((s) => s.setRailView);
  const pushToast = useUiStore((s) => s.pushToast);

  const runNewNote = async () => {
    setOpen(false);
    try {
      const created = await commands.noteCreate({ title: 'Новая заметка' });
      useVaultStore.getState().openNote(created.ref);
      void useVaultStore.getState().loadTree();
    } catch (error) {
      pushToast({
        kind: 'error',
        text:
          isGraphiteError(error) && error.code === 'UNAVAILABLE'
            ? 'Ядро недоступно: запустите приложение в оболочке Graphite'
            : 'Не удалось создать заметку',
      });
    }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Командная палитра"
      overlayClassName="fixed inset-0 z-40 bg-black/55"
      contentClassName="fixed left-1/2 top-[18vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2"
      className="animate-pop overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3"
    >
      <Command.Input
        placeholder="Команда или поиск…"
        className="h-11 w-full border-b border-stroke-0 bg-transparent px-4 text-ui text-text-0 outline-none placeholder:text-text-2"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-ui text-text-2">Ничего не найдено</Command.Empty>
        <Command.Group
          heading="Команды"
          className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-2"
        >
          <PaletteItem
            icon={FilePlus}
            label="Новая заметка"
            keys={['Ctrl', 'N']}
            onSelect={() => {
              void runNewNote();
            }}
          />
          <PaletteItem
            icon={Search}
            label="Поиск"
            keys={['Ctrl', 'Shift', 'F']}
            onSelect={() => {
              setRailView('search');
              setOpen(false);
            }}
          />
          <PaletteItem
            icon={Settings}
            label="Настройки"
            keys={['Ctrl', ',']}
            onSelect={() => {
              setRailView('settings');
              setOpen(false);
            }}
          />
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
