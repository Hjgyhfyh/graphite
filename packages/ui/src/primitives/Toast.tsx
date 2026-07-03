import { useSyncExternalStore } from 'react';
import { cx } from '../cx';
import { MOTION } from '../motion';

export type ToastKind = 'default' | 'ok' | 'warn' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  kind?: ToastKind;
  durationMs?: number;
  action?: ToastAction;
}

export interface ToastItem {
  readonly id: number;
  readonly title: string;
  readonly description: string | undefined;
  readonly kind: ToastKind;
  readonly durationMs: number;
  readonly action: ToastAction | undefined;
  readonly leaving: boolean;
}

const DEFAULT_DURATION_MS = MOTION.M10.durationsMs.progress;
const EXIT_MS = MOTION.M10.durationsMs.exit;

let nextId = 1;
let items: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: readonly ToastItem[]): void {
  items = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

export function toast(options: ToastOptions): number {
  const id = nextId;
  nextId += 1;
  const item: ToastItem = {
    id,
    title: options.title,
    description: options.description,
    kind: options.kind ?? 'default',
    durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
    action: options.action,
    leaving: false,
  };
  emit([...items, item]);
  timers.set(
    id,
    setTimeout(() => {
      dismissToast(id);
    }, item.durationMs),
  );
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.leaving) {
    return;
  }
  emit(items.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      emit(items.filter((item) => item.id !== id));
    }, EXIT_MS),
  );
}

const KIND_COLOR: Record<ToastKind, string> = {
  default: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export interface ToastProps {
  item: ToastItem;
  className?: string;
}

export function Toast({ item, className }: ToastProps) {
  const { action } = item;
  return (
    <div
      role="status"
      className={cx(
        'pointer-events-auto relative w-full overflow-hidden rounded-m border border-stroke-0 bg-bg-2 shadow-2 inset-shadow-hairline',
        item.leaving ? 'animate-toast-out' : 'animate-toast-in',
        className,
      )}
    >
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <span aria-hidden className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', KIND_COLOR[item.kind])} />
        <div className="min-w-0 flex-1">
          <div className="text-ui text-text-0">{item.title}</div>
          {item.description !== undefined ? (
            <div className="mt-0.5 text-caption text-text-1">{item.description}</div>
          ) : null}
        </div>
        {action !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded-xs px-1.5 py-0.5 text-ui text-accent transition-colors duration-[120ms] hover:bg-bg-3 active:bg-bg-4"
            onClick={() => {
              action.onClick();
              dismissToast(item.id);
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {!item.leaving ? (
        <div
          aria-hidden
          className={cx('absolute inset-x-0 bottom-0 h-0.5 origin-left animate-toast-progress', KIND_COLOR[item.kind])}
          style={{ animationDuration: `${item.durationMs}ms` }}
        />
      ) : null}
    </div>
  );
}

export interface ToastHostProps {
  className?: string;
}

export function ToastHost({ className }: ToastHostProps) {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div
      role="region"
      aria-label="Уведомления"
      aria-live="polite"
      className={cx('pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col items-stretch gap-2', className)}
    >
      {toasts.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  );
}
