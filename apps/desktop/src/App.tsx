import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CornerDownLeft, PenLine, X } from 'lucide-react';
import { Kbd, TooltipProvider, cx } from '@graphite/ui';
import { isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { AppShell } from './app/AppShell';
import { AppMotionConfig } from './motion';
import { titleFromRef } from './stores/tabsStore';
import { useVaultStore } from './stores/vaultStore';
import { useUiStore } from './stores/uiStore';
import { captureNoteTarget, capturePlaceholder, submitQuickCapture } from './lib/quickCapture';
import { CaptureDestSwitch } from './components/capture/CaptureDestSwitch';

const EditorPane = lazy(() =>
  import('./components/editor/EditorPane').then((module) => ({ default: module.EditorPane })),
);

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
  const captureDest = useUiStore((s) => s.captureDest);
  const setCaptureDest = useUiStore((s) => s.setCaptureDest);
  const lastNoteRef = useUiStore((s) => s.lastNoteRef);
  const noteTarget = captureNoteTarget(lastNoteRef);

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

  // Окно принимает ввод сразу после set_focus() на нативной стороне, ещё до
  // прихода 'capture-shown': держим textarea сфокусированной на каждом фокусе
  // окна, а поле чистим только когда окно реально скрылось (Esc, сохранение,
  // закрытие) — блюр видимого окна оставляет черновик на месте.
  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          requestAnimationFrame(focusInput);
        } else {
          void getCurrentWindow()
            .isVisible()
            .then((visible) => {
              if (!visible) {
                setText('');
                setError(null);
                setSaving(false);
              }
            });
        }
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
      await submitQuickCapture(body, useUiStore.getState().captureDest, captureNoteTarget(useUiStore.getState().lastNoteRef));
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
      setText('');
      setError(null);
      void hideSelfWindow();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  const canSave = text.trim().length > 0 && !saving && (captureDest !== 'note' || noteTarget !== undefined);

  return (
    <div className="flex h-dvh w-full flex-col bg-transparent p-3">
      <div className="inset-shadow-hairline flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-stroke-1 bg-bg-2 shadow-3">
        <header
          data-tauri-drag-region
          className="flex select-none items-center gap-2 border-b border-stroke-0 px-3.5 py-2.5"
        >
          <PenLine size={14} strokeWidth={1.75} className="pointer-events-none text-ai" />
          <span className="pointer-events-none text-caption font-medium text-text-1">Быстрая запись</span>
          <span className="ml-auto">
            <CaptureDestSwitch
              dest={captureDest}
              onChange={setCaptureDest}
              noteAvailable={noteTarget !== undefined}
            />
          </span>
        </header>

        <textarea
          ref={textareaRef}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Текст быстрой записи"
          placeholder={capturePlaceholder(captureDest)}
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
class EditorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : 'не удалось открыть заметку' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('detached editor error', error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-ui text-text-1">Не удалось открыть заметку</p>
          <p className="text-caption text-text-3">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function NoteApp({ initialRef }: { initialRef: string }) {
  const [noteRef, setNoteRef] = useState(initialRef);
  const title = noteRef.length > 0 ? titleFromRef(noteRef as NoteRef) : 'Заметка';

  useEffect(() => {
    document.title = title;
  }, [title]);

  // Одно переиспользуемое окно «note»: команда open_note_window шлёт сюда
  // событие note-open с новой ссылкой, окно обновляет редактор без пересоздания.
  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .listen<string>('note-open', (event) => {
        if (typeof event.payload === 'string' && event.payload.length > 0) {
          setNoteRef(event.payload);
          void useVaultStore.getState().loadTree();
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void hideSelfWindow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <AppMotionConfig>
      <TooltipProvider>
        <div className="flex h-dvh flex-col overflow-hidden bg-bg-0 text-text-0">
          <header
            data-tauri-drag-region
            className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-stroke-0 px-3"
          >
            <PenLine size={13} strokeWidth={1.75} className="pointer-events-none shrink-0 text-text-2" />
            <span className="pointer-events-none min-w-0 flex-1 truncate text-ui text-text-1">{title}</span>
            <button
              type="button"
              aria-label="Закрыть окно"
              onClick={() => void hideSelfWindow()}
              className="shrink-0 rounded-xs p-1 text-text-2 hover:bg-bg-3 hover:text-text-0"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </header>
          {noteRef.length > 0 ? (
            <EditorBoundary key={noteRef}>
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-ui text-text-2">
                    Открываем заметку…
                  </div>
                }
              >
                <EditorPane tabId="detached" noteRef={noteRef as NoteRef} />
              </Suspense>
            </EditorBoundary>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-ui text-text-2">
              Заметка откроется здесь
            </div>
          )}
        </div>
      </TooltipProvider>
    </AppMotionConfig>
  );
}
