import { create } from 'zustand';

export interface TemplatePickerStore {
  open: boolean;
  openPicker(): void;
  closePicker(): void;
}

/**
 * Видимость пикера шаблонов — общая точка входа для палитры, меню «+» и хоткея,
 * чтобы не тащить проп через всё дерево. Эфемерный, без persist.
 */
export const useTemplatePickerStore = create<TemplatePickerStore>()((set) => ({
  open: false,
  openPicker: () => {
    set({ open: true });
  },
  closePicker: () => {
    set({ open: false });
  },
}));
