/** CommonMark-подобные огороженные код-блоки: один сканер на все декорации. */

export interface OpenFence {
  readonly marker: '`' | '~';
  readonly length: number;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Открывающая ограда: 0–3 пробела, ≥3 одинаковых маркера. Для `` ` `` info-строка
 * не может содержать обратную кавычку — иначе это не забор, а обычный текст.
 */
export function parseFenceOpen(text: string): OpenFence | null {
  const match = FENCE_RE.exec(text);
  if (match === null) {
    return null;
  }
  const run = match[1];
  const rest = match[2];
  if (run[0] === '`' && rest.includes('`')) {
    return null;
  }
  return { marker: run[0] as '`' | '~', length: run.length };
}

/**
 * Закрывающая ограда: тот же маркер, длина не короче открывающей, после прогона
 * только пробелы. Чужой маркер и более короткий прогон тело не закрывают.
 */
export function closesFence(text: string, fence: OpenFence): boolean {
  const match = FENCE_RE.exec(text);
  if (match === null) {
    return false;
  }
  const run = match[1];
  return run[0] === fence.marker && run.length >= fence.length && match[2].trim().length === 0;
}

export function isFenceLine(text: string): boolean {
  return parseFenceOpen(text) !== null;
}
