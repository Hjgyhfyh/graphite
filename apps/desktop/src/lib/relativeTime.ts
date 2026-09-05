const ABSOLUTE = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const SHORT_DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

/** Абсолютная дата для подсказки: «5 сентября, 05:58». */
export function formatAbsoluteRu(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return iso;
  }
  return ABSOLUTE.format(new Date(time));
}

/**
 * Короткое относительное время по-русски.
 * «сейчас» / «3 мин» / «2 ч» / «вчера» / «5 сент.»
 */
export function formatRelativeRu(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return '';
  }
  const sec = Math.round((now - time) / 1000);
  if (sec < -60) {
    return SHORT_DATE.format(new Date(time));
  }
  if (sec < 45) {
    return 'сейчас';
  }
  if (sec < 90) {
    return '1 мин';
  }
  if (sec < 3600) {
    return `${Math.round(sec / 60)} мин`;
  }
  if (sec < 5400) {
    return '1 ч';
  }
  if (sec < 86_400) {
    return `${Math.round(sec / 3600)} ч`;
  }
  if (sec < 172_800) {
    return 'вчера';
  }
  if (sec < 7 * 86_400) {
    return `${Math.round(sec / 86_400)} дн.`;
  }
  return SHORT_DATE.format(new Date(time));
}
