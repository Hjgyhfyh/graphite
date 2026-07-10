import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { Button, Input, Switch, Tooltip, cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { SyncState } from '@graphite/bindings';
import { Presence, SlideUp, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import {
  SYNC_CODE_PLACEHOLDER,
  humanSyncError,
  normalizeSyncCode,
  useSyncStore,
} from '../../stores/syncStore';
import { isActiveVaultPath, switchVault } from '../../stores/vaultActions';
import { useVaultStore } from '../../stores/vaultStore';
import { vaultKey, vaultName } from '../../stores/vaultsStore';

type DotKind = 'ok' | 'warn' | 'danger' | 'muted';

const DOT_COLOR: Record<DotKind, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-text-3',
};

const STATE_DOT: Record<SyncState, DotKind> = {
  idle: 'ok',
  syncing: 'warn',
  error: 'danger',
};

function Dot({ kind, pulse }: { kind: DotKind; pulse?: boolean }) {
  return <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', DOT_COLOR[kind], pulse && 'animate-pulse')} />;
}

function reason(error: unknown, fallback: string): string {
  return isGraphiteError(error) && error.message.length > 0 ? error.message : fallback;
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) {
    return 'только что';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

async function pickReplicaFolder(): Promise<string | undefined> {
  try {
    const selected = await invoke<string | null>('plugin:dialog|open', {
      options: { directory: true, multiple: false, title: 'Папка для Sync-хранилища' },
    });
    return typeof selected === 'string' ? selected : undefined;
  } catch {
    return undefined;
  }
}

function CodeCard({ code, onCopy }: { code: string; onCopy: (value: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-m border border-stroke-1 bg-bg-1 py-2.5 pl-3.5 pr-2">
      <span className="min-w-0 flex-1 select-text truncate text-center font-mono text-[15px] tracking-[0.12em] text-text-0">
        {code}
      </span>
      <Tooltip content="Скопировать код" side="top">
        <button
          type="button"
          aria-label="Скопировать код доступа"
          onClick={() => onCopy(code)}
          className="flex size-7 shrink-0 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 active:scale-95"
        >
          <Copy size={14} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  );
}

export function SyncSection() {
  const info = useVaultStore((s) => s.info);
  const status = useSyncStore((s) => s.status);
  const busy = useSyncStore((s) => s.busy);
  const codes = useSyncStore((s) => s.codes);
  const pushToast = useUiStore((s) => s.pushToast);
  const reduced = usePrefersReducedMotion();
  const inTauri = isTauriAvailable();

  const [panel, setPanel] = useState<'none' | 'create' | 'join'>('none');
  const [copyNotes, setCopyNotes] = useState(true);
  const [creating, setCreating] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [joining, setJoining] = useState(false);
  const [freshCode, setFreshCode] = useState<string | undefined>(undefined);
  const [codeShown, setCodeShown] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  const root = info?.root;

  useEffect(() => {
    if (inTauri) {
      void useSyncStore.getState().refresh();
    }
  }, [inTauri]);

  // Смена хранилища закрывает раскрытые панели — код чужого vault не подсветится.
  useEffect(() => {
    setCodeShown(false);
    setConfirmDetach(false);
    setPanel('none');
  }, [root]);

  const copyCode = (value: string): void => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      pushToast({ kind: 'error', text: 'Буфер обмена недоступен' });
      return;
    }
    try {
      void navigator.clipboard.writeText(value).then(
        () => pushToast({ kind: 'success', text: 'Код скопирован' }),
        () => pushToast({ kind: 'error', text: 'Не удалось скопировать' }),
      );
    } catch {
      pushToast({ kind: 'error', text: 'Не удалось скопировать' });
    }
  };

  const create = async () => {
    if (creating) {
      return;
    }
    const dest = await pickReplicaFolder();
    if (dest === undefined) {
      return;
    }
    if (isActiveVaultPath(dest)) {
      pushToast({ kind: 'error', text: 'Эта папка уже открыта как текущее хранилище — выберите другую' });
      return;
    }
    setCreating(true);
    try {
      const result = await commands.syncCreate(dest, copyNotes);
      useSyncStore.getState().rememberCode(result.path, result.code);
      setFreshCode(result.code);
      setPanel('none');
      await switchVault(result.path);
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось создать Sync-хранилище') });
    } finally {
      setCreating(false);
    }
  };

  const canonicalDraft = normalizeSyncCode(codeDraft);

  const join = async () => {
    if (joining || canonicalDraft === undefined) {
      return;
    }
    const dest = await pickReplicaFolder();
    if (dest === undefined) {
      return;
    }
    if (isActiveVaultPath(dest)) {
      pushToast({ kind: 'error', text: 'Эта папка уже открыта как текущее хранилище — выберите другую' });
      return;
    }
    setJoining(true);
    try {
      const result = await commands.syncJoin(dest, canonicalDraft);
      useSyncStore.getState().rememberCode(result.path, canonicalDraft);
      setPanel('none');
      setCodeDraft('');
      await switchVault(result.path);
    } catch (error) {
      pushToast({ kind: 'error', text: reason(error, 'Не удалось подключиться по коду') });
    } finally {
      setJoining(false);
    }
  };

  const onCodeInput = (event: ChangeEvent<HTMLInputElement>) => {
    const cleaned = event.target.value
      .toUpperCase()
      .replace(/[^0-9A-Z\- ]/g, '')
      .slice(0, 34);
    setCodeDraft(cleaned);
  };

  const detach = async () => {
    const ok = await useSyncStore.getState().detach();
    if (ok) {
      setConfirmDetach(false);
      setCodeShown(false);
    }
  };

  if (!inTauri) {
    return (
      <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ui text-text-0">Синхронизация</span>
          <span className="truncate text-caption text-text-2">Доступно только в установленном приложении</span>
        </div>
        <span className="text-caption text-text-3">Недоступно</span>
      </div>
    );
  }

  const syncing = busy || status.state === 'syncing';
  const activeCode = status.root !== undefined ? codes[vaultKey(status.root)] : undefined;

  const freshCodePanel = (
    <Presence>
      {freshCode !== undefined ? (
        <SlideUp key="fresh-code" className="mb-3 flex flex-col gap-2.5 rounded-m border border-accent/30 bg-accent/5 p-3.5">
          <div className="flex items-center gap-2">
            <KeyRound size={15} strokeWidth={1.75} className="shrink-0 text-accent" />
            <span className="text-ui font-medium text-text-0">Код доступа — сохраните его</span>
          </div>
          <CodeCard code={freshCode} onCopy={copyCode} />
          <p className="text-caption leading-relaxed text-text-2">
            Код — единственный ключ к синхронизации: его вводят на других устройствах, восстановить утерянный
            нельзя. На этом устройстве он всегда доступен здесь по кнопке «Показать код».
          </p>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => copyCode(freshCode)}>
              <Copy size={14} strokeWidth={1.75} />
              Скопировать код
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFreshCode(undefined)}>
              Готово
            </Button>
          </div>
        </SlideUp>
      ) : null}
    </Presence>
  );

  if (!status.active) {
    return (
      <>
        {freshCodePanel}
        <div className="flex items-center justify-between gap-4 pb-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui text-text-0">Общие заметки на нескольких устройствах</span>
            <span className="truncate text-caption text-text-2">
              Sync-хранилище обменивается изменениями через сервер по секретному коду
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              disabled={creating || joining}
              onClick={() => setPanel((cur) => (cur === 'create' ? 'none' : 'create'))}
            >
              <CloudUpload size={14} strokeWidth={1.75} />
              Создать Sync-хранилище
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={creating || joining}
              onClick={() => setPanel((cur) => (cur === 'join' ? 'none' : 'join'))}
            >
              <KeyRound size={14} strokeWidth={1.75} />
              Подключить по коду
            </Button>
          </div>
        </div>

        <Presence>
          {panel === 'create' ? (
            <SlideUp key="create-panel" className="mb-1 flex flex-col gap-3 rounded-m border border-stroke-0 bg-bg-2 p-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium text-text-0">Новое Sync-хранилище</span>
                <span className="text-caption text-text-2">
                  Выберите пустую папку — она станет хранилищем с синхронизацией, а вы получите код доступа
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-ui text-text-0">Скопировать текущие заметки</span>
                  <span className="truncate text-caption text-text-2">
                    {root !== undefined
                      ? `Наполнить новое хранилище содержимым «${vaultName(root)}»`
                      : 'Наполнить новое хранилище текущими заметками'}
                  </span>
                </div>
                <Switch checked={copyNotes} onCheckedChange={setCopyNotes} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => void create()} disabled={creating}>
                  {creating ? (
                    <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                  ) : (
                    <FolderOpen size={14} strokeWidth={1.75} />
                  )}
                  {creating ? 'Создаю…' : 'Выбрать папку и создать'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPanel('none')} disabled={creating}>
                  Отмена
                </Button>
                {creating ? (
                  <span className="text-caption text-text-2">Регистрирую на сервере и отправляю заметки…</span>
                ) : null}
              </div>
            </SlideUp>
          ) : null}

          {panel === 'join' ? (
            <SlideUp key="join-panel" className="mb-1 flex flex-col gap-3 rounded-m border border-stroke-0 bg-bg-2 p-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium text-text-0">Подключение по коду</span>
                <span className="text-caption text-text-2">
                  Введите код с другого устройства — заметки приедут в выбранную папку
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Input
                  value={codeDraft}
                  onChange={onCodeInput}
                  placeholder={SYNC_CODE_PLACEHOLDER}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={joining}
                  aria-label="Код доступа Sync-хранилища"
                  className="font-mono tracking-[0.08em]"
                />
                <span className={cx('text-micro', canonicalDraft !== undefined ? 'text-ok' : 'text-text-3')}>
                  {canonicalDraft !== undefined
                    ? `Код распознан: ${canonicalDraft}`
                    : `Формат: ${SYNC_CODE_PLACEHOLDER}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void join()}
                  disabled={joining || canonicalDraft === undefined}
                >
                  {joining ? (
                    <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                  ) : (
                    <CloudDownload size={14} strokeWidth={1.75} />
                  )}
                  {joining ? 'Забираю данные…' : 'Подключить'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPanel('none');
                    setCodeDraft('');
                  }}
                  disabled={joining}
                >
                  Отмена
                </Button>
              </div>
            </SlideUp>
          ) : null}
        </Presence>
      </>
    );
  }

  return (
    <>
      {freshCodePanel}
      <div className="flex items-start justify-between gap-4 pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption text-text-1">
              <Cloud size={12} strokeWidth={1.75} className="text-accent" />
              Sync-хранилище
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption text-text-1">
              <Dot kind={STATE_DOT[status.state]} pulse={syncing && !reduced} />
              {syncing
                ? 'Синхронизация…'
                : status.state === 'error'
                  ? 'Ошибка'
                  : status.lastSyncAt !== undefined
                    ? `Синхронизировано · ${formatRelative(status.lastSyncAt)}`
                    : 'Ждёт первой синхронизации'}
            </span>
          </div>
          {status.state === 'error' && !syncing ? (
            <span className="text-caption text-danger">{humanSyncError(status.lastError)}</span>
          ) : (
            <span className="text-caption text-text-2">
              Изменения уезжают на сервер автоматически — после правок и раз в 15 секунд
            </span>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={() => void useSyncStore.getState().syncNow()} disabled={syncing}>
          <RefreshCw size={14} strokeWidth={1.75} className={cx(syncing && !reduced && 'animate-spin')} />
          {syncing ? 'Синхронизирую…' : 'Синхронизировать сейчас'}
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-stroke-0 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui text-text-0">Код доступа</span>
            <span className="truncate text-caption text-text-2">
              Ключ к этому хранилищу — его же вводят на других устройствах
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setCodeShown((shown) => !shown)}>
            {codeShown ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
            {codeShown ? 'Скрыть' : 'Показать код'}
          </Button>
        </div>
        <Presence>
          {codeShown ? (
            <SlideUp key="code-reveal">
              {activeCode !== undefined ? (
                <CodeCard code={activeCode} onCopy={copyCode} />
              ) : (
                <p className="text-caption text-text-2">
                  Код не сохранён на этом устройстве — он показывался при создании хранилища.
                </p>
              )}
            </SlideUp>
          ) : null}
        </Presence>
      </div>

      <div className="flex flex-col gap-2 border-t border-stroke-0 pt-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui text-text-0">Отключить синхронизацию</span>
            <span className="truncate text-caption text-text-2">
              Обмен с сервером прекратится; заметки останутся на этом компьютере
            </span>
          </div>
          {!confirmDetach ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:bg-danger/10 hover:text-danger"
              onClick={() => setConfirmDetach(true)}
            >
              <Unplug size={14} strokeWidth={1.75} />
              Отключить…
            </Button>
          ) : null}
        </div>
        <Presence>
          {confirmDetach ? (
            <SlideUp
              key="confirm-detach"
              className="flex items-center justify-between gap-3 rounded-m border border-danger/25 bg-danger/5 px-3 py-2.5"
            >
              <span className="min-w-0 text-caption text-text-1">
                Точно отключить? Подключиться заново можно будет только по коду.
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDetach(false)} disabled={busy}>
                  Отмена
                </Button>
                <Button variant="danger" size="sm" onClick={() => void detach()} disabled={busy}>
                  {busy ? (
                    <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                  ) : (
                    <Unplug size={14} strokeWidth={1.75} />
                  )}
                  Отключить
                </Button>
              </div>
            </SlideUp>
          ) : null}
        </Presence>
      </div>
    </>
  );
}
