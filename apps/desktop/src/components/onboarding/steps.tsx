import type { ReactNode } from 'react';
import { Command, FilePlus2, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Kbd } from '@graphite/ui';

export type CoachPlacement = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface CoachSelector {
  query: string;
  parent?: boolean;
}

export interface CoachStep {
  id: 'create' | 'palette' | 'ai';
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  selectors: readonly CoachSelector[];
  placement: CoachPlacement;
  padding: number;
  radius: number;
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1 align-[-3px]">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

function HotkeyRow({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-s border border-stroke-0 bg-bg-1 px-2.5 py-2">
      <span className="flex shrink-0 items-center gap-1 pt-px">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      <span className="min-w-0 text-ui leading-snug text-text-1">{children}</span>
    </div>
  );
}

export const COACH_STEPS: readonly CoachStep[] = [
  {
    id: 'create',
    icon: FilePlus2,
    title: 'Создайте первую заметку',
    body: (
      <p>
        Кнопка «плюс» создаёт заметку во «Входящих» и сразу открывает её в редакторе. Из любого
        места то же самое делает <Keys keys={['Ctrl', 'N']} />.
      </p>
    ),
    selectors: [
      { query: 'aside[aria-label="Дерево заметок"] [aria-label="Новая заметка"]' },
      { query: '[aria-label="Новая заметка"]' },
      { query: 'aside[aria-label="Дерево заметок"] header button' },
    ],
    placement: 'right',
    padding: 6,
    radius: 10,
  },
  {
    id: 'palette',
    icon: Command,
    title: 'Палитра — центр управления',
    body: (
      <div className="flex flex-col gap-2">
        <HotkeyRow keys={['Ctrl', 'K']}>Палитра: любая заметка или команда за пару нажатий.</HotkeyRow>
        <HotkeyRow keys={['Ctrl', 'Alt', 'Space']}>
          Быстрый захват: записать мысль, не отвлекаясь от дел.
        </HotkeyRow>
        <p className="text-caption text-text-2">
          Попробуйте прямо сейчас — подсказки уступят место палитре.
        </p>
      </div>
    ),
    selectors: [],
    placement: 'center',
    padding: 0,
    radius: 999,
  },
  {
    id: 'ai',
    icon: Sparkles,
    title: 'Отдайте заметку ИИ',
    body: (
      <p>
        Copy Page собирает заметку со связанными файлами в один ИИ-дружественный текст. Жмите
        кнопку или <Keys keys={['Ctrl', 'Shift', 'C']} /> — и всё уже в буфере. Ассистент
        подключается по MCP и видит хранилище сам: пульс подключения — в статус-баре.
      </p>
    ),
    selectors: [
      { query: '[aria-label="Способы копирования"]', parent: true },
      { query: '[title="Скопировать основной файл со связанными в ИИ-формате"]', parent: true },
    ],
    placement: 'bottom',
    padding: 6,
    radius: 14,
  },
];
