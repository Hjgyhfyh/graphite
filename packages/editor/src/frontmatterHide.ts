import { EditorSelection, EditorState, StateField } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

/** Правая граница скрытой зоны: закрывающий `---` вместе с переносом после
 * него, иначе сверху оставалась бы пустая первая строка. Перенос — всегда одна
 * позиция CodeMirror, в том числе при CRLF-разделителе. */
function hideBound(doc: Text): number {
  const end = frontmatterEnd(doc);
  if (end <= 0) {
    return 0;
  }
  return end < doc.length ? end + 1 : end;
}

function buildHidden(state: EditorState): DecorationSet {
  const bound = hideBound(state.doc);
  if (bound <= 0) {
    return Decoration.none;
  }
  return Decoration.set([Decoration.replace({ block: true }).range(0, bound)]);
}

const hiddenField = StateField.define<DecorationSet>({
  create(state) {
    return buildHidden(state);
  },
  update(deco, tr) {
    return tr.docChanged ? buildHidden(tr.state) : deco;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

// atomicRanges ограничивают только навигацию, а не сами транзакции: Ctrl+Home,
// восстановление курсора после setDoc или переход к найденному совпадению
// ставят выделение программно и могут завести его в скрытую зону — фильтр
// выталкивает такие концы на границу. Он же гасит удаление через границу:
// команды удаления расширяются по атомарному диапазону на весь скрытый блок,
// и без вето Backspace в начале видимого текста незаметно стирал бы свойства.
const guardSelection = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged && tr.isUserEvent('delete')) {
    const before = hideBound(tr.startState.doc);
    if (before > 0) {
      let intoHidden = false;
      tr.changes.iterChangedRanges((fromA) => {
        if (fromA < before) {
          intoHidden = true;
        }
      });
      if (intoHidden) {
        return [];
      }
    }
  }
  const bound = hideBound(tr.newDoc);
  if (bound <= 0) {
    return tr;
  }
  let moved = false;
  const ranges = tr.newSelection.ranges.map((range) => {
    if (range.from >= bound) {
      return range;
    }
    moved = true;
    return EditorSelection.range(Math.max(bound, range.anchor), Math.max(bound, range.head));
  });
  if (!moved) {
    return tr;
  }
  return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
});

// Создание состояния и включение через Compartment не проходят через фильтры,
// поэтому курсор может «родиться» внутри скрытой зоны. Дожидаемся конца
// текущего цикла обновления (dispatch внутри него запрещён) и выводим его.
const escapeOnEnable = ViewPlugin.define((view) => {
  queueMicrotask(() => {
    if (view.state.field(hiddenField, false) === undefined) {
      return;
    }
    const bound = hideBound(view.state.doc);
    if (bound > 0 && view.state.selection.main.from < bound) {
      view.dispatch({ selection: EditorSelection.cursor(bound) });
    }
  });
  return {};
});

/**
 * Полностью прячет ведущий YAML-блок вместе с обеими линиями `---`: в файле
 * свойства остаются (автосейв и панель свойств работают как раньше), но в
 * редакторе блок не занимает ни пикселя и недостижим для курсора.
 */
export function frontmatterHide(): Extension {
  return [hiddenField, guardSelection, escapeOnEnable];
}
