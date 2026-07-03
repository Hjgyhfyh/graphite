import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CalendarDays, Check, ChevronDown, Flag, Plus, X } from 'lucide-react';
import { ProgressRing, StatusPill, Tooltip, cx } from '@graphite/ui';
import type { NoteStatus } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable, GRAPHITE_EVENT } from '@graphite/bindings';
import type { NoteChangedEvent, NoteRef, Priority, Status } from '@graphite/bindings';
import { listen } from '@tauri-apps/api/event';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { titleFromRef } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { IconPicker } from '../tree/IconPicker';
import { NoteIcon } from '../tree/NoteIcon';
import { CopyPageButton } from '../bundle/CopyPageButton';

export interface PropertiesTabProps {
  noteRef: NoteRef;
}

const STATUS_ORDER: readonly Status[] = ['inbox', 'shaping', 'planned', 'active', 'done', 'iced'];

const STATUS_META: Record<Status, { pill: NoteStatus; label: string; ring: string; maturity: number }> = {
  inbox: { pill: 'inbox', label: 'Входящие', ring: 'var(--text-2)', maturity: 0.06 },
  shaping: { pill: 'shaping', label: 'Проработка', ring: 'var(--warn)', maturity: 0.3 },
  planned: { pill: 'plan', label: 'План', ring: 'var(--accent)', maturity: 0.52 },
  active: { pill: 'doing', label: 'В работе', ring: 'var(--ai)', maturity: 0.78 },
  done: { pill: 'done', label: 'Готово', ring: 'var(--ok)', maturity: 1 },
  iced: { pill: 'ice', label: 'Лёд', ring: 'var(--text-3)', maturity: 0.5 },
};

const STATUS_DOT: Record<NoteStatus, string> = {
  inbox: 'bg-status-inbox',
  shaping: 'bg-status-shaping',
  plan: 'bg-status-plan',
  doing: 'bg-status-doing',
  done: 'bg-status-done',
  ice: 'bg-status-ice',
};

const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

