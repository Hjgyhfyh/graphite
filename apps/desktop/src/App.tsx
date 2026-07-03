import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CornerDownLeft, PenLine } from 'lucide-react';
import { Kbd, TooltipProvider, cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { AppShell } from './app/AppShell';
import { EditorPane } from './components/editor/EditorPane';
import { AppMotionConfig } from './motion';
import { titleFromRef } from './stores/tabsStore';
import { useVaultStore } from './stores/vaultStore';

export function App() {
  return <AppShell />;
}

async function hideSelfWindow(): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }
  try {
    await getCurrentWindow().hide();
  } catch {
    /* окно недоступно — мягкая деградация */
  }
}

/**
 * Оконный вариант быстрой записи: живёт в отдельном frameless-окне «capture»,
 * которое поднимают трей и глобальный хоткей. Enter — сохранить и скрыть,
 * Esc — скрыть.
 */
export function CaptureApp() {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusInput = useCallback(() => {
    const el = textareaRef.current;
    if (el !== null) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(raf);
  }, [focusInput]);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .listen('capture-shown', () => {
        setText('');
        setError(null);
        setSaving(false);
        requestAnimationFrame(focusInput);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [focusInput]);

  const save = useCallback(async () => {
    const body = text.trim();
    if (body.length === 0 || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await commands.quickCapture(body);
      setText('');
      setSaving(false);
      await hideSelfWindow();
    } catch (err) {
      setSaving(false);
      setError(isGraphiteError(err) ? err.message : 'Не удалось сохранить запись');
    }
  }, [text, saving]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void hideSelfWindow();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  const canSave = text.trim().length > 0 && !saving;

  return (
    <div className="flex h-dvh w-full flex-col bg-transparent p-3">
      <div className="inset-shadow-hairline flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-stroke-1 bg-bg-2 shadow-3">
        <header
          data-tauri-drag-region
          className="flex select-none items-center gap-2 border-b border-stroke-0 px-3.5 py-2.5"
        >
          <PenLine size={14} strokeWidth={1.75} className="pointer-events-none text-ai" />
          <span className="pointer-events-none text-caption font-medium text-text-1">Быстрая запись</span>
          <span aria-hidden className="pointer-events-none text-text-3">
            ·
          </span>
          <span className="pointer-events-none text-micro text-text-3">Входящие</span>
        </header>

        <textarea
          ref={textareaRef}
          autoFocus
          value={text}
          readOnly={saving}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Текст быстрой записи"
          placeholder="Что на уме? Запишется во «Входящие»."
          className="block min-h-0 w-full flex-1 resize-none bg-transparent px-3.5 py-3 text-body text-text-0 outline-none placeholder:text-text-3"
        />

        <footer className="flex items-center justify-between gap-3 border-t border-stroke-0 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-3 text-micro text-text-2">
            {error !== null ? (
              <span className="truncate text-danger">{error}</span>
            ) : (
              <>
                <span className="flex items-center gap-1">
                  <Kbd>Enter</Kbd>
                  сохранить
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>Esc</Kbd>
                  скрыть
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className={cx(
              'flex shrink-0 items-center gap-1.5 rounded-s bg-accent px-2.5 py-1 text-caption font-medium text-bg-0 transition-[opacity,transform] duration-[120ms]',
              'hover:opacity-90 active:scale-[0.98]',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40 disabled:active:scale-100',
            )}
          >
            <CornerDownLeft size={13} strokeWidth={1.75} />
            Записать
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Отдельное окно одной заметки (фича #16): выносит файл из вкладок в
 * самостоятельное webview-окно с полноценным редактором.
 */
export function NoteApp({ noteRef }: { noteRef: NoteRef }) {
  useEffect(() => {
    document.title = titleFromRef(noteRef);
    void useVaultStore.getState().loadTree();
  }, [noteRef]);

  return (
    <AppMotionConfig>
      <TooltipProvider>
        <div className="flex h-dvh flex-col overflow-hidden bg-bg-0 text-text-0">
          <EditorPane tabId="detached" noteRef={noteRef} />
        </div>
      </TooltipProvider>
    </AppMotionConfig>
  );
}
