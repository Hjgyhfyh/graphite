import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FileCode, FileDown, FileOutput, Loader2, Printer } from 'lucide-react';
import { Tooltip } from '@graphite/ui';
import type { NoteRef } from '@graphite/bindings';
import { exportNoteHtml, exportNoteMarkdown, printNote } from '../../lib/exportNote';

export interface ExportMenuProps {
  noteRef: NoteRef;
}

const MENU_ITEM =
  'flex w-full cursor-default select-none flex-col items-start gap-0.5 rounded-s px-2 py-1.5 outline-none data-[highlighted]:bg-bg-3';

/** Кнопка экспорта в плавающем кластере редактора: HTML, печать/PDF, копия .md. */
export function ExportMenu({ noteRef }: ExportMenuProps) {
  const [busy, setBusy] = useState(false);

  const run = async (task: (ref: NoteRef) => Promise<void>) => {
    setBusy(true);
    try {
      await task(noteRef);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu.Root>
      <Tooltip content="Экспорт">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label="Экспорт заметки"
            className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-s border border-stroke-1 bg-bg-2 text-text-1 shadow-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4 disabled:opacity-45 data-[state=open]:bg-bg-3 data-[state=open]:text-text-0"
          >
            {busy ? (
              <Loader2 size={15} strokeWidth={1.75} className="animate-spin text-accent" />
            ) : (
              <FileOutput size={15} strokeWidth={1.75} />
            )}
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3"
        >
          <DropdownMenu.Label className="px-2 py-1 text-micro text-text-2">Экспорт заметки</DropdownMenu.Label>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run(exportNoteHtml)}>
            <div className="flex w-full items-center gap-2 text-ui text-text-1">
              <FileCode size={15} strokeWidth={1.75} className="text-accent" />
              В HTML…
            </div>
            <span className="pl-6 text-micro text-text-2">Автономный файл со стилями и картинками</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run(printNote)}>
            <div className="flex w-full items-center gap-2 text-ui text-text-1">
              <Printer size={15} strokeWidth={1.75} className="text-text-2" />
              Печать / PDF…
            </div>
            <span className="pl-6 text-micro text-text-2">Системное окно печати — там же PDF</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run(exportNoteMarkdown)}>
            <div className="flex w-full items-center gap-2 text-ui text-text-1">
              <FileDown size={15} strokeWidth={1.75} className="text-text-2" />
              Копия Markdown…
            </div>
            <span className="pl-6 text-micro text-text-2">Сохранить копию .md</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
