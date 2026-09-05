import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Доля высоты окна сверху и снизу, которую курсор не должен пересекать. */
const MARGIN_RATIO = 0.38;

/**
 * Печатная машинка: курсор держится в средней полосе экрана при наборе
 * и переходе по строкам. Реализовано через scrollMargins CodeMirror —
 * без лишних транзакций и дёрганья undo.
 */
export function typewriterScroll(): Extension {
  return EditorView.scrollMargins.of((view) => {
    const space = Math.max(0, Math.round(view.scrollDOM.clientHeight * MARGIN_RATIO));
    return { top: space, bottom: space };
  });
}
