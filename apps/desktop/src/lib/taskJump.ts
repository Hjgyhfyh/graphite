import { splitFrontmatter } from '@graphite/editor';
import type { NoteRef } from '@graphite/bindings';

export interface TaskJumpTarget {
  readonly ref: NoteRef;
  readonly taskId: string;
  readonly text: string;
  readonly anchor: string;
}

/** Номер строки тела (1-based) из синтетического id `loc:<note>:<line>`. */
export function parseLocLine(taskId: string): number | undefined {
  if (!taskId.startsWith('loc:')) {
    return undefined;
  }
  const sep = taskId.lastIndexOf(':');
  if (sep <= 3) {
    return undefined;
  }
  const n = Number(taskId.slice(sep + 1));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * 1-based номер строки документа CodeMirror для прыжка к задаче.
 * `loc:` считает строки в теле (после YAML); якорь ищется как `^id`.
 */
export function findTaskDocLine(doc: string, jump: TaskJumpTarget): number | undefined {
  const split = splitFrontmatter(doc);
  const bodyLine = split?.bodyLine ?? 0;
  const body = split?.body ?? doc;

  const loc = parseLocLine(jump.taskId);
  if (loc !== undefined) {
    return bodyLine + loc;
  }

  const rawAnchor = jump.anchor.trim().length > 0 ? jump.anchor.trim() : jump.taskId.trim();
  if (rawAnchor.length > 0 && !rawAnchor.startsWith('loc:')) {
    const token = rawAnchor.startsWith('^') ? rawAnchor : `^${rawAnchor}`;
    const at = body.indexOf(token);
    if (at >= 0) {
      return bodyLine + body.slice(0, at).split('\n').length;
    }
  }

  const needle = jump.text.trim();
  if (needle.length === 0) {
    return undefined;
  }
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle) && /\[[ xX/-]\]/.test(lines[i])) {
      return bodyLine + i + 1;
    }
  }
  return undefined;
}
