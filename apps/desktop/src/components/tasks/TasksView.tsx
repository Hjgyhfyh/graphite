import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { Clock, FileText, ListChecks, ListTodo } from 'lucide-react';
import { cx } from '@graphite/ui';
import type { NoteRef, Priority, TaskHit } from '@graphite/bindings';
import { useTasksStore } from '../../stores/tasksStore';
import type { TaskFilter } from '../../stores/tasksStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useUiStore } from '../../stores/uiStore';
import { titleFromRef } from '../../stores/tabsStore';
import {
  REDUCED_CROSSFADE,
  listContainerVariants,
  listItemVariants,
  springSnappy,
  usePrefersReducedMotion,
} from '../../motion';
import { IdeaToTasks } from './IdeaToTasks';

const FILTERS: ReadonlyArray<{ id: TaskFilter; label: string }> = [
  { id: 'open', label: 'Открытые' },
  { id: 'today', label: 'Сегодня' },
  { id: 'overdue', label: 'Просрочено' },
  { id: 'all', label: 'Все' },
];

const EMPTY_STATES: Record<TaskFilter, { title: string; hint: string }> = {
  open: { title: 'Открытых задач нет', hint: 'Чисто. Запишите идею выше и разложите её на шаги.' },
  today: { title: 'На сегодня ничего', hint: 'Спокойный день — можно заняться главным.' },
  overdue: { title: 'Просроченных нет', hint: 'Всё под контролем, ничего не горит.' },
  all: { title: 'Задач пока нет', hint: 'Запишите идею выше и разложите её на шаги.' },
};

const PRIORITY_BADGE: Partial<Record<Priority, { label: string; cls: string }>> = {
  urgent: { label: 'Срочно', cls: 'bg-danger/15 text-danger' },
  high: { label: 'Важно', cls: 'bg-warn/15 text-warn' },
};

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAY_MS = 86_400_000;
const CHECK_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface TaskGroup {
  ref: NoteRef;
  title: string;
  isPlan: boolean;
  tasks: TaskHit[];
}

function groupTasks(tasks: TaskHit[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const isPlan = task.plan !== undefined;
    const ref = task.plan ?? task.source.ref;
    const existing = groups.get(ref);
    if (existing === undefined) {
      groups.set(ref, { ref, title: titleFromRef(ref), isPlan, tasks: [task] });
    } else {
      existing.tasks.push(task);
    }
  }
  return [...groups.values()].sort((a, b) => (a.isPlan === b.isPlan ? 0 : a.isPlan ? -1 : 1));
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatDue(due: string): { label: string; overdue: boolean } {
  const parsed = new Date(due.length <= 10 ? `${due}T00:00:00` : due);
  if (Number.isNaN(parsed.getTime())) {
    return { label: due, overdue: false };
  }
  const today = startOfDay(new Date());
  const target = startOfDay(parsed);
  const diffDays = Math.round((target - today) / DAY_MS);
  if (diffDays === 0) {
    return { label: 'Сегодня', overdue: false };
  }
  if (diffDays === 1) {
    return { label: 'Завтра', overdue: false };
  }
  if (diffDays === -1) {
    return { label: 'Вчера', overdue: true };
  }
  const day = parsed.getDate();
  const month = MONTHS_SHORT[parsed.getMonth()];
  const label =
    parsed.getFullYear() === new Date().getFullYear() ? `${day} ${month}` : `${day} ${month} ${parsed.getFullYear()}`;
  return { label, overdue: target < today };
}

function jumpToNote(ref: NoteRef): void {
  useVaultStore.getState().openNote(ref);
  useUiStore.getState().setRailView('tree');
}

interface TaskCheckboxProps {
  done: boolean;
  reduced: boolean;
  onToggle: () => void;
}

function TaskCheckbox({ done, reduced, onToggle }: TaskCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Снять отметку' : 'Отметить выполненной'}
      onClick={onToggle}
      className={cx(
        'relative mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-s border transition-colors duration-[120ms]',
        done ? 'border-transparent' : 'border-stroke-1 hover:border-text-2',
      )}
    >
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-s bg-status-done"
        initial={false}
        animate={done ? { scale: 1, opacity: 1 } : { scale: 0.35, opacity: 0 }}
        transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      />
      <motion.svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative size-3 text-bg-0"
      >
        <motion.path
          d="M4.5 12.5 L9.5 17.5 L19.5 6.5"
          initial={false}
          animate={done ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
          transition={reduced ? REDUCED_CROSSFADE : { duration: 0.18, ease: CHECK_EASE }}
        />
      </motion.svg>
    </button>
  );
}

interface TaskTextProps {
  text: string;
  done: boolean;
  reduced: boolean;
}

function TaskText({ text, done, reduced }: TaskTextProps) {
  return (
    <span className="relative inline-block max-w-full align-baseline">
      <span className={cx('break-words text-ui transition-colors duration-[160ms]', done ? 'text-text-3' : 'text-text-0')}>
        {text}
      </span>
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px origin-left bg-text-3"
        initial={false}
        animate={{ scaleX: done ? 1 : 0 }}
        transition={reduced ? REDUCED_CROSSFADE : { duration: 0.2, ease: CHECK_EASE }}
      />
    </span>
  );
}

function PriorityBadge({ priority }: { priority: Priority }) {
  const badge = PRIORITY_BADGE[priority];
  if (badge === undefined) {
    return null;
  }
  return (
    <span className={cx('inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-micro font-medium', badge.cls)}>
      {badge.label}
    </span>
  );
}

function DueBadge({ due, done }: { due: string; done: boolean }) {
  const { label, overdue } = formatDue(due);
  const danger = overdue && !done;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro',
        danger ? 'bg-danger/15 text-danger' : 'bg-bg-3 text-text-2',
      )}
    >
      <Clock size={11} strokeWidth={1.75} />
      {label}
    </span>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-m border border-dashed border-stroke-1 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-bg-2 text-text-2">
        <ListTodo size={20} strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-ui text-text-1">{title}</p>
        <p className="text-caption text-text-2">{hint}</p>
      </div>
    </div>
  );
}

