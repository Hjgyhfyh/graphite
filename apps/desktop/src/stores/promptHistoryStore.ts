import { create } from 'zustand';

interface PromptHistoryStore {
  open: boolean;
  setOpen(open: boolean): void;
}

/** Видимость оверлея «История промтов». Эфемерный, без persist. */
export const usePromptHistoryStore = create<PromptHistoryStore>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openPromptHistory(): void {
  usePromptHistoryStore.getState().setOpen(true);
}
