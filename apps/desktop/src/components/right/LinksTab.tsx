import type { NoteRef } from '@graphite/bindings';

export interface LinksTabProps {
  noteRef: NoteRef;
}

export function LinksTab({ noteRef }: LinksTabProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="truncate px-2 font-mono text-micro text-text-2">{noteRef}</div>
      <section className="flex flex-col gap-1.5">
        <h3 className="px-2 text-caption text-text-2">Исходящие</h3>
        <p className="px-2 text-ui text-text-2">Связей пока нет — добавьте [[ссылку]] в тексте.</p>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="px-2 text-caption text-text-2">Входящие</h3>
        <p className="px-2 text-ui text-text-2">На эту заметку пока никто не ссылается.</p>
      </section>
    </div>
  );
}