function TasksSkeleton({ reduced }: { reduced: boolean }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[72, 58, 66, 45, 62].map((width, index) => (
        <div key={index} className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="size-4 shrink-0 rounded-s bg-bg-2" />
          <motion.div
            className="h-3.5 rounded-s bg-bg-2"
            style={{ width: `${width}%` }}
            animate={reduced ? undefined : { opacity: [0.5, 0.85, 0.5] }}
            transition={reduced ? undefined : { duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: index * 0.08 }}
          />
        </div>
      ))}
    </div>
  );
}

export function TasksView() {
  const tasks = useTasksStore((s) => s.tasks);
  const filter = useTasksStore((s) => s.filter);
  const loading = useTasksStore((s) => s.loading);
  const setFilter = useTasksStore((s) => s.setFilter);
  const toggle = useTasksStore((s) => s.toggle);
  const loadTasks = useTasksStore((s) => s.loadTasks);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  const empty = EMPTY_STATES[filter];

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-bg-0">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-8 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2">
            <h1 className="text-h2 text-text-0">Задачи</h1>
            {tasks.length > 0 ? <span className="text-caption text-text-3">{tasks.length}</span> : null}
          </div>
          <div className="flex items-center gap-0.5">
            {FILTERS.map((item) => {
              const active = filter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={cx(
                    'relative h-7 rounded-s px-2.5 text-ui transition-colors duration-[120ms]',
                    active ? 'text-text-0' : 'text-text-1 hover:text-text-0',
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="tasksFilterPill"
                      className="absolute inset-0 rounded-s bg-bg-3"
                      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
                    />
                  ) : null}
                  <span className="relative z-10">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <IdeaToTasks />

        {loading && tasks.length === 0 ? (
          <TasksSkeleton reduced={reduced} />
        ) : tasks.length === 0 ? (
          <EmptyState title={empty.title} hint={empty.hint} />
        ) : (
          <motion.div
            key={filter}
            variants={listContainerVariants}
            initial="initial"
            animate="animate"
            className="flex flex-col gap-5"
          >
            {groups.map((group) => {
              const doneCount = group.tasks.filter((task) => task.done).length;
              const GroupIcon = group.isPlan ? ListChecks : FileText;
              return (
                <motion.section key={group.ref} variants={listItemVariants} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => jumpToNote(group.ref)}
                    className="group flex items-center gap-1.5 self-start rounded-s px-1.5 py-1 transition-colors duration-[120ms] hover:bg-bg-1"
                  >
                    <GroupIcon size={13} strokeWidth={1.75} className={group.isPlan ? 'text-accent' : 'text-text-3'} />
                    <span className="text-caption font-medium text-text-1 group-hover:text-text-0">{group.title}</span>
                    <span className="text-micro text-text-3">
                      {doneCount}/{group.tasks.length}
                    </span>
                  </button>
                  <motion.ul
                    variants={listContainerVariants}
                    initial="initial"
                    animate="animate"
                    className="flex flex-col gap-0.5"
                  >
                    {group.tasks.map((task) => (
                      <motion.li
                        key={task.id}
                        variants={listItemVariants}
                        className="group flex items-start gap-2.5 rounded-s px-2 py-1.5 transition-colors duration-[120ms] hover:bg-bg-1"
                      >
                        <TaskCheckbox done={task.done} reduced={reduced} onToggle={() => void toggle(task.id)} />
                        <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => jumpToNote(task.source.ref)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <TaskText text={task.text} done={task.done} reduced={reduced} />
                          </button>
                          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                            {task.priority !== undefined ? <PriorityBadge priority={task.priority} /> : null}
                            {task.due !== undefined ? <DueBadge due={task.due} done={task.done} /> : null}
                          </div>
                        </div>
                      </motion.li>
                    ))}
                  </motion.ul>
                </motion.section>
              );
            })}
          </motion.div>
        )}
      </div>
    </main>
  );
}
