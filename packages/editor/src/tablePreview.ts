import { StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';
import { parseTableBlock, parseTableDelimiter, splitTableRow } from './markdown';
import type { MdAlign, MdInline, MdTable } from './markdown';

// Блочные виджеты обязаны приходить из StateField, а не из ViewPlugin (CodeMirror
// иначе бросает «Block decorations may not be specified via plugins»): карта высот
// считается до обновления плагинов. Поэтому обнаружение таблиц синхронное и по
// всему документу — как в doneFold/frontmatterHide.

const FENCE_RE = /^\s{0,3}(?:```+|~~~+)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

const ALIGN_CLASS: Record<Exclude<MdAlign, null>, string> = {
  left: 'cm-gr-td-left',
  center: 'cm-gr-td-center',
  right: 'cm-gr-td-right',
};

/** Инлайн-дерево ячейки → узлы DOM (через textContent, без innerHTML — контент экранирован). */
function appendInline(parent: HTMLElement, nodes: readonly MdInline[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        parent.appendChild(document.createTextNode(node.value));
        break;
      case 'strong': {
        const el = document.createElement('strong');
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      case 'em': {
        const el = document.createElement('em');
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      case 'del': {
        const el = document.createElement('del');
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      case 'code': {
        const el = document.createElement('code');
        el.className = 'cm-gr-td-code';
        el.textContent = node.value;
        parent.appendChild(el);
        break;
      }
      case 'tag': {
        const el = document.createElement('span');
        el.className = 'cm-gr-td-tag';
        el.textContent = `#${node.value}`;
        parent.appendChild(el);
        break;
      }
      case 'wikilink': {
        const el = document.createElement('span');
        el.className = 'cm-gr-td-link';
        el.textContent = node.label;
        parent.appendChild(el);
        break;
      }
      case 'link': {
        const el = document.createElement('span');
        el.className = 'cm-gr-td-link';
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Отрендеренная таблица заменяет свои строки блочным виджетом. `rowOffsets` —
 * смещение начала каждой видимой строки (шапка + строки тела) от верха таблицы,
 * чтобы клик по ячейке возвращал сырой markdown с курсором в той же строке.
 */
class TableWidget extends WidgetType {
  constructor(
    readonly table: MdTable,
    readonly key: string,
    readonly rowOffsets: readonly number[],
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.key === this.key;
  }

  get estimatedHeight(): number {
    return (this.table.rows.length + 1) * 35 + 16;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-gr-table-wrap';

    const table = document.createElement('table');
    table.className = 'cm-gr-table';

    const alignClass = (col: number): string => {
      const align = this.table.aligns[col];
      return align != null ? ALIGN_CLASS[align] : '';
    };

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const headOff = String(this.rowOffsets[0] ?? 0);
    this.table.header.forEach((cell, col) => {
      const th = document.createElement('th');
      const cls = alignClass(col);
      if (cls.length > 0) {
        th.className = cls;
      }
      th.dataset.off = headOff;
      appendInline(th, cell);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.table.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      const off = String(this.rowOffsets[r + 1] ?? this.rowOffsets[0] ?? 0);
      row.forEach((cell, col) => {
        const td = document.createElement('td');
        const cls = alignClass(col);
        if (cls.length > 0) {
          td.className = cls;
        }
        td.dataset.off = off;
        appendInline(td, cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Клик по таблице возвращает её сырой markdown и ставит курсор в строку под
    // указателем — правка остаётся прямой, ровно как у превью картинок (#29).
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target instanceof HTMLElement ? event.target : null;
      const cell = target?.closest('th, td');
      const off = cell instanceof HTMLElement && cell.dataset.off !== undefined ? Number(cell.dataset.off) : 0;
      const base = view.posAtDOM(wrap);
      const max = view.state.doc.length;
      const pos = Math.min(Math.max(base + off, 0), max);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });

    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Строка обрывает тело таблицы: пусто, нет «|», ограда кода или заголовок. */
function endsTable(text: string): boolean {
  return text.trim().length === 0 || !text.includes('|') || FENCE_RE.test(text) || HEADING_RE.test(text);
}

function buildTables(state: EditorState): DecorationSet {
  const doc = state.doc;
  const items: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(doc);
  const selection = state.selection;

  const touchesSelection = (from: number, to: number): boolean => {
    for (const range of selection.ranges) {
      if (range.from <= to && range.to >= from) {
        return true;
      }
    }
    return false;
  };

  const total = doc.lines;
  let inFence = false;
  let n = 1;
  while (n <= total) {
    const line = doc.line(n);
    // Внутри frontmatter таблиц нет.
    if (fmEnd > 0 && line.to <= fmEnd) {
      n += 1;
      continue;
    }
    const text = line.text;
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      n += 1;
      continue;
    }
    if (inFence) {
      n += 1;
      continue;
    }
    // Таблица: строка-шапка + строка-разделитель с тем же числом колонок.
    if (n < total) {
      const aligns = parseTableDelimiter(doc.line(n + 1).text);
      if (aligns !== null && splitTableRow(text).length === aligns.length) {
        let last = n + 1;
        let j = n + 2;
        while (j <= total && !endsTable(doc.line(j).text)) {
          last = j;
          j += 1;
        }
        const blockFrom = line.from;
        const blockTo = doc.line(last).to;
        if (!touchesSelection(blockFrom, blockTo)) {
          const sourceLines: string[] = [];
          const rowOffsets: number[] = [];
          for (let k = n; k <= last; k += 1) {
            const row = doc.line(k);
            sourceLines.push(row.text);
            // Разделитель (вторая строка) в отрендеренной таблице не показывается.
            if (k !== n + 1) {
              rowOffsets.push(row.from - blockFrom);
            }
          }
          const table = parseTableBlock(sourceLines);
          if (table !== null) {
            items.push(
              Decoration.replace({
                widget: new TableWidget(table, sourceLines.join('\n'), rowOffsets),
                block: true,
              }).range(blockFrom, blockTo),
            );
          }
        }
        n = last + 1;
        continue;
      }
    }
    n += 1;
  }

  return Decoration.set(items, true);
}

/**
 * Живой предпросмотр GFM-таблиц в редакторе: каждая таблица заменяется
 * отрендеренным `<table>` блочным виджетом, а сырой markdown возвращается, как
 * только выделение касается её строк, — так правка остаётся прямой. Рендер ячеек
 * идёт по тем же правилам инлайна, что и режим чтения.
 */
export const tablePreview = StateField.define<DecorationSet>({
  create(state) {
    return buildTables(state);
  },
  update(value, tr) {
    // Пересобираем при правках и при движении курсора/выделения (сырой markdown
    // возвращается, когда выделение заходит на строки таблицы). Прочие транзакции
    // границ не двигают — отдаём прежний набор.
    if (tr.docChanged || tr.selection !== undefined) {
      return buildTables(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
