import { useState } from 'react';
import { motion } from 'motion/react';
import { Flag, ListChecks, Plus, Sparkles, Wand2, X } from 'lucide-react';
import { Button, Input } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { IdeaToTaskDraft, NoteRef, PlanCreateParams, Priority } from '@graphite/bindings';
import { useUiStore } from '../../stores/uiStore';
import { useTasksStore } from '../../stores/tasksStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Presence, listContainerVariants, listItemVariants, slideUpVariants } from '../../motion';

export interface IdeaToTasksProps {
  noteRef?: NoteRef;
}

interface EditableDraft {
  key: string;
  text: string;
  due?: string;
  priority?: Priority;
}

const PRIORITY_CYCLE: ReadonlyArray<Priority | undefined> = [undefined, 'high', 'urgent'];

const DUE_PATTERNS: ReadonlyArray<RegExp> = [
  /@?due[:(]?\s*(\d{4}-\d{2}-\d{2})\)?/i,
  /\bдо\s+(\d{4}-\d{2}-\d{2})\b/i,
  /\((\d{4}-\d{2}-\d{2})\)/,
  /\b(\d{4}-\d{2}-\d{2})\b/,
];

function nextPriority(current?: Priority): Priority | undefined {
  const index = PRIORITY_CYCLE.findIndex((item) => item === current);
  return PRIORITY_CYCLE[(index + 1) % PRIORITY_CYCLE.length];
}

function priorityColor(priority?: Priority): string {
  switch (priority) {
    case 'urgent':
      return 'text-danger';
    case 'high':
      return 'text-warn';
    case 'normal':
      return 'text-accent';
    default:
      return 'text-text-3';
  }
}

function priorityTitle(priority?: Priority): string {
  switch (priority) {
    case 'urgent':
      return 'Приоритет: срочно';
    case 'high':
      return 'Приоритет: важно';
    case 'normal':
      return 'Приоритет: обычный';
    case 'low':
      return 'Приоритет: низкий';
    default:
      return 'Без приоритета';
  }
}

function taskWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) {
    return 'задач';
  }
  if (mod10 === 1) {
    return 'задача';
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return 'задачи';
  }
  return 'задач';
}

function reason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

function toEditable(draft: IdeaToTaskDraft): EditableDraft {
  return { key: crypto.randomUUID(), text: draft.text, due: draft.due, priority: draft.priority };
}

function parseIdeaLocally(text: string): IdeaToTaskDraft[] {
  const drafts: IdeaToTaskDraft[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let body = raw
      .trim()
      .replace(/^[-*•▪·]\s+/, '')
      .replace(/^\d+\s*[.)\-–—:]\s+/, '')
      .replace(/^\[[ xX]?\]\s*/, '')
      .trim();
    if (body.length === 0) {
      continue;
    }
    let due: string | undefined;
    for (const pattern of DUE_PATTERNS) {
      const match = body.match(pattern);
      if (match !== null) {
        due = match[1];
        body = body.replace(match[0], '').trim();
        break;
      }
    }
    let priority: Priority | undefined;
    const priorityMatch = body.match(/@p:(urgent|high|normal|low)\b/i) ?? body.match(/!(urgent|high)\b/i);
    if (priorityMatch !== null) {
      priority = priorityMatch[1].toLowerCase() as Priority;
      body = body.replace(priorityMatch[0], '').trim();
    } else if (/!!\s*$/.test(body)) {
      priority = 'urgent';
      body = body.replace(/!!\s*$/, '').trim();
    } else if (/!\s*$/.test(body)) {
      priority = 'high';
      body = body.replace(/!\s*$/, '').trim();
    }
    if (body.length === 0) {
      continue;
    }
    drafts.push({ text: body, due, priority });
  }
  return drafts;
}

function assistCommand(noteRef?: NoteRef): string {
  return noteRef !== undefined ? `claude "/graphite:distill ref:${noteRef}"` : 'claude "/graphite:distill"';
}

