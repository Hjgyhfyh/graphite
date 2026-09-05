import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteEditOp, NoteRef } from '@graphite/bindings';
import { appendCaptureToDoc } from '@graphite/editor';
import { todayYmd } from './dailyDoc';
import { WELCOME_NOTE_REF, flushPendingSaves, pendingSaveFor } from '../components/editor/editorSession';

export type CaptureDest = 'inbox' | 'journal' | 'note';

export const JOURNAL_CAPTURE_HEADING = 'Заметки дня';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function hydrateCaptureDest(value: unknown): CaptureDest {
  return value === 'journal' || value === 'note' ? value : 'inbox';
}

/** Цель «дописать в заметку»: не приветствие и не пусто. */
export function captureNoteTarget(ref: NoteRef | undefined): NoteRef | undefined {
  if (ref === undefined || ref.length === 0 || ref === WELCOME_NOTE_REF) {
    return undefined;
  }
  return ref;
}

export function capturePlaceholder(dest: CaptureDest): string {
  if (dest === 'journal') {
    return 'Что на уме? Попадёт в сегодняшний дневник.';
  }
  if (dest === 'note') {
    return 'Что на уме? Допишется в открытую заметку.';
  }
  return 'Что на уме? Запишется во «Входящие».';
}

export function formatCaptureBullet(text: string, at = new Date()): string {
  const stamp = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const lines = text.trim().split(/\n/);
  const first = lines[0] ?? '';
  if (lines.length <= 1) {
    return `- ${stamp} ${first}`;
  }
  const rest = lines
    .slice(1)
    .map((line) => `  ${line}`)
    .join('\n');
  return `- ${stamp} ${first}\n${rest}`;
}

function captureAppendOp(doc: string, bullet: string): NoteEditOp {
  if (doc.length === 0) {
    return { op: 'prepend', content: `${bullet}\n` };
  }
  return { op: 'replace', oldString: doc, newString: appendCaptureToDoc(doc, bullet) };
}

async function appendBulletToNote(ref: NoteRef, bullet: string): Promise<void> {
  await flushPendingSaves();
  await pendingSaveFor(ref);
  const apply = async (rev: string, content: string): Promise<void> => {
    await commands.noteEdit({
      ref,
      rev,
      ops: [captureAppendOp(content, bullet)],
    });
  };
  const first = await commands.noteRead({ ref });
  try {
    await apply(first.rev, first.content);
  } catch (error) {
    if (!isGraphiteError(error) || error.code !== 'CONFLICT') {
      throw error;
    }
    const again = await commands.noteRead({ ref });
    await apply(again.rev, again.content);
  }
}

export async function submitQuickCapture(
  text: string,
  dest: CaptureDest,
  noteRef?: NoteRef,
): Promise<{ dest: CaptureDest; ref: NoteRef }> {
  const body = text.trim();
  if (body.length === 0) {
    throw new Error('пустая заметка');
  }
  if (dest === 'inbox') {
    const created = await commands.quickCapture(body);
    return { dest, ref: created.ref };
  }

  if (dest === 'note') {
    const target = captureNoteTarget(noteRef);
    if (target === undefined) {
      throw new Error('откройте заметку, чтобы дописать в неё');
    }
    await appendBulletToNote(target, formatCaptureBullet(body));
    return { dest, ref: target };
  }

  await flushPendingSaves();
  const daily = await commands.ensureDailyNote({ date: todayYmd() });
  await pendingSaveFor(daily.ref);
  const bullet = formatCaptureBullet(body);
  const apply = async (rev: string): Promise<void> => {
    await commands.noteEdit({
      ref: daily.ref,
      rev,
      ops: [{ op: 'append_section', heading: JOURNAL_CAPTURE_HEADING, content: bullet }],
    });
  };
  const first = await commands.noteRead({ ref: daily.ref });
  try {
    await apply(first.rev);
  } catch (error) {
    if (!isGraphiteError(error) || error.code !== 'CONFLICT') {
      throw error;
    }
    const again = await commands.noteRead({ ref: daily.ref });
    await apply(again.rev);
  }
  return { dest, ref: daily.ref };
}
