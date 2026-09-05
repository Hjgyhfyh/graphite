/** Дописывает блок в конец документа, не трогая уже существующий текст. */
export function appendCaptureToDoc(doc: string, bullet: string): string {
  if (doc.length === 0) {
    return `${bullet}\n`;
  }
  const withNl = doc.endsWith('\n') ? doc : `${doc}\n`;
  return `${withNl}\n${bullet}\n`;
}
