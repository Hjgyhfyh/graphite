import { useEffect, useRef } from 'react';
import { createEditor } from '@graphite/editor';
import type { NoteRef } from '@graphite/bindings';
import { titleFromRef, useTabsStore } from '../../stores/tabsStore';

export const WELCOME_NOTE_REF: NoteRef = 'path:Добро пожаловать.md';

const WELCOME_DOC = `# Добро пожаловать в Graphite

Это ваш локальный кабинет для заметок и планов. Всё хранится обычными
markdown-файлами в вашей папке — без облака и подписок.

## С чего начать

- Нажмите \`Ctrl+K\` — командная палитра
- \`Ctrl+Alt+Space\` — быстрая заметка из любого места
- Связывайте мысли двойными скобками: [[Моя первая заметка]]

## Задачи

- [ ] Создать первую заметку
- [ ] Открыть командную палитру
- [x] Установить Graphite

> Заметка становится знанием, когда она связана с другими.
`;

export interface EditorPaneProps {
  tabId: string;
  noteRef: NoteRef;
}

export function EditorPane({ tabId, noteRef }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const setDirty = useTabsStore((s) => s.setDirty);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const initialDoc = noteRef === WELCOME_NOTE_REF ? WELCOME_DOC : `# ${titleFromRef(noteRef)}\n\n`;
    const editor = createEditor(host, {
      initialDoc,
      onChange: (doc) => {
        setDirty(tabId, doc !== initialDoc);
      },
    });
    editor.focus();
    return () => {
      editor.destroy();
    };
  }, [tabId, noteRef, setDirty]);

  return <div ref={hostRef} className="min-h-0 flex-1" />;
}
