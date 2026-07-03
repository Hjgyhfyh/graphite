import { create } from 'zustand';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { TaskHit, TasksQueryParams } from '@graphite/bindings';
import { useUiStore } from './uiStore';

export type TaskFilter = 'open' | 'today' | 'overdue' | 'all';

export interface TasksStore {
  tasks: TaskHit[];
  filter: TaskFilter;
  loading: boolean;
  setFilter(f: TaskFilter): void;
  loadTasks(): Promise<void>;
  toggle(id: string): Promise<void>;
}

function paramsFor(filter: TaskFilter): TasksQueryParams {
  if (filter === 'all') {
    return { status: 'all' };
  }
  if (filter === 'overdue') {
    return { status: 'open', overdue: true };
  }
  if (filter === 'today') {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    return { status: 'open', dueBefore: `${year}-${month}-${day}` };
  }
  return { status: 'open' };
}

export const useTasksStore = create<TasksStore>()((set, get) => ({
  tasks: [],
  filter: 'open',
  loading: false,
  setFilter: (f) => {
    set({ filter: f });
    void get().loadTasks();
  },
  loadTasks: async () => {
    set({ loading: true });
    try {
      const response = await commands.tasksQuery(paramsFor(get().filter));
      set({ tasks: response.tasks, loading: false });
    } catch {
      set({ tasks: [], loading: false });
    }
  },
  toggle: async (id) => {
    const target = get().tasks.find((task) => task.id === id);
    if (target === undefined) {
      return;
    }
    const nextDone = !target.done;
    set((s) => ({ tasks: s.tasks.map((task) => (task.id === id ? { ...task, done: nextDone } : task)) }));
    try {
      await commands.taskCheck({ tasks: [{ id, done: nextDone }] });
    } catch (error) {
      set((s) => ({ tasks: s.tasks.map((task) => (task.id === id ? { ...task, done: target.done } : task)) }));
      useUiStore.getState().pushToast({
        kind: 'error',
        text: isGraphiteError(error) ? error.message : 'Не удалось обновить задачу',
      });
    }
  },
}));
