import { EditorSelection, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { frontmatterEnd, parseFrontmatter } from './frontmatter';

const SLIDERS_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>';

const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

const CHIP_LIMIT = 5;
const VALUE_LIMIT = 26;

function clip(value: string): string {
  return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT - 1)}…` : value;
}

function chipText(key: string, value: string, items: readonly string[]): string {
  if (items.length > 0) {
    return `${key} · ${items.length}`;
  }
  if (key === 'title' && value.length > 0) {
    return clip(value);
  }
  return key;
}

/** Compact one-line summary widget shown instead of the raw YAML block. */
class FrontmatterCapsuleWidget extends WidgetType {
  constructor(
    readonly summary: string,
    readonly count: number,
    readonly chips: readonly string[],
    readonly overflow: number,
    readonly innerPos: number,
  ) {
    super();
  }

  eq(other: FrontmatterCapsuleWidget): boolean {
    return other.summary === this.summary && other.innerPos === this.innerPos;
  }

  get estimatedHeight(): number {
    return 40;
  }

  toDOM(view: EditorView): HTMLElement {
    const capsule = document.createElement('button');
    capsule.type = 'button';
    capsule.className = 'cm-gr-fm-capsule';
    capsule.title = 'Показать свойства заметки';
    capsule.setAttribute('aria-label', 'Свойства заметки — развернуть');

    const icon = document.createElement('span');
    icon.className = 'cm-gr-fm-icon';
    icon.innerHTML = SLIDERS_ICON;
    capsule.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cm-gr-fm-label';
    label.textContent = 'Свойства';
    capsule.appendChild(label);

    if (this.count > 0) {
      const count = document.createElement('span');
      count.className = 'cm-gr-fm-count';
      count.textContent = String(this.count);
      capsule.appendChild(count);
    }

    const chips = document.createElement('span');
    chips.className = 'cm-gr-fm-chips';
    for (const text of this.chips) {
      const chip = document.createElement('span');
      chip.className = 'cm-gr-fm-chip';
      chip.textContent = text;
      chips.appendChild(chip);
    }
    if (this.overflow > 0) {
      const more = document.createElement('span');
      more.className = 'cm-gr-fm-chip cm-gr-fm-chip-more';
      more.textContent = `+${this.overflow}`;
      chips.appendChild(more);
    }
    capsule.appendChild(chips);

    const chevron = document.createElement('span');
    chevron.className = 'cm-gr-fm-chevron';
    chevron.innerHTML = CHEVRON_ICON;
    capsule.appendChild(chevron);

    const expand = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const max = view.state.doc.length;
      const anchor = Math.min(this.innerPos, max);
      view.dispatch({
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true,
      });
      view.focus();
    };
    capsule.addEventListener('mousedown', expand);

    return capsule;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function selectionInside(state: EditorState, end: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.to > 0 && range.from < end) {
      return true;
    }
  }
  return false;
}

function buildFold(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state.doc);
  if (end <= 0 || selectionInside(state, end)) {
    return Decoration.none;
  }
  const block = state.sliceDoc(0, end);
  const parsed = parseFrontmatter(block);
  const entries = parsed?.entries ?? [];
  const chips = entries.slice(0, CHIP_LIMIT).map((entry) => chipText(entry.key, entry.value, entry.items));
  const innerPos = state.doc.lines >= 2 ? state.doc.line(2).from : 0;
  const widget = new FrontmatterCapsuleWidget(
    `${block.length}:${chips.join('|')}`,
    entries.length,
    chips,
    Math.max(0, entries.length - CHIP_LIMIT),
    innerPos,
  );
  return Decoration.set([Decoration.replace({ widget, block: true }).range(0, end)]);
}

/**
 * Folds a leading YAML frontmatter block into a compact "properties capsule"
 * while the selection is outside it (#10). Clicking the capsule (or moving the
 * caret inside) reveals the raw, softly dimmed YAML for direct editing; the
 * fold snaps back once the caret leaves. Block decorations live in a state
 * field so the viewport geometry stays correct.
 */
export const frontmatterFold = StateField.define<DecorationSet>({
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
