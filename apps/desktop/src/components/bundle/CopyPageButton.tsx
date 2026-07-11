import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Copy, FileText, Layers, Loader2, Sparkles } from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef, RelType } from '@graphite/bindings';
import { titleFromRef } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';

export interface CopyPageButtonProps {
  noteRef: NoteRef;
  className?: string;
  label?: string;
}

type CopyMode = 'main' | 'bundle' | 'prompt';

const PROMPT_INTRO =
  'Ниже — заметка из моей базы знаний вместе со связанными материалами (единый смысловой бандл). ' +
  'Основной файл — суть и инструкция, остальные дополняют контекст. ' +
  'Прочитай всё как один документ и помоги по существу моего запроса.';

const MENU_ITEM =
  'flex w-full cursor-default select-none flex-col items-start gap-0.5 rounded-s px-2 py-1.5 outline-none data-[highlighted]:bg-bg-3';

function pathFromRef(ref: NoteRef): string {
  return ref.startsWith('path:') ? ref.slice('path:'.length) : ref;
}

function pluralFiles(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return 'файл';
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return 'файла';
  }
  return 'файлов';
}

function isUnavailable(error: unknown): boolean {
  return isGraphiteError(error) && error.code === 'UNAVAILABLE';
}

function renderSection(ref: NoteRef, title: string, content: string, heading: '#' | '##'): string {
  return `${heading} ${title}\n\n> Источник: ${pathFromRef(ref)}\n\n${content.trim()}`;
}

export function CopyPageButton({ noteRef, className, label = 'Copy Page' }: CopyPageButtonProps) {
  const [busy, setBusy] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  const composeFallback = async (mode: CopyMode): Promise<{ text: string; count: number }> => {
    const main = await commands.noteRead({ ref: noteRef });
    const sections = [renderSection(noteRef, main.frontmatter.title ?? titleFromRef(noteRef), main.content, '#')];
    const seen = new Set<NoteRef>([noteRef]);
    let count = 1;
    if (mode !== 'main') {
      const types: RelType[] =
        mode === 'prompt' ? ['part_of', 'collected_in', 'related'] : ['part_of', 'collected_in'];
      let linked: NoteRef[] = [];
      try {
        const links = await commands.linksGet({ ref: noteRef, direction: 'both', types });
        linked = [...links.in.map((edge) => edge.from), ...links.out.map((edge) => edge.to)];
      } catch {
        linked = [];
      }
      for (const ref of linked) {
        if (seen.has(ref) || count >= 13) {
          continue;
        }
        seen.add(ref);
        try {
          const doc = await commands.noteRead({ ref });
          sections.push(renderSection(ref, doc.frontmatter.title ?? titleFromRef(ref), doc.content, '##'));
          count += 1;
        } catch {
          continue;
        }
      }
    }
    return { text: sections.join('\n\n---\n\n'), count };
  };

  const build = async (mode: CopyMode): Promise<{ text: string; count: number }> => {
    if (mode === 'main') {
      const main = await commands.noteRead({ ref: noteRef });
      return {
        text: renderSection(noteRef, main.frontmatter.title ?? titleFromRef(noteRef), main.content, '#'),
        count: 1,
      };
    }
    const includeLinked = mode === 'prompt';
    let result: { text: string; count: number };
    try {
      const response = await commands.bundleCompose({ ref: noteRef, includeLinked });
      result = { text: response.text, count: Math.max(response.members.length, 1) };
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
      result = await composeFallback(mode);
    }
    if (mode === 'prompt') {
      return { text: `${PROMPT_INTRO}\n\n<context>\n${result.text}\n</context>`, count: result.count };
    }
    return result;
  };

  const run = async (mode: CopyMode) => {
    setBusy(true);
    try {
      const { text, count } = await build(mode);
      await navigator.clipboard.writeText(text);
      void commands
        .promptLogAppend({ source: mode, title: titleFromRef(noteRef), refs: [noteRef], text })
        .catch(() => undefined);
      pushToast({ kind: 'success', text: `Скопировано: ${count} ${pluralFiles(count)}` });
    } catch (error) {
      pushToast({
        kind: 'error',
        text: isGraphiteError(error)
          ? error.code === 'UNAVAILABLE'
            ? 'Ядро ещё не подключено'
            : error.message
          : 'Не удалось скопировать страницу',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cx(
        'inline-flex h-7 items-stretch overflow-hidden rounded-s border border-stroke-1 bg-bg-2 text-ui text-text-1 shadow-1',
        className,
      )}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => void run('bundle')}
        title="Скопировать основной файл со связанными в ИИ-формате"
        className="flex items-center gap-1.5 px-2.5 outline-none transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4 disabled:opacity-45"
      >
        {busy ? (
          <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-accent" />
        ) : (
          <Copy size={14} strokeWidth={1.75} className="text-accent" />
        )}
        {label}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label="Способы копирования"
            className="flex items-center border-l border-stroke-1 px-1.5 text-text-2 outline-none transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:bg-bg-4 disabled:opacity-45 data-[state=open]:bg-bg-3 data-[state=open]:text-text-0"
          >
            <ChevronDown size={14} strokeWidth={1.75} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 w-64 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3"
          >
            <DropdownMenu.Label className="px-2 py-1 text-micro text-text-2">Скопировать в буфер</DropdownMenu.Label>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run('main')}>
              <div className="flex w-full items-center gap-2 text-ui text-text-1">
                <FileText size={15} strokeWidth={1.75} className="text-text-2" />
                Только основной файл
              </div>
              <span className="pl-6 text-micro text-text-2">Текст этой заметки</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run('bundle')}>
              <div className="flex w-full items-center gap-2 text-ui text-text-1">
                <Layers size={15} strokeWidth={1.75} className="text-accent" />
                Основной + связанные
                <span className="ml-auto rounded-xs bg-bg-3 px-1 text-micro text-text-2">по умолчанию</span>
              </div>
              <span className="pl-6 text-micro text-text-2">Весь бандл одним markdown</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void run('prompt')}>
              <div className="flex w-full items-center gap-2 text-ui text-text-1">
                <Sparkles size={15} strokeWidth={1.75} className="text-ai" />
                Как промпт для ИИ
              </div>
              <span className="pl-6 text-micro text-text-2">С короткой обёрткой-инструкцией</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
