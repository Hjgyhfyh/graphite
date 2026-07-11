import { useEffect, useMemo, useRef, useState } from 'react';
import { FileWarning, FolderOpen, ExternalLink, LoaderCircle } from 'lucide-react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { Button, cx } from '@graphite/ui';
import { useUiStore } from '../../stores/uiStore';
import { fsAvailable, fsErrorMessage, openPath, readBase64, readText, revealPath } from './fsApi';
import { basename, isImageExt } from './explorerFormat';

// Минимальный read-only CodeMirror под просмотр кода/текста: моноширинный,
// с нумерацией строк, слева — в отличие от note-редактора (graphiteDark
// центрирует по 72ch, что для кода не годится).
const previewTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-0)', color: 'var(--text-1)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: '12.5px',
      lineHeight: '19px',
    },
    '.cm-content': { padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-0)',
      color: 'var(--text-3)',
      border: 'none',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '2.5ch' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--selection) 28%, transparent)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection-dim)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-line': { padding: '0 12px' },
  },
  { dark: true },
);

function extOf(path: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path);
  return match !== null ? match[1].toLowerCase() : null;
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean; ext: string | null }
  | { kind: 'image'; src: string }
  | { kind: 'unsupported'; reason: string };

export function FilePreview({ path }: { path: string }) {
  const ext = useMemo(() => extOf(path), [path]);
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const load = async () => {
      if (!fsAvailable()) {
        setState({ kind: 'unsupported', reason: 'Просмотр файлов доступен только в приложении' });
        return;
      }
      try {
        if (isImageExt(ext)) {
          const image = await readBase64(path);
          if (cancelled) {
            return;
          }
          setState({ kind: 'image', src: `data:${image.mime};base64,${image.base64}` });
          return;
        }
        const text = await readText(path);
        if (cancelled) {
          return;
        }
        if (text.isBinary) {
          setState({ kind: 'unsupported', reason: 'Двоичный файл — предпросмотр недоступен' });
        } else {
          setState({ kind: 'text', content: text.content, truncated: text.truncated, ext });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: 'unsupported', reason: fsErrorMessage(error, 'Не удалось открыть файл') });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [path, ext]);

  const runFsAction = (action: (p: string) => Promise<void>, failure: string) => {
    action(path).catch((error) => pushToast({ kind: 'error', text: fsErrorMessage(error, failure) }));
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-text-3">
        <LoaderCircle size={18} strokeWidth={1.75} className="animate-spin" />
      </div>
    );
  }

  if (state.kind === 'image') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg-1 p-3">
        <img src={state.src} alt={basename(path)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (state.kind === 'unsupported') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-m border border-stroke-0 bg-bg-2 text-text-3">
          <FileWarning size={18} strokeWidth={1.75} />
        </span>
        <p className="max-w-xs text-ui text-text-1">{state.reason}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => runFsAction(openPath, 'Не удалось открыть')}>
            <ExternalLink size={13} strokeWidth={1.75} />
            Открыть в системе
          </Button>
          <Button variant="ghost" size="sm" onClick={() => runFsAction(revealPath, 'Не удалось показать в Проводнике')}>
            <FolderOpen size={13} strokeWidth={1.75} />
            Показать в Проводнике
          </Button>
        </div>
      </div>
    );
  }

  return <TextPreview content={state.content} ext={state.ext} truncated={state.truncated} />;
}

function TextPreview({ content, ext, truncated }: { content: string; ext: string | null; truncated: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hostRef.current === null) {
      return;
    }
    const isMarkdown = ext === 'md' || ext === 'markdown' || ext === 'mdx';
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ...(isMarkdown ? [markdown({ base: markdownLanguage })] : []),
          previewTheme,
        ],
      }),
      parent: hostRef.current,
    });
    return () => {
      view.destroy();
    };
  }, [content, ext]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {truncated ? (
        <div className="shrink-0 border-b border-stroke-0 bg-bg-1 px-3 py-1.5 text-micro text-text-2">
          Файл большой — показано только начало.
        </div>
      ) : null}
      <div ref={hostRef} className={cx('min-h-0 flex-1 overflow-hidden')} />
    </div>
  );
}
