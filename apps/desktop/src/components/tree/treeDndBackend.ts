import { TouchBackend } from 'react-dnd-touch-backend';

let dropClickArmed = false;

const disarmOnNextPress = () => {
  dropClickArmed = false;
};

const suppressContextMenu = (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * DnD-бэкенд дерева на мышиных событиях: нативный HTML5-DnD в Tauri-окне на
 * Windows перехватывается drag-drop-обработчиком WebView2 (он нужен для дропа
 * внешних файлов), поэтому drop-события react-arborist до DOM не доходят.
 * TouchBackend хит-тестит цели через elementsFromPoint и от нативного
 * OLE-канала не зависит.
 */
export const treeDndBackend: typeof TouchBackend = (manager, context, options) => {
  const monitor = manager.getMonitor();
  let dragging = false;
  const clearDragState = () => {
    document.body.classList.remove('tree-dragging');
    document.removeEventListener('contextmenu', suppressContextMenu, true);
  };
  monitor.subscribeToStateChange(() => {
    const next = monitor.isDragging();
    if (next === dragging) {
      return;
    }
    dragging = next;
    if (next) {
      document.body.classList.add('tree-dragging');
      document.addEventListener('contextmenu', suppressContextMenu, true);
    } else {
      clearDragState();
      // Отпускание кнопки в конце переноса рождает обычный click по элементу
      // под курсором. Взводим флаг до следующего нажатия, чтобы этот клик не
      // сработал как выбор строки (иначе дроп открывал бы случайную заметку).
      dropClickArmed = true;
      document.addEventListener('mousedown', disarmOnNextPress, { capture: true, once: true });
    }
  });
  // Только мышь: с touch-событиями бэкенд перехватывал бы пальцевый скролл
  // дерева, а задержки старта (delay*) гоняют mousedown через setTimeout и
  // теряют быстрые рывки. Тач-тап всё равно кликает через compatibility-мышь.
  const backend = TouchBackend(manager, context, {
    ...options,
    enableMouseEvents: true,
    enableTouchEvents: false,
    enableKeyboardEvents: true,
    ignoreContextMenu: true,
    touchSlop: 4,
  });
  const teardown = backend.teardown.bind(backend);
  backend.teardown = () => {
    // Размонтирование дерева посреди переноса не даст END_DRAG — снимаем
    // глобальное drag-состояние вручную, иначе класс на body залипнет.
    clearDragState();
    teardown();
  };
  return backend;
};

/** Съедает клик, рождённый отпусканием кнопки после переноса в дереве. */
export function consumeTreeDropClick(): boolean {
  const armed = dropClickArmed;
  dropClickArmed = false;
  return armed;
}