export function IdeaToTasks({ noteRef }: IdeaToTasksProps) {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  const hasDrafts = drafts.length > 0;
  const validCount = drafts.reduce((count, draft) => (draft.text.trim().length > 0 ? count + 1 : count), 0);

  const decompose = async () => {
    const body = text.trim();
    if (noteRef === undefined && body.length === 0) {
      return;
    }
    setBusy(true);
    try {
      let result: IdeaToTaskDraft[] = [];
      try {
        const response = await commands.ideaToTasks(noteRef !== undefined ? { ref: noteRef } : { text: body });
        result = response.tasks;
      } catch (error) {
        if (noteRef !== undefined) {
          throw error;
        }
        result = parseIdeaLocally(body);
        if (result.length === 0) {
          throw error;
        }
      }
      if (result.length === 0) {
        pushToast({ kind: 'info', text: 'Не нашлось пунктов. Начните строки с «1 -», «-» или «*».' });
        return;
      }
      setDrafts(result.map(toEditable));
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось разложить на задачи') });
    } finally {
      setBusy(false);
    }
  };

  const improveWithAssistant = async () => {
    setAssisting(true);
    const command = assistCommand(noteRef);
    let found: boolean | undefined;
    try {
      found = (await commands.detectClaudeCli()).found;
    } catch {
      found = undefined;
    }
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось скопировать команду' });
      setAssisting(false);
      return;
    }
    if (found === false) {
      pushToast({
        kind: 'info',
        text: 'Claude Code не найден. Команда скопирована — установите ассистента и вставьте её в терминал.',
      });
    } else {
      pushToast({ kind: 'success', text: 'Команда скопирована — вставьте её в терминал с ассистентом.' });
    }
    setAssisting(false);
  };

  const updateDraft = (key: string, patch: Partial<EditableDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const removeDraft = (key: string) => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
  };

  const addDraft = () => {
    setDrafts((current) => [...current, { key: crypto.randomUUID(), text: '' }]);
  };

  const createPlan = async () => {
    const stageTasks = drafts
      .map((draft) => ({ text: draft.text.trim(), due: draft.due?.trim() ? draft.due.trim() : undefined }))
      .filter((task) => task.text.length > 0);
    if (stageTasks.length === 0) {
      pushToast({ kind: 'info', text: 'Добавьте хотя бы одну задачу' });
      return;
    }
    setCreating(true);
    try {
      const params: PlanCreateParams = {
        title: title.trim().length > 0 ? title.trim() : 'Новый план',
        goal: goal.trim(),
        stages: [{ title: 'Задачи', tasks: stageTasks }],
        sources: noteRef !== undefined ? [noteRef] : undefined,
      };
      const response = await commands.planCreate(params);
      pushToast({ kind: 'success', text: 'План создан' });
      useVaultStore.getState().openNote(response.ref);
      useUiStore.getState().setRailView('tree');
      void useTasksStore.getState().loadTasks();
      setDrafts([]);
      setText('');
      setTitle('');
      setGoal('');
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось создать план') });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-m border border-stroke-0 bg-bg-1 p-4">
      <div className="flex items-center gap-2 text-ui text-text-1">
        <Sparkles size={16} strokeWidth={1.75} className="text-ai" />
        Идея в задачи
      </div>

      {noteRef === undefined ? (
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void decompose();
            }
          }}
          placeholder="1 - собрать требования… 2 - сделать прототип… 3 - показать команде до 2026-07-15"
          className="h-24 w-full resize-none rounded-s border border-stroke-1 bg-bg-2 px-3 py-2 text-body text-text-0 outline-none transition-colors duration-[120ms] placeholder:text-text-3 focus:border-accent/50"
        />
      ) : (
        <p className="text-caption text-text-2">Разложим текущую заметку на черновик задач.</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-caption text-text-2">Нумерованные и маркированные пункты станут задачами</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={assisting} onClick={() => void improveWithAssistant()}>
            <Wand2 size={14} strokeWidth={1.75} />
            Улучшить ассистентом
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decompose()}>
            {busy ? 'Раскладываю…' : 'Разложить по задачам'}
          </Button>
        </div>
      </div>

      <Presence>
        {hasDrafts ? (
          <motion.div
            key="drafts"
            variants={slideUpVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex flex-col gap-3 border-t border-stroke-0 pt-3"
          >
            <motion.ul
              variants={listContainerVariants}
              initial="initial"
              animate="animate"
              className="flex flex-col gap-1.5"
            >
              <Presence mode="popLayout">
                {drafts.map((draft) => (
                  <motion.li
                    key={draft.key}
                    variants={listItemVariants}
                    exit="exit"
                    className="flex items-center gap-2 rounded-s border border-transparent bg-bg-2 px-2 py-1.5 transition-colors duration-[120ms] focus-within:border-stroke-1"
                  >
                    <button
                      type="button"
                      title={priorityTitle(draft.priority)}
                      onClick={() => updateDraft(draft.key, { priority: nextPriority(draft.priority) })}
                      className="flex shrink-0 items-center justify-center rounded-xs p-0.5 transition-colors duration-[120ms] hover:bg-bg-3"
                    >
                      <Flag size={14} strokeWidth={1.75} className={priorityColor(draft.priority)} />
                    </button>
                    <input
                      value={draft.text}
                      onChange={(event) => updateDraft(draft.key, { text: event.target.value })}
                      placeholder="Задача…"
                      className="min-w-0 flex-1 bg-transparent text-ui text-text-0 outline-none placeholder:text-text-3"
                    />
                    <input
                      type="date"
                      value={draft.due ?? ''}
                      onChange={(event) =>
                        updateDraft(draft.key, { due: event.target.value.length > 0 ? event.target.value : undefined })
                      }
                      className="shrink-0 bg-transparent text-caption text-text-2 outline-none"
                    />
                    <button
                      type="button"
                      aria-label="Убрать задачу"
                      onClick={() => removeDraft(draft.key)}
                      className="flex shrink-0 items-center justify-center rounded-xs p-1 text-text-3 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-danger"
                    >
                      <X size={14} strokeWidth={1.75} />
                    </button>
                  </motion.li>
                ))}
              </Presence>
            </motion.ul>

            <button
              type="button"
              onClick={addDraft}
              className="inline-flex items-center gap-1.5 self-start rounded-s px-1.5 py-1 text-caption text-text-2 transition-colors duration-[120ms] hover:text-text-0"
            >
              <Plus size={14} strokeWidth={1.75} />
              Добавить задачу
            </button>

            <div className="flex flex-col gap-2 border-t border-stroke-0 pt-3">
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название плана" />
              <Input
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Цель плана — зачем это (необязательно)"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption text-text-3">
                  {validCount} {taskWord(validCount)}
                </span>
                <Button variant="primary" size="sm" disabled={creating || validCount === 0} onClick={() => void createPlan()}>
                  <ListChecks size={14} strokeWidth={1.75} />
                  {creating ? 'Создаю…' : 'Создать план'}
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </Presence>
    </div>
  );
}
