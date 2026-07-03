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
    '.cm-gr-h1': {
      fontSize: '28px',
      lineHeight: '34px',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      color: 'var(--text-0)',
      paddingTop: '10px',
    },
    '.cm-gr-h2': {
      fontSize: '22px',
      lineHeight: '30px',
      fontWeight: '600',
      letterSpacing: '-0.01em',
      color: 'var(--text-0)',
      paddingTop: '8px',
    },
    '.cm-gr-h3': {
      fontSize: '18px',
      lineHeight: '26px',
      fontWeight: '600',
      color: 'var(--text-0)',
      paddingTop: '6px',
    },
    '.cm-gr-h4': {
      fontSize: '16px',
      lineHeight: '24px',
      fontWeight: '600',
      color: 'var(--text-1)',
    },
    '.cm-gr-h5': {
      fontSize: '15.5px',
      fontWeight: '600',
      color: 'var(--text-2)',
    },
    '.cm-gr-h6': {
      fontSize: '15.5px',
      fontWeight: '600',
      color: 'var(--text-2)',
    },
    '.cm-gr-mark': {
      color: 'var(--text-3)',
      fontWeight: '400',
    },
    '.cm-gr-strong': {
      fontWeight: '650',
      color: 'var(--text-0)',
    },
    '.cm-gr-em': {
      fontStyle: 'italic',
    },
    '.cm-gr-code': {
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: '0.92em',
      backgroundColor: 'var(--bg-2)',
      borderRadius: 'var(--r-xs, 6px)',
      padding: '0.08em 0.32em',
      color: 'var(--text-0)',
    },
    '.cm-gr-link': {
      color: 'var(--accent)',
      textUnderlineOffset: '2px',
    },
    '.cm-gr-list-mark': {
      color: 'var(--accent)',
    },
    '.cm-gr-quote': {
      borderLeft: '2px solid var(--stroke-1)',
      paddingLeft: '14px',
      color: 'var(--text-1)',
      fontStyle: 'italic',
    },
    '.cm-gr-fence': {
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: '13.5px',
      lineHeight: '22px',
      backgroundColor: 'var(--bg-1)',
      color: 'var(--text-1)',
    },
    '.cm-gr-hr': {
      position: 'relative',
      color: 'var(--text-3)',
    },
    '.cm-gr-checkbox': {
      display: 'inline-flex',
      width: '15px',
      height: '15px',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: '-2px',
      border: '1.5px solid var(--stroke-1)',
      borderRadius: 'var(--r-xs, 6px)',
      color: 'transparent',
      cursor: 'pointer',
      textDecoration: 'none',
      transition: 'background-color 120ms var(--ease-out), border-color 120ms var(--ease-out)',
    },
    '.cm-gr-checkbox:hover': {
      borderColor: 'var(--accent)',
    },
    '.cm-gr-checkbox-on': {
      backgroundColor: 'var(--accent)',
      borderColor: 'var(--accent)',
      color: 'var(--bg-0)',
    },
    '.cm-gr-task-done': {
      color: 'var(--text-2)',
      textDecoration: 'line-through',
      textDecorationColor: 'var(--text-3)',
    },
    '.cm-gr-ai': {
      borderRadius: '3px',
      boxShadow: 'inset 2px 0 0 0 var(--ai)',
      animation: 'cm-gr-ai-dim 1400ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
    },
    '@keyframes cm-gr-ai-dim': {
      from: { backgroundColor: 'var(--ai-dim)' },
      to: { backgroundColor: 'transparent' },
    },
  },
  { dark: true },
);
