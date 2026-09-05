import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Transition } from 'motion/react';
import { motion } from 'motion/react';
import { CornerDownLeft, PenLine, X } from 'lucide-react';
import { Kbd, Tooltip, cx } from '@graphite/ui';
import { isGraphiteError } from '@graphite/bindings';
import { Presence, REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useActionHandler } from '../../app/Keymap';
import { formatBinding, useKeybindingsStore } from '../../stores/keybindingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { captureNoteTarget, capturePlaceholder, submitQuickCapture } from '../../lib/quickCapture';
import { CaptureDestSwitch } from './CaptureDestSwitch';

const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];
const WINDOW_FADE: Transition = { duration: 0.16, ease: EASE_IN };
const CONTENT_UP: Transition = { duration: 0.14, ease: EASE_IN };
const CARD_EXIT: Transition = { duration: 0.12, ease: EASE_IN };
const TOP_RATIO = 0.18;

interface Offset {
  x: number;
  y: number;
}

function clampOffset(x: number, y: number): Offset {
  if (typeof window === 'undefined') {
    return { x, y };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const topPx = vh * TOP_RATIO;
  const maxX = Math.max(0, vw / 2 - 160);
  const minY = 8 - topPx;
  const maxY = Math.max(minY, vh - topPx - 96);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}

export function FloatingCapture() {
  const open = useUiStore((s) => s.floatingCaptureOpen);
  const setOpen = useUiStore((s) => s.setFloatingCaptureOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const captureDest = useUiStore((s) => s.captureDest);
  const setCaptureDest = useUiStore((s) => s.setCaptureDest);
  const lastNoteRef = useUiStore((s) => s.lastNoteRef);
  const currentRef = useVaultStore((s) => s.currentRef);
  const noteTarget = captureNoteTarget(currentRef ?? lastNoteRef);
  const captureBinding = useKeybindingsStore((s) => s.bindings['capture.quick']);
  const reduced = usePrefersReducedMotion();

  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useActionHandler('capture.quick', () => {
    if (saving) {
      return;
    }
    if (useUiStore.getState().floatingCaptureOpen) {
      setOpen(false);
    } else {
      setOffset({ x: 0, y: 0 });
      setOpen(true);
    }
  });

  useEffect(() => {
    if (!open) {
      dragRef.current = null;
      setDragging(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const openFromButton = () => {
    setOffset({ x: 0, y: 0 });
    setOpen(true);
  };

  const save = async () => {
    const body = text.trim();
    if (body.length === 0 || saving) {
      return;
    }
    setSaving(true);
    try {
      const dest = useUiStore.getState().captureDest;
      const target = captureNoteTarget(
        useVaultStore.getState().currentRef ?? useUiStore.getState().lastNoteRef,
      );
      const result = await submitQuickCapture(body, dest, target);
      window.setTimeout(
        () => {
          setOpen(false);
          setText('');
          setSaving(false);
          if (dest === 'journal') {
            pushToast({
              kind: 'success',
              text: 'Добавлено в дневник за сегодня',
              action: { label: 'Открыть', run: () => useUiStore.getState().openJournalDay() },
            });
          } else if (dest === 'note') {
            pushToast({
              kind: 'success',
              text: 'Дописано в открытую заметку',
              action: {
                label: 'Открыть',
                run: () => useVaultStore.getState().openNote(result.ref),
              },
            });
          } else {
            pushToast({ kind: 'success', text: 'Записано во «Входящие»' });
          }
          void useVaultStore.getState().loadTree();
        },
        reduced ? 90 : 190,
      );
    } catch (error) {
      setSaving(false);
      pushToast({
        kind: 'error',
        text: isGraphiteError(error) ? error.message : 'Не удалось сохранить запись',
      });
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    dragRef.current = { px: event.clientX, py: event.clientY, ox: offset.x, oy: offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragRef.current;
    if (start === null) {
      return;
    }
    setOffset(clampOffset(start.ox + (event.clientX - start.px), start.oy + (event.clientY - start.py)));
  };

  const onHeaderPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current === null) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const canSave = text.trim().length > 0 && !saving && (captureDest !== 'note' || noteTarget !== undefined);

  const cardInitial = reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 };
  const cardAnimate = saving ? { opacity: 0 } : reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 };
  const cardExit = reduced
    ? { opacity: 0, transition: REDUCED_CROSSFADE }
    : { opacity: 0, scale: 0.98, y: -6, transition: CARD_EXIT };
  const cardTransition: Transition = saving ? WINDOW_FADE : reduced ? REDUCED_CROSSFADE : springSnappy;

  const contentAnimate = saving ? (reduced ? { opacity: 0 } : { opacity: 0, y: -16 }) : { opacity: 1, y: 0 };
  const contentTransition: Transition = saving
    ? reduced
      ? REDUCED_CROSSFADE
      : CONTENT_UP
    : reduced
      ? REDUCED_CROSSFADE
      : springSnappy;

  const fabTransition: Transition = reduced ? REDUCED_CROSSFADE : springSnappy;

  return (
    <>
      <div
        className="fixed left-1/2 top-[18vh] z-40"
        style={{
          transform: `translate3d(calc(-50% + ${offset.x}px), ${offset.y}px, 0)`,
          willChange: dragging ? 'transform' : undefined,
        }}
      >
        <Presence>
          {open ? (
            <motion.div
              key="capture-card"
              role="dialog"
              aria-label="Быстрая запись"
              className="inset-shadow-hairline w-[480px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-stroke-1 bg-bg-2 shadow-3"
              initial={cardInitial}
              animate={cardAnimate}
              exit={cardExit}
              transition={cardTransition}
            >
              <header
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
                onPointerCancel={onHeaderPointerUp}
                className={cx(
                  'flex select-none items-center gap-2 border-b border-stroke-0 px-3.5 py-2.5',
                  dragging ? 'cursor-grabbing' : 'cursor-grab',
                )}
              >
                <PenLine size={14} strokeWidth={1.75} className="text-ai" />
                <span className="text-caption font-medium text-text-1">Быстрая запись</span>
                <CaptureDestSwitch
                  dest={captureDest}
                  onChange={setCaptureDest}
                  noteAvailable={noteTarget !== undefined}
                />
                <div className="flex-1" />
                <button
                  type="button"
                  aria-label="Закрыть"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setOpen(false)}
                  className="flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                >
                  <X size={14} strokeWidth={1.75} />
                </button>
              </header>

              <motion.div animate={contentAnimate} transition={contentTransition}>
                <textarea
                  ref={textareaRef}
                  autoFocus
                  value={text}
                  readOnly={saving}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onKeyDown}
                  aria-label="Текст быстрой записи"
                  placeholder={capturePlaceholder(captureDest)}
                  className="block h-20 w-full resize-none bg-transparent px-3.5 py-3 text-body text-text-0 outline-none placeholder:text-text-3"
                />
              </motion.div>

              <footer className="flex items-center justify-between gap-3 border-t border-stroke-0 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-3 text-micro text-text-2">
                  <span className="flex items-center gap-1">
                    <Kbd>Enter</Kbd>
                    сохранить
                  </span>
                  <span className="flex items-center gap-1">
                    <Kbd>Shift</Kbd>
                    <Kbd>Enter</Kbd>
                    перенос
                  </span>
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
            </motion.div>
          ) : null}
        </Presence>
      </div>

      <Presence>
        {open ? null : (
          <motion.div
            key="capture-fab"
            className="fixed bottom-10 right-4 z-30"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            transition={fabTransition}
          >
            <Tooltip content={`Быстрая запись · ${formatBinding(captureBinding)}`} side="left">
              <button
                type="button"
                aria-label="Быстрая запись"
                onClick={openFromButton}
                className="flex size-11 items-center justify-center rounded-full border border-stroke-1 bg-bg-2 text-text-1 shadow-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
              >
                <PenLine size={18} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </motion.div>
        )}
      </Presence>
    </>
  );
}
