import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Форматирование размеров/дат, категоризация расширений и карта расширение→иконка
// для файлового менеджера. Пути на Windows приходят с `\`, но разбор терпит и `/`.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);

const CODE_EXTS = new Set([
  'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'toml', 'yaml', 'yml',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'py', 'go', 'java', 'kt', 'kts', 'c', 'h',
  'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'swift', 'dart', 'vue', 'svelte', 'xml', 'gradle', 'ini', 'cfg', 'conf', 'env',
]);

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'log', 'csv', 'tsv', 'rtf', 'text', 'nfo', 'srt', 'vtt',
]);

const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v']);

/** Картинка (показываем через base64 data-URL). */
export function isImageExt(ext: string | null): boolean {
  return ext !== null && IMAGE_EXTS.has(ext);
}

/** Иконка файла по расширению. */
export function iconForFile(ext: string | null): LucideIcon {
  if (ext === null) {
    return File;
  }
  if (IMAGE_EXTS.has(ext)) {
    return FileImage;
  }
  if (CODE_EXTS.has(ext)) {
    return FileCode;
  }
  if (ARCHIVE_EXTS.has(ext)) {
    return FileArchive;
  }
  if (AUDIO_EXTS.has(ext)) {
    return FileAudio;
  }
  if (VIDEO_EXTS.has(ext)) {
    return FileVideo;
  }
  if (TEXT_EXTS.has(ext)) {
    return FileText;
  }
  return File;
}

/** `1.2 МБ` / `340 КБ` / `12 Б`; для папок (null) — пустая строка. */
export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Короткая дата `11 июл 2026`. */
export function formatDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return '';
  }
  try {
    return new Date(ms).toLocaleDateString('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** Полные дата и время для подсказки. */
export function formatDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return '';
  }
  try {
    return new Date(ms).toLocaleString('ru-RU', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Последний сегмент пути (имя папки/файла); для `C:\` — `C:`. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) {
    return path;
  }
  const parts = trimmed.split(/[\\/]+/);
  const last = parts[parts.length - 1];
  return last.length > 0 ? last : trimmed;
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Сегменты пути с накопленными путями для клика по «хлебным крошкам».
 * Заточено под локальные Windows-пути (`C:\Users\...`); терпит и `/`.
 */
export function breadcrumbs(fullPath: string): Crumb[] {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const trimmed = fullPath.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]+/);
  const crumbs: Crumb[] = [];
  let acc = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length === 0) {
      continue;
    }
    if (crumbs.length === 0 && /^[a-zA-Z]:$/.test(part)) {
      // Корень диска: путь `C:\`, чтобы clic вёл на сам диск.
      acc = `${part}${sep}`;
      crumbs.push({ label: part, path: acc });
    } else {
      acc = acc.length === 0 ? part : acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }
  if (crumbs.length === 0) {
    crumbs.push({ label: trimmed.length > 0 ? trimmed : fullPath, path: fullPath });
  }
  return crumbs;
}
