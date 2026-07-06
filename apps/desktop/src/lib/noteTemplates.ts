import { Briefcase, FileText, Handshake, Lightbulb } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TreeNode } from '@graphite/bindings';

/** Встроенный шаблон заметки; в теле работают подстановки {{title}}, {{date}} и {{time}}. */
export interface BuiltinTemplate {
  readonly id: string;
  readonly title: string;
  /** Короткая подпись — что внутри шаблона. */
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly body: string;
}

/** Папка хранилища, из которой подхватываются пользовательские шаблоны. */
export const TEMPLATES_FOLDER = 'Шаблоны';

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: 'meeting',
    title: 'Встреча',
    hint: 'Повестка, решения, задачи',
    icon: Handshake,
    body: '# {{title}}\n\n**Дата:** {{date}} {{time}}\n\n## Повестка\n\n- \n\n## Решения\n\n## Задачи\n\n- [ ] \n',
  },
  {
    id: 'project',
    title: 'Проект',
    hint: 'Цель, шаги, статус',
    icon: Briefcase,
    body: '# {{title}}\n\n**Цель:** \n\n## Шаги\n\n- [ ] \n\n## Заметки\n',
  },
  {
    id: 'idea',
    title: 'Идея',
    hint: 'Суть и первый шаг',
    icon: Lightbulb,
    body: '# {{title}}\n\n> Суть одной фразой.\n\n## Почему это стоит сделать\n\n## Первый шаг\n',
  },
  {
    id: 'note',
    title: 'Заметка',
    hint: 'Чистый лист',
    icon: FileText,
    body: '# {{title}}\n',
  },
];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Подставляет {{title}}, {{date}} (локальная ГГГГ-ММ-ДД) и {{time}} (локальное ЧЧ:ММ). */
export function applyTemplate(body: string, title: string): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return body.replaceAll('{{title}}', title).replaceAll('{{date}}', date).replaceAll('{{time}}', time);
}

/** Пользовательские шаблоны: .md-файлы в корне папки «Шаблоны», кроме её folder-note. */
export function userTemplatesFromTree(tree: readonly TreeNode[]): TreeNode[] {
  const prefix = `${TEMPLATES_FOLDER}/`;
  return tree
    .filter((node) => {
      const path = node.path.replace(/\\/g, '/');
      if (!path.startsWith(prefix) || !path.toLowerCase().endsWith('.md')) {
        return false;
      }
      const rest = path.slice(prefix.length);
      return !rest.includes('/') && rest.toLowerCase() !== '_index.md';
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}
