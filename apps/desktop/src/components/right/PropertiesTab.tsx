import type { NoteRef } from '@graphite/bindings';

export interface PropertiesTabProps {
  noteRef: NoteRef;
}

const FIELDS = ['Статус', 'Теги', 'Приоритет', 'Срок'] as const;

export function PropertiesTab({ noteRef }: PropertiesTabProps) {
  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="mb-2 truncate px-2 font-mono text-micro text-text-2">{noteRef}</div>
      {FIELDS.map((field) => (
        <div key={field} className="flex h-8 items-center justify-between rounded-s px-2 hover:bg-bg-2">
          <span className="text-ui text-text-1">{field}</span>
          <span className="text-ui text-text-3">—</span>
        </div>
      ))}
      <p className="mt-3 px-2 text-caption text-text-2">Свойства заметки появятся после подключения ядра.</p>
    </div>
  );
}
