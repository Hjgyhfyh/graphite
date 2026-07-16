import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';
import { parseTableBlock } from './markdown';
import type { MdAlign, MdInline, MdTable } from './markdown';

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

function buildTables(view: EditorView): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const fmEnd = frontmatterEnd(doc);
  const selection = view.state.selection;
  const tree = syntaxTree(view.state);

  const touchesSelection = (from: number, to: number): boolean => {
    for (const range of selection.ranges) {
      if (range.from <= to && range.to >= from) {
        return true;
      }
    }
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Table') {
          return undefined;
        }
        // Внутрь таблицы (строки/ячейки) спускаться не нужно.
        if (fmEnd > 0 && node.from < fmEnd) {
          return false;
        }
        const firstLine = doc.lineAt(node.from);
        // node.to может указывать на начало строки за таблицей (если в границу
        // узла попал перевод строки) — берём на символ левее, чтобы блок не
        // проглотил следующую строку.
        const lastLine = doc.lineAt(Math.max(node.from, node.to - 1));
        const blockFrom = firstLine.from;
        const blockTo = lastLine.to;
        if (touchesSelection(blockFrom, blockTo)) {
          return false;
        }
        const source = doc.sliceString(blockFrom, blockTo);
        const table = parseTableBlock(source.split('\n'));
        if (table === null) {
          return false;
        }
        // Смещения строк документа (шапка, разделитель, тело…) от верха таблицы;
        // разделитель невидим, поэтому в rowOffsets попадают шапка + строки тела.
        const lineOffsets: number[] = [];
        let line = firstLine;
        for (;;) {
          lineOffsets.push(line.from - blockFrom);
          if (line.to >= blockTo) {
            break;
          }
          line = doc.lineAt(line.to + 1);
        }
        const rowOffsets =
          lineOffsets.length > 2 ? [lineOffsets[0], ...lineOffsets.slice(2)] : [lineOffsets[0] ?? 0];
        items.push(
          Decoration.replace({
            widget: new TableWidget(table, source, rowOffsets),
            block: true,
          }).range(blockFrom, blockTo),
        );
        return false;
      },
    });
  }

  return Decoration.set(items, true);
}

/**
 * Живой предпросмотр GFM-таблиц в редакторе: каждая таблица заменяется
 * отрендеренным `<table>` блочным виджетом, а сырой markdown возвращается, как
 * только выделение касается её строк, — так правка остаётся прямой. Обнаружение
 * идёт по дереву разбора (учитывает код-заборы и frontmatter), рендер ячеек — по
 * тем же правилам инлайна, что режим чтения.
 */
export const tablePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildTables(view);
    }

    update(update: ViewUpdate): void {
      // Разбор markdown асинхронный: сравнение деревьев ловит дозревание границ
      // таблицы, иначе только что дописанная строка-разделитель не превратила бы
      // абзац в таблицу до следующего ввода.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildTables(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
