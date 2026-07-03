import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx';

export type NoteStatus = 'inbox' | 'shaping' | 'plan' | 'doing' | 'done' | 'ice';

export const STATUS_LABEL: Record<NoteStatus, string> = {
  inbox: 'Входящие',
  shaping: 'Проработка',
  plan: 'План',
  doing: 'В работе',
  done: 'Готово',
  ice: 'Лёд',
};

const DOT_COLOR: Record<NoteStatus, string> = {
  inbox: 'bg-status-inbox',
  shaping: 'bg-status-shaping',
  plan: 'bg-status-plan',
  doing: 'bg-status-doing',
  done: 'bg-status-done',
  ice: 'bg-status-ice',
};

export interface StatusPillProps extends ComponentPropsWithRef<'span'> {
  status: NoteStatus;
  label?: string;
}

export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  return (
    <span
      className={cx(
        'inline-flex h-[22px] select-none items-center gap-1.5 whitespace-nowrap rounded-full border border-stroke-1 bg-bg-2 pl-2 pr-2.5 text-caption text-text-1',
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', DOT_COLOR[status])} />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
