import { EditorView } from '@codemirror/view';

export const graphiteDark = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--bg-0)',
      color: 'var(--text-0)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-ui, "Inter Variable", system-ui, sans-serif)',
      fontSize: '15.5px',
      lineHeight: '26px',
      justifyContent: 'center',
    },
    '.cm-content': {
      maxWidth: '70ch',
      minWidth: '0',
      flexGrow: '1',
      flexShrink: '1',
      padding: '48px 24px 96px',
      caretColor: 'var(--accent)',
    },
    '.cm-line': {
      padding: '0 2px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeft: '2px solid var(--accent)',
      borderRadius: '2px',
      marginLeft: '-1px',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    },
    '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 35%, transparent)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-1)',
      color: 'var(--text-0)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--stroke-0)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--stroke-0)',
    },
    '.cm-panel': {
      fontFamily: 'var(--font-ui, system-ui, sans-serif)',
    },
    '.cm-panel.cm-search label': {
      color: 'var(--text-1)',
    },
    '.cm-panel.cm-search button[name="close"]': {
      color: 'var(--text-1)',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--bg-2)',
      border: '1px solid var(--stroke-1)',
      borderRadius: 'var(--r-xs, 6px)',
      color: 'var(--text-0)',
    },
    '.cm-button': {
      backgroundColor: 'var(--bg-3)',
      backgroundImage: 'none',
      border: '1px solid var(--stroke-1)',
      borderRadius: 'var(--r-xs, 6px)',
      color: 'var(--text-0)',
    },
    '.cm-button:active': {
      backgroundColor: 'var(--bg-4)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-2)',
      border: '1px solid var(--stroke-1)',
      borderRadius: 'var(--r-s, 10px)',
      boxShadow: 'var(--sh-2)',
      color: 'var(--text-0)',
      overflow: 'hidden',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-ui, system-ui, sans-serif)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '3px 8px',
      color: 'var(--text-1)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--bg-3)',
      color: 'var(--text-0)',
    },
    '.cm-placeholder': {
      color: 'var(--text-2)',
    },
  },
  { dark: true },
);
