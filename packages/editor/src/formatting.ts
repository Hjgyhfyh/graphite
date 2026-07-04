import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, EditorState, SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type InlineMarker = '**' | '*' | '~~' | '`';

export interface InlineFormatState {
  readonly strong: boolean;
  readonly em: boolean;
  readonly strike: boolean;
  readonly code: boolean;
}

function runEnds(state: EditorState, from: number, to: number, ch: string): boolean {
  const beforeOk = from === 0 || state.sliceDoc(from - 1, from) !== ch;
  const afterOk = to === state.doc.length || state.sliceDoc(to, to + 1) !== ch;
  return beforeOk && afterOk;
}

function wrappedOutside(state: EditorState, range: SelectionRange, marker: string): boolean {
  const width = marker.length;
  return (
    range.from >= width &&
    range.to + width <= state.doc.length &&
    state.sliceDoc(range.from - width, range.from) === marker &&
    state.sliceDoc(range.to, range.to + width) === marker &&
    runEnds(state, range.from - width, range.to + width, marker[0])
  );
}

function wrappedInside(state: EditorState, range: SelectionRange, marker: string): boolean {
  const width = marker.length;
  if (range.to - range.from < width * 2) {
    return false;
  }
  const inner = state.sliceDoc(range.from, range.to);
  return (
    inner.startsWith(marker) &&
    inner.endsWith(marker) &&
    (inner.length === width * 2 ||
      (inner[width] !== marker[0] && inner[inner.length - width - 1] !== marker[0]))
  );
}

/** Whether the main selection currently sits in the given inline formatting. */
export function hasInlineFormat(state: EditorState, marker: InlineMarker): boolean {
  const range = state.selection.main;
  return wrappedOutside(state, range, marker) || wrappedInside(state, range, marker);
}

/** Snapshot of inline formatting around the main selection, for menu state. */
export function inlineFormatState(state: EditorState): InlineFormatState {
  return {
    strong: hasInlineFormat(state, '**'),
    em: hasInlineFormat(state, '*'),
    strike: hasInlineFormat(state, '~~'),
    code: hasInlineFormat(state, '`'),
  };
}

/**
 * Toggles an inline markdown wrapper around every selection range: adds the
 * marker pair when absent, removes it when the range is already wrapped
 * (either just inside or just outside the selection). Empty selections get an
 * empty pair with the caret parked in the middle, ready for typing.
 */
export function toggleInlineFormat(view: EditorView, marker: InlineMarker): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const width = marker.length;
  view.dispatch({
    ...view.state.changeByRange((range) => {
      if (wrappedOutside(view.state, range, marker)) {
        return {
          changes: [
            { from: range.from - width, to: range.from },
            { from: range.to, to: range.to + width },
          ],
          range: EditorSelection.range(range.from - width, range.to - width),
        };
      }
      if (wrappedInside(view.state, range, marker)) {
        const inner = view.state.sliceDoc(range.from + width, range.to - width);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.to - width * 2),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + width, range.to + width),
      };
    }),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

const HEADING_PREFIX_RE = /^(\s{0,3})(#{1,6})\s+/;

export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Heading level of the line under the main selection head (0 = plain text). */
export function headingLevelAt(state: EditorState): HeadingLevel {
  const line = state.doc.lineAt(state.selection.main.head);
  const match = HEADING_PREFIX_RE.exec(line.text);
  return match !== null ? (match[2].length as HeadingLevel) : 0;
}

/**
 * Sets (or clears, with level 0) the ATX heading level for every line touched
 * by the selection. Existing `#` prefixes are replaced in place; indentation
 * is preserved and the rest of the line is never rewritten.
 */
export function setHeadingLevel(view: EditorView, level: HeadingLevel): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    let pos = range.from;
    for (;;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const match = HEADING_PREFIX_RE.exec(line.text);
        const indent = match !== null ? match[1] : (/^\s{0,3}/.exec(line.text)?.[0] ?? '');
        const prefixLen = match !== null ? match[0].length : indent.length;
        const insert = level === 0 ? indent : `${indent}${'#'.repeat(level)} `;
        const current = line.text.slice(0, prefixLen);
        if (current !== insert) {
          changes.push({ from: line.from, to: line.from + prefixLen, insert });
        }
      }
      if (line.to >= range.to) {
        break;
      }
      pos = line.to + 1;
    }
  }
  if (changes.length === 0) {
    return true;
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input' });
  return true;
}
