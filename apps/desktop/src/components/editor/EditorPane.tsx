import { useEffect, useRef } from 'react';
import { createEditor } from '@graphite/editor';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { titleFromRef, useTabsStore } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';

export const WELCOME_NOTE_REF: NoteRef = 'path:Добро пожаловать.md';

const WELCOME_DOC = `# Добро пожаловать в Graphite

Это ваш локальный кабинет для заметок и планов. Всё хранится обычными
markdown-файлами в вашей папке — без облака и подписок.

## С чего начать

- Нажмите \`Ctrl+K\` — командная палитра
- Кнопка «+» над деревом — новая заметка
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
    let disposed = false;
    let editor: ReturnType<typeof createEditor> | undefined;
    let saveTimer: number | undefined;
    let baseRev = '';
    const isWelcome = noteRef === WELCOME_NOTE_REF;

    const save = async (doc: string) => {
      try {
        const res = await commands.bufferSave({ ref: noteRef, baseRev, content: doc });
        baseRev = res.revNew;
        setDirty(tabId, false);
      } catch (error) {
        useUiStore.getState().pushToast({
          kind: 'error',
          text: isGraphiteError(error) ? error.message : 'Не удалось сохранить заметку',
        });
      }
    };

    const mount = (doc: string) => {
      if (disposed) {
        return;
      }
      editor = createEditor(host, {
        initialDoc: doc,
        onChange: (next) => {
          if (isWelcome) {
            return;
          }
          setDirty(tabId, true);
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            void save(next);
          }, 600);
        },
      });
      editor.focus();
    };

    if (isWelcome) {
      mount(WELCOME_DOC);
    } else {
      commands.noteRead({ ref: noteRef }).then(
        (res) => {
          baseRev = res.rev;
          mount(res.content);
        },
        (error: unknown) => {
          const reason = isGraphiteError(error) ? error.message : 'не удалось прочитать заметку';
          mount(`# ${titleFromRef(noteRef)}\n\n> ${reason}\n`);
        },
      );
    }

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      editor?.destroy();
    };
  }, [tabId, noteRef, setDirty]);

  return <div ref={hostRef} className="min-h-0 flex-1" />;
}
