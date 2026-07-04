import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

export interface ImagePreviewOptions {
  /** Maps an embed target (`_assets/…`, http(s), data:) to a displayable URL. */
  resolveSrc(target: string): string | undefined | Promise<string | undefined>;
  /** Invoked when the rendered preview (or missing-file card) is clicked. */
  onOpen?(target: string): void;
}

const IMAGE_EMBED_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

function cleanTarget(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

function fileLabel(target: string): string {
  const tail = target.split(/[\\/]/).pop() ?? target;
  return tail.length > 42 ? `…${tail.slice(-41)}` : tail;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alt: string,
    readonly options: ImagePreviewOptions,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.target === this.target && other.alt === this.alt;
  }

  get estimatedHeight(): number {
    return 160;
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement('span');
    frame.className = 'cm-gr-img cm-gr-img-loading';
    frame.title = this.alt.length > 0 ? this.alt : fileLabel(this.target);

    const shimmer = document.createElement('span');
    shimmer.className = 'cm-gr-img-shimmer';
    shimmer.innerHTML = IMAGE_ICON;
    frame.appendChild(shimmer);

    const open = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onOpen?.(this.target);
    };

    const showMissing = (): void => {
      frame.classList.remove('cm-gr-img-loading');
      frame.classList.add('cm-gr-img-missing');
      shimmer.remove();
      frame.innerHTML = '';
      const icon = document.createElement('span');
      icon.className = 'cm-gr-img-missing-icon';
      icon.innerHTML = IMAGE_ICON;
      frame.appendChild(icon);
      const text = document.createElement('span');
      text.className = 'cm-gr-img-missing-text';
      const name = document.createElement('span');
      name.className = 'cm-gr-img-missing-name';
      name.textContent = this.alt.length > 0 ? this.alt : fileLabel(this.target);
      text.appendChild(name);
      const hint = document.createElement('span');
      hint.className = 'cm-gr-img-missing-hint';
      hint.textContent = 'изображение из вложений — нажмите, чтобы показать файл';
      text.appendChild(hint);
      frame.appendChild(text);
      view.requestMeasure();
    };

    const attach = (src: string): void => {
      const img = document.createElement('img');
      img.className = 'cm-gr-img-el';
      img.alt = this.alt;
      img.draggable = false;
      img.onload = () => {
        frame.classList.remove('cm-gr-img-loading');
        shimmer.remove();
        view.requestMeasure();
      };
      img.onerror = () => {
        img.remove();
        showMissing();
      };
      img.src = src;
      frame.appendChild(img);
    };

    frame.addEventListener('mousedown', open);

    try {
      const resolved = this.options.resolveSrc(this.target);
      if (typeof resolved === 'string') {
        attach(resolved);
      } else if (resolved !== undefined) {
        resolved.then(
          (src) => {
            if (!frame.isConnected) {
              return;
            }
            if (src !== undefined) {
              attach(src);
            } else {
              showMissing();
            }
          },
          () => {
            if (frame.isConnected) {
              showMissing();
            }
          },
        );
      } else {
        showMissing();
      }
    } catch {
      showMissing();
    }

    return frame;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildPreviews(view: EditorView, options: ImagePreviewOptions): DecorationSet {
  const items: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const fmEnd = frontmatterEnd(doc);
  const selection = view.state.selection;

  const touchesSelection = (from: number, to: number): boolean => {
    for (const range of selection.ranges) {
      if (range.from <= to && range.to >= from) {
        return true;
      }
    }
    return false;
  };

  for (const visible of view.visibleRanges) {
    let line = doc.lineAt(visible.from);
    for (;;) {
      if (line.to > fmEnd && line.text.includes('![')) {
        IMAGE_EMBED_RE.lastIndex = 0;
        let match = IMAGE_EMBED_RE.exec(line.text);
        while (match !== null) {
          const from = line.from + match.index;
          const to = from + match[0].length;
          if (!touchesSelection(from, to)) {
            const target = cleanTarget(match[2]);
            if (target.length > 0) {
              items.push(
                Decoration.replace({
                  widget: new ImageWidget(target, match[1].trim(), options),
                }).range(from, to),
              );
            }
          }
          match = IMAGE_EMBED_RE.exec(line.text);
        }
      }
      if (line.to >= visible.to) {
        break;
      }
      line = doc.lineAt(line.to + 1);
    }
  }

  return Decoration.set(items, true);
}

/**
 * Renders `![…](…)` embeds as framed inline previews instead of bare links
 * (#29). The raw markdown re-surfaces while the selection touches the embed
 * so editing stays direct; loading shows a soft shimmer card and unreachable
 * files degrade to an elegant attachment chip.
 */
export function imagePreviews(options: ImagePreviewOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildPreviews(view, options);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildPreviews(update.view, options);
        }
      }
    },
    {
      decorations: (instance) => instance.decorations,
      provide: (instance) =>
        EditorView.atomicRanges.of((view) => view.plugin(instance)?.decorations ?? Decoration.none),
    },
  );
  return plugin;
}
