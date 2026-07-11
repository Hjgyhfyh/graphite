import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { DONE_BLOCK_END_RE, DONE_BLOCK_START_RE } from './markdown';

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([^`]*)$/;
const BOX_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX/]\]/;

/** Свёрнутый регион «Готово»: маркер-блок от свипа выделения или легаси-секция `## Готово`. */
interface DoneRegion {
  /** Стабильный ключ: вид + подпись + порядковый номер одинаковых подписей. */
  readonly key: string;
  readonly kind: 'block' | 'section';
  readonly label: string;
  /** Границы всего региона (включая маркеры/заголовок). */
  readonly from: number;
  readonly to: number;
  /** Строка стартового маркера/заголовка — шапка развёрнутого блока. */
  readonly headFrom: number;
  readonly headTo: number;
  /** Строка закрывающего маркера (только kind='block'). */
  readonly endFrom: number;
  readonly endTo: number;
  /** Непустые строки содержимого — счётчик в капсуле. */
  readonly count: number;
}

/** Разворачивает/сворачивает блок по ключу региона. */
const toggleDone = StateEffect.define<string>();

function findDoneRegions(state: EditorState): DoneRegion[] {
  const doc = state.doc;
  const regions: DoneRegion[] = [];
  const seen = new Map<string, number>();

  const push = (
    kind: 'block' | 'section',
    label: string,
    startLine: number,
    lastLine: number,
    endLine: number,
    count: number,
  ) => {
    const base = `${kind}:${label}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    const head = doc.line(startLine);
    const end = endLine > 0 ? doc.line(endLine) : head;
    regions.push({
      key: `${base}#${nth}`,
      kind,
      label,
      from: head.from,
      to: doc.line(lastLine).to,
      headFrom: head.from,
      headTo: head.to,
      endFrom: end.from,
      endTo: end.to,
      count,
    });
  };

  let inFence = false;
  let n = 1;
  while (n <= doc.lines) {
    const text = doc.line(n).text;
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      n += 1;
      continue;
    }
    if (inFence) {
      n += 1;
      continue;
    }

    const start = DONE_BLOCK_START_RE.exec(text);
    if (start !== null) {
      let count = 0;
      let endLine = -1;
      for (let m = n + 1; m <= doc.lines; m++) {
        const inner = doc.line(m).text;
        if (DONE_BLOCK_END_RE.test(inner)) {
          endLine = m;
          break;
        }
        if (inner.trim().length > 0) {
          count += 1;
        }
      }
      if (endLine === -1) {
        n += 1;
        continue;
      }
      push('block', start[1], n, endLine, endLine, count);
      n = endLine + 1;
      continue;
    }

    const heading = HEADING_RE.exec(text);
    if (heading !== null && heading[1].length === 2) {
      const title = heading[2].trim();
      if (title.toLowerCase().replace(/ё/g, 'е').startsWith('готово')) {
        let lastLine = doc.lines;
        let count = 0;
        for (let m = n + 1; m <= doc.lines; m++) {
          const inner = doc.line(m).text;
          const h = HEADING_RE.exec(inner);
          if (h !== null && h[1].length <= 2) {
            lastLine = m - 1;
            break;
          }
          if (BOX_RE.test(inner)) {
            count += 1;
          }
        }
        push('section', title, n, lastLine, -1, count);
        n = lastLine + 1;
        continue;
      }
    }
    n += 1;
  }
  return regions;
}

function labelParts(label: string): { title: string; date: string } {
  if (label.length === 0) {
    return { title: 'Готово', date: '' };
  }
  return { title: 'Готово', date: label };
}

/** Свёрнутый блок: одна капсула вместо всего региона. */
class DoneCapsuleWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly label: string,
    readonly count: number,
  ) {
    super();
  }

  eq(other: DoneCapsuleWidget): boolean {
    return other.key === this.key && other.label === this.label && other.count === this.count;
  }

  get estimatedHeight(): number {
    return 46;
  }

  toDOM(view: EditorView): HTMLElement {
    const { title, date } = labelParts(this.label);
    const wrap = document.createElement('div');
    wrap.className = 'cm-gr-done-wrap';

    const capsule = document.createElement('button');
    capsule.type = 'button';
    capsule.className = 'cm-gr-done-capsule';
    capsule.title = 'Развернуть блок «Готово»';
    capsule.setAttribute('aria-label', `Блок «Готово»${date.length > 0 ? ` от ${date}` : ''} — развернуть`);

    const icon = document.createElement('span');
    icon.className = 'cm-gr-done-icon';
    icon.innerHTML = CHECK_ICON;
    capsule.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cm-gr-done-label';
    label.textContent = title;
    capsule.appendChild(label);

    if (date.length > 0) {
      const chip = document.createElement('span');
      chip.className = 'cm-gr-done-date';
      chip.textContent = date;
      capsule.appendChild(chip);
    }

    const count = document.createElement('span');
    count.className = 'cm-gr-done-count';
    count.textContent = `${this.count} стр.`;
    capsule.appendChild(count);

    const chevron = document.createElement('span');
    chevron.className = 'cm-gr-done-chevron';
    chevron.innerHTML = CHEVRON_ICON;
    capsule.appendChild(chevron);

    const key = this.key;
    capsule.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleDone.of(key) });
    });
    wrap.appendChild(capsule);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Шапка развёрнутого блока — заменяет строку маркера/заголовка, клик сворачивает. */
class DoneHeadWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly label: string,
  ) {
    super();
  }

  eq(other: DoneHeadWidget): boolean {
    return other.key === this.key && other.label === this.label;
  }

  get estimatedHeight(): number {
    return 34;
  }

  toDOM(view: EditorView): HTMLElement {
    const { title, date } = labelParts(this.label);
    const wrap = document.createElement('div');
    wrap.className = 'cm-gr-done-wrap';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'cm-gr-done-capsule cm-gr-done-open';
    head.title = 'Свернуть блок «Готово»';
    head.setAttribute('aria-label', 'Свернуть блок «Готово»');

    const icon = document.createElement('span');
    icon.className = 'cm-gr-done-icon';
    icon.innerHTML = CHECK_ICON;
    head.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cm-gr-done-label';
    label.textContent = title;
    head.appendChild(label);

    if (date.length > 0) {
      const chip = document.createElement('span');
      chip.className = 'cm-gr-done-date';
      chip.textContent = date;
      head.appendChild(chip);
    }

    const chevron = document.createElement('span');
    chevron.className = 'cm-gr-done-chevron cm-gr-done-chevron-up';
    chevron.innerHTML = CHEVRON_ICON;
    head.appendChild(chevron);

    const key = this.key;
    head.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleDone.of(key) });
    });
    wrap.appendChild(head);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Нижняя кромка развёрнутого блока — прячет закрывающий маркер. */
class DoneEndWidget extends WidgetType {
  constructor(readonly key: string) {
    super();
  }

  eq(other: DoneEndWidget): boolean {
    return other.key === this.key;
  }

  get estimatedHeight(): number {
    return 14;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-gr-done-endline';
    wrap.title = 'Свернуть блок «Готово»';
    const key = this.key;
    wrap.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleDone.of(key) });
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface DoneFoldState {
  readonly expanded: ReadonlySet<string>;
  readonly deco: DecorationSet;
}

function buildDeco(state: EditorState, expanded: ReadonlySet<string>): DecorationSet {
  const regions = findDoneRegions(state);
  if (regions.length === 0) {
    return Decoration.none;
  }
  const decos = [];
  for (const region of regions) {
    if (!expanded.has(region.key)) {
      decos.push(
        Decoration.replace({ widget: new DoneCapsuleWidget(region.key, region.label, region.count), block: true }).range(
          region.from,
          region.to,
        ),
      );
      continue;
    }
    decos.push(
      Decoration.replace({ widget: new DoneHeadWidget(region.key, region.label), block: true }).range(
        region.headFrom,
        region.headTo,
      ),
    );
    if (region.kind === 'block') {
      decos.push(
        Decoration.replace({ widget: new DoneEndWidget(region.key), block: true }).range(region.endFrom, region.endTo),
      );
    }
  }
  return Decoration.set(decos, true);
}

/**
 * Блоки «Готово»: каждый убранный план сжимается на месте в отдельную капсулу
 * (без свалки в одну секцию) и раскрывается/сворачивается ТОЛЬКО кликом —
 * курсор и печать рядом блок не трогают. Виджеты стабильны между вводами
 * (eq по ключу), поэтому ничего не мигает при наборе текста.
 */
export const doneFold = StateField.define<DoneFoldState>({
  create(state) {
    const expanded = new Set<string>();
    return { expanded, deco: buildDeco(state, expanded) };
  },
  update(value, tr) {
    let expanded: Set<string> | null = null;
    for (const effect of tr.effects) {
      if (effect.is(toggleDone)) {
        expanded = expanded ?? new Set(value.expanded);
        if (expanded.has(effect.value)) {
          expanded.delete(effect.value);
        } else {
          expanded.add(effect.value);
        }
      }
    }
    if (expanded === null && !tr.docChanged) {
      return value;
    }
    const next = expanded ?? (value.expanded as Set<string>);
    return { expanded: next, deco: buildDeco(tr.state, next) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    EditorView.atomicRanges.of((view) => view.state.field(field).deco),
  ],
});