const PRIORITY_META: Record<Priority, { label: string; chip: string; dot: string }> = {
  urgent: { label: 'Срочно', chip: 'bg-danger/15 text-danger', dot: 'bg-danger' },
  high: { label: 'Важно', chip: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  normal: { label: 'Обычный', chip: 'bg-accent/15 text-accent', dot: 'bg-accent' },
  low: { label: 'Низкий', chip: 'bg-bg-3 text-text-2', dot: 'bg-text-3' },
};

function pathFromRef(ref: NoteRef): string {
  return ref.startsWith('path:') ? ref.slice('path:'.length) : ref;
}

function todayKey(): string {
  return new Date().toLocaleDateString('sv-SE');
}

function formatDue(due: string): string {
  const parsed = new Date(`${due}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return due;
  }
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-2 px-1">
      <span className="flex shrink-0 items-center gap-2 text-caption text-text-2">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 items-center justify-end">{children}</div>
    </div>
  );
}

export function PropertiesTab({ noteRef }: PropertiesTabProps) {
  const pushToast = useUiStore((s) => s.pushToast);
  const storeIcon = useVaultStore((s) => s.iconByRef[noteRef]);
  const reduced = usePrefersReducedMotion();

  const revRef = useRef<string>('');
  const [title, setTitle] = useState<string>(() => titleFromRef(noteRef));
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority | undefined>(undefined);
  const [due, setDue] = useState<string | undefined>(undefined);
  const [fmIcon, setFmIcon] = useState<string | undefined>(undefined);
  const [fmColor, setFmColor] = useState<string | undefined>(undefined);
  const [tagInput, setTagInput] = useState('');
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await commands.noteRead({ ref: noteRef });
      revRef.current = res.rev;
      const fm = res.frontmatter;
      setTitle(fm.title ?? titleFromRef(noteRef));
      setStatus(fm.status);
      setTags(fm.tags ?? []);
      setPriority(fm.priority);
      setDue(typeof fm.due === 'string' ? fm.due.slice(0, 10) : undefined);
      setFmIcon(fm.icon);
      setFmColor(fm.iconColor);
      setAvailable(true);
    } catch (error) {
      revRef.current = '';
      setTitle(titleFromRef(noteRef));
      setStatus(undefined);
      setTags([]);
      setPriority(undefined);
      setDue(undefined);
      setFmIcon(undefined);
      setFmColor(undefined);
      setAvailable(!(isGraphiteError(error) && error.code === 'UNAVAILABLE'));
    }
  }, [noteRef]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    const subscription = listen<NoteChangedEvent>(GRAPHITE_EVENT.noteChanged, (event) => {
      if (event.payload.ref === noteRef && event.payload.rev !== revRef.current) {
        void load();
      }
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, [noteRef, load]);

  const persist = async (key: string, value: unknown) => {
    if (revRef.current.length === 0) {
      return;
    }
    const ops = [{ op: 'set_frontmatter' as const, key, value }];
    try {
      const res = await commands.noteEdit({ ref: noteRef, rev: revRef.current, ops });
      revRef.current = res.revNew;
    } catch (error) {
      if (isGraphiteError(error) && error.code === 'CONFLICT') {
        try {
          const fresh = await commands.noteRead({ ref: noteRef });
          const retry = await commands.noteEdit({ ref: noteRef, rev: fresh.rev, ops });
          revRef.current = retry.revNew;
          return;
        } catch {
          void load();
          return;
        }
      }
      if (isGraphiteError(error) && error.code === 'UNAVAILABLE') {
        return;
      }
      pushToast({ kind: 'error', text: isGraphiteError(error) ? error.message : 'Не удалось сохранить' });
      void load();
    }
  };

  const changeStatus = async (next: Status) => {
    const previous = status;
    setStatus(next);
    try {
      const res = await commands.setStatus({ ref: noteRef, status: next });
      setStatus(res.new);
    } catch (error) {
      if (isGraphiteError(error) && error.code === 'UNAVAILABLE') {
        return;
      }
      setStatus(previous);
      pushToast({ kind: 'error', text: isGraphiteError(error) ? error.message : 'Не удалось изменить статус' });
    }
  };

  const changePriority = (next?: Priority) => {
    setPriority(next);
    void persist('priority', next ?? null);
  };

  const changeDue = (next?: string) => {
    const value = next !== undefined && next.length > 0 ? next : undefined;
    setDue(value);
    void persist('due', value ?? null);
  };

  const addTag = (raw: string) => {
    const value = raw.trim();
    if (value.length === 0) {
      setTagInput('');
      return;
    }
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTagInput('');
      return;
    }
    const next = [...tags, value];
    setTags(next);
    setTagInput('');
    void persist('tags', next);
  };

  const removeTag = (tag: string) => {
    const next = tags.filter((item) => item !== tag);
    setTags(next);
    void persist('tags', next);
  };

  const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagInput);
    } else if (event.key === 'Backspace' && tagInput.length === 0 && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const pickIcon = (icon?: string, color?: string) => {
    setFmIcon(icon);
    setFmColor(color);
    void useVaultStore.getState().setIcon(noteRef, icon, color);
  };

  const displayIcon = storeIcon?.icon ?? fmIcon;
  const displayColor = storeIcon?.color ?? fmColor;
  const meta = status !== undefined ? STATUS_META[status] : undefined;
  const maturity = meta?.maturity ?? 0;
  const overdue = due !== undefined && due < todayKey() && status !== 'done';

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 p-3 pb-2.5">
        <IconPicker icon={displayIcon} color={displayColor} onPick={pickIcon}>
          <button
            type="button"
            aria-label="Сменить иконку заметки"
            title="Сменить иконку"
            className="grid size-11 shrink-0 place-items-center rounded-m border border-stroke-1 bg-bg-2 outline-none transition-colors duration-[120ms] hover:border-accent/50 hover:bg-bg-3"
          >
            <NoteIcon
              icon={displayIcon}
              color={displayColor}
              size={22}
              className={displayColor === undefined ? 'text-text-1' : undefined}
            />
          </button>
        </IconPicker>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-body text-text-0" title={title}>
            {title}
          </div>
          <div className="mt-0.5 truncate font-mono text-micro text-text-2" title={pathFromRef(noteRef)}>
            {pathFromRef(noteRef)}
          </div>
        </div>
        <Tooltip content={`Зрелость · ${meta?.label ?? 'не задано'}`}>
          <div className="relative grid size-11 shrink-0 place-items-center">
            <ProgressRing
              value={maturity}
              size={40}
              strokeWidth={3}
              className="shrink-0"
              style={meta !== undefined ? { color: meta.ring } : undefined}
            />
            <span className="absolute text-micro tabular-nums text-text-1">
              {meta !== undefined ? Math.round(maturity * 100) : '—'}
            </span>
          </div>
        </Tooltip>
      </div>

      <div className="px-3 pb-3">
        <CopyPageButton noteRef={noteRef} />
      </div>

      <div className="flex flex-col gap-0.5 border-t border-stroke-0 px-2 py-2">
        <Field icon={<span aria-hidden className={cx('size-2 rounded-full', meta ? STATUS_DOT[meta.pill] : 'bg-text-3')} />} label="Статус">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              {status !== undefined && meta !== undefined ? (
                <button
                  type="button"
                  className="group flex items-center gap-1 rounded-full outline-none"
                  aria-label="Изменить статус"
                >
                  <StatusPill status={meta.pill} className="transition-colors group-hover:border-accent/50" />
                  <ChevronDown size={13} strokeWidth={1.75} className="text-text-3 group-hover:text-text-1" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-[22px] items-center gap-1 rounded-full border border-dashed border-stroke-1 px-2.5 text-caption text-text-2 outline-none transition-colors hover:border-accent/50 hover:text-text-1"
                >
                  Задать
                  <ChevronDown size={13} strokeWidth={1.75} />
                </button>
              )}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 w-52 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3"
              >
                <DropdownMenu.Label className="px-2 py-1 text-micro text-text-2">Конвейер зрелости</DropdownMenu.Label>
                {STATUS_ORDER.map((value) => {
                  const item = STATUS_META[value];
                  const active = value === status;
                  return (
                    <DropdownMenu.Item
                      key={value}
                      onSelect={() => void changeStatus(value)}
                      className="flex cursor-default select-none items-center gap-2 rounded-s px-2 py-1.5 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0"
                    >
                      <span aria-hidden className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[item.pill])} />
                      <span className="min-w-0 flex-1">{item.label}</span>
                      {active ? <Check size={14} strokeWidth={1.75} className="shrink-0 text-accent" /> : null}
                    </DropdownMenu.Item>
                  );
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </Field>

        <Field icon={<Flag size={13} strokeWidth={1.75} />} label="Приоритет">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Изменить приоритет"
                className="flex items-center gap-1 rounded-s outline-none"
              >
                {priority !== undefined ? (
                  <span
                    className={cx(
                      'inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-caption',
                      PRIORITY_META[priority].chip,
                    )}
                  >
                    <span aria-hidden className={cx('size-1.5 rounded-full', PRIORITY_META[priority].dot)} />
                    {PRIORITY_META[priority].label}
                  </span>
                ) : (
                  <span className="text-ui text-text-3 transition-colors hover:text-text-1">—</span>
                )}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 w-44 origin-(--radix-dropdown-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3"
              >
                {PRIORITY_ORDER.map((value) => (
                  <DropdownMenu.Item
                    key={value}
                    onSelect={() => changePriority(value)}
                    className="flex cursor-default select-none items-center gap-2 rounded-s px-2 py-1.5 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0"
                  >
                    <span aria-hidden className={cx('size-2 shrink-0 rounded-full', PRIORITY_META[value].dot)} />
                    <span className="min-w-0 flex-1">{PRIORITY_META[value].label}</span>
                    {value === priority ? (
                      <Check size={14} strokeWidth={1.75} className="shrink-0 text-accent" />
                    ) : null}
                  </DropdownMenu.Item>
                ))}
                {priority !== undefined ? (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px bg-stroke-0" />
                    <DropdownMenu.Item
                      onSelect={() => changePriority(undefined)}
                      className="flex cursor-default select-none items-center gap-2 rounded-s px-2 py-1.5 text-ui text-text-2 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0"
                    >
                      <X size={14} strokeWidth={1.75} className="shrink-0" />
                      Убрать приоритет
                    </DropdownMenu.Item>
                  </>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </Field>

        <Field icon={<CalendarDays size={13} strokeWidth={1.75} />} label="Срок">
          <div
            className={cx(
              'group flex h-7 items-center gap-1 rounded-s border px-2 transition-colors',
              overdue ? 'border-danger/50 bg-danger/10' : 'border-transparent hover:border-stroke-1 hover:bg-bg-2',
            )}
          >
            <label className="relative flex cursor-pointer items-center">
              <span className={cx('text-ui tabular-nums', due !== undefined ? (overdue ? 'text-danger' : 'text-text-1') : 'text-text-3')}>
                {due !== undefined ? formatDue(due) : 'нет'}
              </span>
              <input
                type="date"
                value={due ?? ''}
                onChange={(event) => changeDue(event.target.value)}
                aria-label="Срок выполнения"
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            {due !== undefined ? (
              <button
                type="button"
                aria-label="Убрать срок"
                onClick={() => changeDue(undefined)}
                className="rounded-xs p-0.5 text-text-3 outline-none transition-colors hover:text-danger"
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        </Field>
      </div>

      <div className="flex flex-col gap-2 border-t border-stroke-0 px-3 py-3">
        <span className="text-caption text-text-2">Теги</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <AnimatePresence initial={false}>
            {tags.map((tag) => (
              <motion.span
                key={tag}
                layout={!reduced}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
                transition={springSnappy}
                className="group inline-flex h-6 items-center gap-1 rounded-full border border-stroke-1 bg-bg-2 pl-2 pr-1 text-caption text-text-1"
              >
                <span className="text-text-3">#</span>
                <span className="max-w-[140px] truncate">{tag}</span>
                <button
                  type="button"
                  aria-label={`Убрать тег ${tag}`}
                  onClick={() => removeTag(tag)}
                  className="rounded-full p-0.5 text-text-3 outline-none transition-colors hover:bg-bg-4 hover:text-danger"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
          <div className="inline-flex h-6 min-w-[92px] flex-1 items-center gap-1 rounded-full border border-dashed border-stroke-1 pl-2 pr-1 focus-within:border-accent/50">
            <Plus size={12} strokeWidth={1.75} className="shrink-0 text-text-3" />
            <input
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={onTagKeyDown}
              onBlur={() => addTag(tagInput)}
              placeholder="добавить"
              aria-label="Добавить тег"
              className="h-full w-full min-w-0 bg-transparent text-caption text-text-0 caret-accent outline-none placeholder:text-text-3"
            />
          </div>
        </div>
      </div>

      {!available ? (
        <p className="px-3 pb-3 text-micro text-text-3">Изменения применятся к файлу после подключения ядра.</p>
      ) : null}
    </div>
  );
}
