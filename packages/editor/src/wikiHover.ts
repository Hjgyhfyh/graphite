import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip } from '@codemirror/view';
import type { DecorationSet, Tooltip, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

export interface WikiLinkHit {
  readonly from: number;
  readonly to: number;
  readonly target: string;
  readonly label: string;
}

export interface WikiPreview {
  readonly title: string;
  readonly snippet: string;
  readonly missing: boolean;
}

export type WikiPreviewSource = (target: string) => Promise<WikiPreview>;
export type WikiOpenHandler = (target: string) => void;

/** Имя заметки из цели `[[папка/Имя#якорь|подпись]]` — без пути и якоря. */
export function wikiNoteTitle(target: string): string {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const hash = trimmed.indexOf('#');
  const path = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return (sep >= 0 ? path.slice(sep + 1) : path).trim();
}

const SKIP_CONTEXT = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText']);
const WIKI_MARK = Decoration.mark({ class: 'cm-gr-wiki' });
const WIKI_BRACES = Decoration.mark({ class: 'cm-gr-mark' });
const SNIPPET_MAX = 220;

function inSkippedContext(state: EditorState, pos: number): boolean {
  const cursor = syntaxTree(state).resolveInner(pos, 1).cursor();
  do {
    if (SKIP_CONTEXT.has(cursor.name)) {
      return true;
    }
  } while (cursor.parent());
  return false;
}

/** Все закрытые `[[цель|подпись]]` в одной строке; внутри `` `кода` `` пропускаются. */
export function wikiLinksInLine(text: string): WikiLinkHit[] {
  const hits: WikiLinkHit[] = [];
  let i = 0;
  let inCode = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      inCode = !inCode;
      i += 1;
      continue;
    }
    if (!inCode && ch === '[' && text[i + 1] === '[') {
      const end = text.indexOf(']]', i + 2);
      if (end < 0) {
        break;
      }
      const inner = text.slice(i + 2, end);
      const bar = inner.indexOf('|');
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
      if (target.length > 0) {
        hits.push({
          from: i,
          to: end + 2,
          target,
          label: label.length > 0 ? label : target,
        });
      }
      i = end + 2;
      continue;
    }
    i += 1;
  }
  return hits;
}

export function wikiLinkAt(text: string, offset: number): WikiLinkHit | null {
  for (const hit of wikiLinksInLine(text)) {
    if (offset >= hit.from && offset <= hit.to) {
      return hit;
    }
  }
  return null;
}

export function wikiLinkAround(state: EditorState, pos: number): WikiLinkHit | null {
  const fmEnd = frontmatterEnd(state.doc);
  if (pos < fmEnd) {
    return null;
  }
  if (inSkippedContext(state, pos)) {
    return null;
  }
  const line = state.doc.lineAt(pos);
  const hit = wikiLinkAt(line.text, pos - line.from);
  if (hit === null) {
    return null;
  }
  return {
    from: line.from + hit.from,
    to: line.from + hit.to,
    target: hit.target,
    label: hit.label,
  };
}

/** Короткий абзац для карточки: без разметки, с многоточием. */
export function snippetFromBody(body: string, max = SNIPPET_MAX): string {
  const flat = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]|\n]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, max).trimEnd()}…`;
}

function buildDecorations(view: EditorView): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const fmEnd = frontmatterEnd(doc);

  for (const range of view.visibleRanges) {
    let line = doc.lineAt(range.from);
    for (;;) {
      if (line.from >= fmEnd) {
        for (const hit of wikiLinksInLine(line.text)) {
          const from = line.from + hit.from;
          const to = line.from + hit.to;
          if (inSkippedContext(view.state, from)) {
            continue;
          }
          items.push(WIKI_BRACES.range(from, from + 2));
          if (to - 2 > from + 2) {
            items.push(WIKI_MARK.range(from + 2, to - 2));
          }
          items.push(WIKI_BRACES.range(to - 2, to));
        }
      }
      if (line.to >= range.to) {
        break;
      }
      line = doc.lineAt(line.to + 1);
    }
  }

  return Decoration.set(items, true);
}

const wikiDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function bindOpen(dom: HTMLElement, target: string, onOpen: WikiOpenHandler): void {
  dom.classList.add('cm-gr-wiki-tip-open');
  dom.setAttribute('role', 'button');
  dom.tabIndex = 0;
  const open = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(target);
  };
  dom.addEventListener('mousedown', open);
  dom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      open(event);
    }
  });
}

function wikiHoverTooltip(source: WikiPreviewSource, onOpen?: WikiOpenHandler): Extension {
  return hoverTooltip(
    (view, pos): Tooltip | null => {
      const hit = wikiLinkAround(view.state, pos);
      if (hit === null) {
        return null;
      }
      return {
        pos: hit.from,
        end: hit.to,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-gr-wiki-tip';
          const title = document.createElement('div');
          title.className = 'cm-gr-wiki-tip-title';
          title.textContent = hit.label;
          const body = document.createElement('div');
          body.className = 'cm-gr-wiki-tip-body';
          body.textContent = 'Загрузка…';
          const hint = document.createElement('div');
          hint.className = 'cm-gr-wiki-tip-hint';
          hint.textContent = onOpen !== undefined ? 'Открыть · клик' : 'Ctrl+клик по ссылке';
          dom.append(title, body, hint);
          if (onOpen !== undefined) {
            bindOpen(dom, hit.target, onOpen);
          }
          let cancelled = false;
          void source(hit.target).then((preview) => {
            if (cancelled) {
              return;
            }
            title.textContent = preview.title;
            if (preview.missing) {
              dom.classList.add('cm-gr-wiki-tip-missing');
              body.textContent = 'Заметка не найдена';
              hint.textContent = onOpen !== undefined ? 'Создать · клик' : '';
              return;
            }
            body.textContent = preview.snippet.length > 0 ? preview.snippet : 'Пустая заметка';
          });
          return {
            dom,
            destroy() {
              cancelled = true;
            },
          };
        },
      };
    },
    { hoverTime: 380 },
  );
}

/** Ctrl/Cmd+клик по `[[ссылке]]` — открыть, не ставя курсор. */
export function isWikiFollowClick(event: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey;
}

function wikiFollowClicks(onOpen: WikiOpenHandler): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!isWikiFollowClick(event)) {
        return false;
      }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        return false;
      }
      const hit = wikiLinkAround(view.state, pos);
      if (hit === null) {
        return false;
      }
      event.preventDefault();
      onOpen(hit.target);
      return true;
    },
  });
}

/** Подсветка `[[ссылок]]` и карточка с превью заметки по наведению. */
export function wikiLinkPreview(source: WikiPreviewSource, onOpen?: WikiOpenHandler): Extension {
  return [wikiDecorations, wikiHoverTooltip(source, onOpen), ...(onOpen !== undefined ? [wikiFollowClicks(onOpen)] : [])];
}
