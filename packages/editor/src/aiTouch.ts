import { StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

export interface AiTouchRange {
  readonly from: number;
  readonly to: number;
}

export const setAiTouched = StateEffect.define<AiTouchRange>();
export const clearAiTouched = StateEffect.define<null>();

const aiLine = Decoration.line({ class: 'cm-gr-ai' });

/**
 * Marks whole lines within a range as "assistant-touched" (M13). The line class carries a
 * one-shot `--ai-dim` fade plus a left accent bar; decorations map through later edits so
 * the highlight stays anchored until cleared.
 */
export const aiTouchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setAiTouched)) {
        const doc = tr.state.doc;
        const from = Math.max(0, Math.min(effect.value.from, doc.length));
        const to = Math.max(from, Math.min(effect.value.to, doc.length));
        const add: Range<Decoration>[] = [];
        let line = doc.lineAt(from);
        for (;;) {
          add.push(aiLine.range(line.from));
          if (line.to >= to) {
            break;
          }
          line = doc.lineAt(line.to + 1);
        }
        next = next.update({ add, sort: true });
      } else if (effect.is(clearAiTouched)) {
        next = Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
