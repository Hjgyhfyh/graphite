import { EditorSelection, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([^`]*)$/;
const BOX_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX/]\]/;

interface DoneRegion {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly innerPos: number;
}

/** Секция «## Готово»: от заголовка до следующего заголовка уровня ≤2 или конца документа. */
function findDoneRegion(state: EditorState): DoneRegion | null {
  const doc = state.doc;
  let inFence = false;
  let startLine = -1;
  let count = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = HEADING_RE.exec(text);
    if (heading !== null) {
      const level = heading[1].length;
      if (startLine === -1) {
        if (level === 2 && heading[2].trim().toLowerCase().replace(/ё/g, 'е') === 'готово') {
          startLine = n;
        }
      } else if (level <= 2) {
        return makeRegion(state, startLine, n - 1, count);
      }
      continue;
    }
    if (startLine !== -1 && BOX_RE.test(text)) {
      count += 1;
    }
  }
  return startLine === -1 ? null : makeRegion(state, startLine, doc.lines, count);
}

function makeRegion(state: EditorState, startLine: number, lastLine: number, count: number): DoneRegion {
  const doc = state.doc;
  const from = doc.line(startLine).from;
  const to = doc.line(lastLine).to;
  const innerPos = startLine < doc.lines ? doc.line(startLine + 1).from : from;
  return { from, to, count, innerPos };
}

/** Compact capsule shown instead of the raw "Готово" section. */
class DoneCapsuleWidget extends WidgetType {
  constructor(
    readonly count: number,
    readonly innerPos: number,
  ) {
    super();
  }

  eq(other: DoneCapsuleWidget): boolean {
    return other.count === this.count && other.innerPos === this.innerPos;
  }

  get estimatedHeight(): number {
    return 52;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-gr-fm-wrap';

    const capsule = document.createElement('button');
    capsule.type = 'button';
    capsule.className = 'cm-gr-fm-capsule';
    capsule.title = 'Показать сделанное';
    capsule.setAttribute('aria-label', 'Секция «Готово» — развернуть');

    const icon = document.createElement('span');
    icon.className = 'cm-gr-fm-icon';
    icon.innerHTML = CHECK_ICON;
    capsule.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cm-gr-fm-label';
    label.textContent = 'Готово';
    capsule.appendChild(label);

    if (this.count > 0) {
      const count = document.createElement('span');
      count.className = 'cm-gr-fm-count';
      count.textContent = String(this.count);
      capsule.appendChild(count);
    }

    const chips = document.createElement('span');
    chips.className = 'cm-gr-fm-chips';
    capsule.appendChild(chips);

    const chevron = document.createElement('span');
    chevron.className = 'cm-gr-fm-chevron';
    chevron.innerHTML = CHEVRON_ICON;
    capsule.appendChild(chevron);

    const expand = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = Math.min(this.innerPos, view.state.doc.length);
      view.dispatch({
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true,
      });
      view.focus();
    };
    capsule.addEventListener('mousedown', expand);
    wrap.appendChild(capsule);

    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function selectionInside(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.to >= from && range.from <= to) {
      return true;
    }
  }
  return false;
}

function buildFold(state: EditorState): DecorationSet {
  const region = findDoneRegion(state);
  if (region === null || selectionInside(state, region.from, region.to)) {
    return Decoration.none;
  }
  const widget = new DoneCapsuleWidget(region.count, region.innerPos);
  return Decoration.set([Decoration.replace({ widget, block: true }).range(region.from, region.to)]);
}

/**
 * Folds the "## Готово" section into a compact capsule while the selection is
 * outside it: done items stay in the note (history is preserved) but no longer
 * crowd the next plan. Clicking the capsule (or moving the caret inside)
 * reveals the raw section; the fold snaps back once the caret leaves.
 */
export const doneFold = StateField.define<DecorationSet>({
  create(state) {
    return buildFold(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection !== undefined) {
      return buildFold(tr.state);
    }
    return deco;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});
