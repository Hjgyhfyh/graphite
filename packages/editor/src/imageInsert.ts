import { StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { frontmatterEnd } from './frontmatter';

export interface AttachmentSaveOptions {
  /** Persists the image and resolves with a vault-relative path (`_assets/…`). */
  save(blob: Blob, ext: string): Promise<string>;
  onError?(message: string): void;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
};

export function imageExtFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'png';
}

interface PendingUpload {
  readonly id: number;
  readonly pos: number;
}

const addUpload = StateEffect.define<PendingUpload>({
  map: (value, changes) => ({ id: value.id, pos: changes.mapPos(value.pos, 1) }),
});
const dropUpload = StateEffect.define<number>();

let uploadSeq = 0;

class UploadWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }

  eq(other: UploadWidget): boolean {
    return other.id === this.id;
  }

  toDOM(): HTMLElement {
    const pill = document.createElement('span');
    pill.className = 'cm-gr-upload';
    const spinner = document.createElement('span');
    spinner.className = 'cm-gr-upload-spinner';
    pill.appendChild(spinner);
    const label = document.createElement('span');
    label.textContent = 'Сохраняю изображение…';
    pill.appendChild(label);
    return pill;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildUploadDecorations(uploads: readonly PendingUpload[]): DecorationSet {
  if (uploads.length === 0) {
    return Decoration.none;
  }
  const ranges: Range<Decoration>[] = uploads.map((upload) =>
    Decoration.widget({ widget: new UploadWidget(upload.id), side: 1 }).range(upload.pos),
  );
  return Decoration.set(ranges, true);
}

/**
 * Tracks in-flight attachment uploads as inline "saving…" pills anchored to
 * their insertion point; positions ride along with edits so the final
 * markdown lands exactly where the paste happened, even if the user kept
 * typing meanwhile (#29).
 */
const uploadsField = StateField.define<readonly PendingUpload[]>({
  create() {
    return [];
  },
  update(uploads, tr) {
    let next: PendingUpload[] | null = null;
    if (tr.docChanged && uploads.length > 0) {
      next = uploads.map((u) => ({ id: u.id, pos: tr.changes.mapPos(u.pos, 1) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addUpload)) {
        next = [...(next ?? uploads), effect.value];
      } else if (effect.is(dropUpload)) {
        next = (next ?? uploads).filter((u) => u.id !== effect.value);
      }
    }
    return next ?? uploads;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (uploads) => buildUploadDecorations(uploads)),
});

function uploadPos(view: EditorView, id: number): number | null {
  const uploads = view.state.field(uploadsField, false);
  const hit = uploads?.find((u) => u.id === id);
  return hit !== undefined ? hit.pos : null;
}

/** Insertion point for an embed: clamped to the doc and pushed past frontmatter. */
export function attachmentInsertPos(view: EditorView, pos: number): number {
  const max = view.state.doc.length;
  const clamped = Math.max(0, Math.min(pos, max));
  const fmEnd = frontmatterEnd(view.state.doc);
  if (fmEnd > 0 && clamped <= fmEnd) {
    return Math.min(fmEnd + 1, max);
  }
  return clamped;
}

/** Shows an upload pill at `pos`; resolve it later with the markdown to insert. */
export function beginAttachmentUpload(view: EditorView, pos: number): number {
  uploadSeq += 1;
  const id = uploadSeq;
  view.dispatch({ effects: addUpload.of({ id, pos: attachmentInsertPos(view, pos) }) });
  return id;
}

/** Replaces the upload pill with final markdown (or removes it on failure). */
export function finishAttachmentUpload(view: EditorView, id: number, markdown: string | null): void {
  if (!view.dom.isConnected) {
    return;
  }
  const pos = uploadPos(view, id);
  if (pos === null) {
    return;
  }
  if (markdown === null) {
    view.dispatch({ effects: dropUpload.of(id) });
    return;
  }
  const caretAtInsert = view.state.selection.main.empty && view.state.selection.main.head === pos;
  view.dispatch({
    changes: { from: pos, insert: markdown },
    ...(caretAtInsert ? { selection: { anchor: pos + markdown.length } } : {}),
    effects: dropUpload.of(id),
    userEvent: 'input',
    scrollIntoView: true,
  });
}

/** Markdown for an embedded attachment plus block-friendly spacing around `pos`. */
export function attachmentMarkdown(view: EditorView, pos: number, relPath: string): string {
  const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length)));
  const embed = `![](${relPath})`;
  const before = line.from < pos ? view.state.sliceDoc(line.from, pos).trim() : '';
  const after = pos < line.to ? view.state.sliceDoc(pos, line.to).trim() : '';
  const prefix = before.length > 0 ? '\n' : '';
  const suffix = after.length > 0 ? '\n' : '\n';
  return `${prefix}${embed}${suffix}`;
}

function collectImageFiles(data: DataTransfer | null): File[] {
  if (data === null) {
    return [];
  }
  const files: File[] = [];
  for (const file of Array.from(data.files)) {
    if (file.type.toLowerCase().startsWith('image/')) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) {
        const file = item.getAsFile();
        if (file !== null) {
          files.push(file);
        }
      }
    }
  }
  return files;
}

function handleFiles(view: EditorView, files: File[], pos: number, options: AttachmentSaveOptions): void {
  const id = beginAttachmentUpload(view, pos);
  void (async () => {
    const parts: string[] = [];
    let failure: string | null = null;
    for (const file of files) {
      try {
        const rel = await options.save(file, imageExtFromMime(file.type));
        parts.push(rel);
      } catch (error) {
        failure = error instanceof Error ? error.message : 'не удалось сохранить изображение';
      }
    }
    if (parts.length === 0) {
      finishAttachmentUpload(view, id, null);
      if (failure !== null) {
        options.onError?.(failure);
      }
      return;
    }
    const at = uploadPos(view, id) ?? pos;
    const markdown = parts
      .map((rel, index) => (index === 0 ? attachmentMarkdown(view, at, rel) : `![](${rel})\n`))
      .join('');
    finishAttachmentUpload(view, id, markdown);
    if (failure !== null) {
      options.onError?.(failure);
    }
  })();
}

/**
 * Clipboard paste and DOM drag-drop of images: the file is persisted through
 * `options.save` while an inline pill marks the landing spot, then the
 * `![](_assets/…)` embed is written in (#29). Non-image payloads fall through
 * to the default handlers untouched.
 */
export function imageAttachments(options: AttachmentSaveOptions): Extension {
  return [
    uploadsField,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        if (view.state.readOnly) {
          return false;
        }
        const files = collectImageFiles(event.clipboardData);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        const range = view.state.selection.main;
        if (!range.empty) {
          view.dispatch({ changes: { from: range.from, to: range.to }, userEvent: 'delete' });
        }
        handleFiles(view, files, view.state.selection.main.from, options);
        return true;
      },
      drop: (event, view) => {
        if (view.state.readOnly) {
          return false;
        }
        const files = collectImageFiles(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
        handleFiles(view, files, pos, options);
        return true;
      },
    }),
  ];
}
