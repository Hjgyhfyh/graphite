import { commands, isGraphiteError } from '@graphite/bindings';
import type { NoteRef } from '@graphite/bindings';
import { todayYmd } from './dailyDoc';
import { flushPendingSaves, pendingSaveFor } from '../components/editor/editorSession';

export type CaptureDest = 'inbox' | 'journal';

export const JOURNAL_CAPTURE_HEADING = 'Заметки дня';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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

export async function submitQuickCapture(text: string, dest: CaptureDest): Promise<{ dest: CaptureDest; ref: NoteRef }> {
  const body = text.trim();
  if (body.length === 0) {
    throw new Error('пустая заметка');
  }
  if (dest === 'inbox') {
    const created = await commands.quickCapture(body);
    return { dest, ref: created.ref };
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
