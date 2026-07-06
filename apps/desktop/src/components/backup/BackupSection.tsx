import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  DownloadCloud,
  GitBranch,
  History,
  Loader,
  Sparkle,
  TriangleAlert,
  UploadCloud,
} from 'lucide-react';
import { Button, Input, Switch, cx } from '@graphite/ui';
import { isTauriAvailable } from '@graphite/bindings';
import { Fade, Presence, REDUCED_CROSSFADE, SlideUp, springSnappy, usePrefersReducedMotion } from '../../motion';
import { GRAPHITE_REMOTE_URL, useGitStore } from '../../stores/gitStore';

type DotKind = 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

const DOT_COLOR: Record<DotKind, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-text-3',
  accent: 'bg-accent',
};

function Dot({ kind, pulse }: { kind: DotKind; pulse?: boolean }) {
  return <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', DOT_COLOR[kind], pulse && 'animate-pulse')} />;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-stroke-0 py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui text-text-0">{title}</span>
        {hint !== undefined ? <span className="truncate text-caption text-text-2">{hint}</span> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

interface EnabledHintProps {
  on: boolean;
  label: string;
  reduced: boolean;
}

/**
 * Индикатор «включено» рядом с тумблером. Всегда занимает своё место и лишь
 * проявляется/гаснет — Switch при переключении не прыгает по горизонтали.
 */
function EnabledHint({ on, label, reduced }: EnabledHintProps) {
  return (
    <motion.span
      aria-hidden={!on}
      initial={false}
      animate={on ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.92 }}
      transition={reduced ? REDUCED_CROSSFADE : springSnappy}
      className="flex items-center gap-1 text-caption text-ai"
    >
      <Sparkle size={12} strokeWidth={1.75} />
      {label}
    </motion.span>
  );
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
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days === 1) {
    return 'вчера';
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function BackupSection() {
  const status = useGitStore((s) => s.status);
  const statusLoading = useGitStore((s) => s.statusLoading);
  const busy = useGitStore((s) => s.busy);
  const pushing = useGitStore((s) => s.pushing);
  const pulling = useGitStore((s) => s.pulling);
  const autoSnapshot = useGitStore((s) => s.autoSnapshot);
  const setAutoSnapshot = useGitStore((s) => s.setAutoSnapshot);
  const autoPush = useGitStore((s) => s.autoPush);
  const setAutoPush = useGitStore((s) => s.setAutoPush);
  const refreshStatus = useGitStore((s) => s.refreshStatus);
  const init = useGitStore((s) => s.init);
  const snapshot = useGitStore((s) => s.snapshot);
  const setRemote = useGitStore((s) => s.setRemote);
  const push = useGitStore((s) => s.push);
  const pull = useGitStore((s) => s.pull);
  const openTimeline = useGitStore((s) => s.openTimeline);
  const reduced = usePrefersReducedMotion();

  const inTauri = isTauriAvailable();
  const [remoteDraft, setRemoteDraft] = useState('');
  const focusedRef = useRef(false);

  useEffect(() => {
    if (inTauri) {
      void refreshStatus();
    }
  }, [inTauri, refreshStatus]);

  // Синхронизируем поле с сервером, пока пользователь его не редактирует.
  const remoteUrl = status?.remoteUrl ?? '';
  useEffect(() => {
    if (!focusedRef.current) {
      setRemoteDraft(remoteUrl);
    }
  }, [remoteUrl]);

  if (!inTauri) {
    return (
      <Row title="История версий" hint="Резервные копии доступны только в установленном приложении">
        <span className="text-caption text-text-3">Недоступно</span>
      </Row>
    );
  }

  const isRepo = status?.isRepo === true;
  const installed = status?.installed !== false;
  const changed = status?.changedFiles ?? 0;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const hasRemote = status?.hasRemote === true;
  const remoteDirty = remoteDraft.trim() !== remoteUrl;

  return (
    <>
      {/* Состояние репозитория. */}
      {status === null && statusLoading ? (
        <Row title="Проверка репозитория…">
          <Dot kind="muted" pulse={!reduced} />
        </Row>
      ) : !installed ? (
        <Row
          title="Git не установлен"
          hint="Установите Git, чтобы включить историю версий и резервные копии"
        >
          <span className="flex items-center gap-1.5 text-caption text-warn">
            <TriangleAlert size={14} strokeWidth={1.75} />
            Нет Git
          </span>
        </Row>
      ) : !isRepo ? (
        <div className="flex items-start justify-between gap-4 border-t border-stroke-0 py-3 first:border-t-0 first:pt-0">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui text-text-0">История версий выключена</span>
            <span className="text-caption text-text-2">
              Включите её — каждый снимок сохраняет состояние всех заметок, к нему можно вернуться.
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={() => void init()} disabled={busy}>
            {busy ? (
              <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
            ) : (
              <GitBranch size={14} strokeWidth={1.75} />
            )}
            Включить историю
          </Button>
        </div>
      ) : (
        <>
          {/* Живой статус: ветка / изменения / последний снимок. */}
          <div className="flex items-start justify-between gap-4 border-t border-stroke-0 py-3 first:border-t-0 first:pt-0">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption text-text-1">
                  <GitBranch size={12} strokeWidth={1.75} className="text-accent" />
                  {status?.branch ?? 'HEAD'}
                </span>
                {changed > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption text-text-1">
                    <Dot kind="warn" />
                    {changed} несохранённых
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption text-text-1">
                    <Check size={12} strokeWidth={2} className="text-ok" />
                    Всё сохранено
                  </span>
                )}
                {ahead > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-stroke-0 bg-bg-2 px-2 py-1 text-caption text-text-2">
                    <ArrowUp size={12} strokeWidth={2} />
                    {ahead}
                  </span>
                ) : null}
                {behind > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-stroke-0 bg-bg-2 px-2 py-1 text-caption text-text-2">
                    <ArrowDown size={12} strokeWidth={2} />
                    {behind}
                  </span>
                ) : null}
              </div>
              {status?.lastCommit !== undefined ? (
                <span className="truncate text-caption text-text-2">
                  Последний снимок: «{status.lastCommit.subject}» · {formatRelative(status.lastCommit.date)}
                </span>
              ) : (
                <span className="text-caption text-text-2">Снимков пока нет — сделайте первый</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => openTimeline()}>
                <History size={14} strokeWidth={1.75} />
                История
              </Button>
              <Button variant="primary" size="sm" onClick={() => void snapshot()} disabled={busy}>
                {busy ? (
                  <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                ) : (
                  <Camera size={14} strokeWidth={1.75} />
                )}
                Снимок
              </Button>
            </div>
          </div>

          {/* Авто-снимки. */}
          <Row
            title="Авто-снимки"
            hint="Тихо сохранять точку восстановления через полторы минуты после правок"
          >
            <div className="flex items-center gap-2">
              <EnabledHint on={autoSnapshot} label="Включены" reduced={reduced} />
              <Switch checked={autoSnapshot} onCheckedChange={setAutoSnapshot} />
            </div>
          </Row>

          {/* Удалённый репозиторий. */}
          <div className="flex flex-col gap-2 border-t border-stroke-0 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-ui text-text-0">Удалённый репозиторий</span>
              <span className="text-caption text-text-2">
                Адрес пустого репозитория GitHub — резервная копия хранилища в облаке
              </span>
            </div>
            <Presence>
              {!hasRemote ? (
                <SlideUp key="quick-connect">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void setRemote(GRAPHITE_REMOTE_URL)}
                    disabled={busy}
                    className="w-full"
                  >
                    {busy ? (
                      <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                    ) : (
                      <GitBranch size={14} strokeWidth={1.75} />
                    )}
                    Подключить репозиторий Graphite
                  </Button>
                </SlideUp>
              ) : null}
            </Presence>
            <div className="flex items-center gap-2">
              <Input
                value={remoteDraft}
                onChange={(event) => setRemoteDraft(event.target.value)}
                onFocus={() => {
                  focusedRef.current = true;
                }}
                onBlur={() => {
                  focusedRef.current = false;
                }}
                placeholder="https://github.com/user/vault.git"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-caption"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void setRemote(remoteDraft.trim())}
                disabled={busy || !remoteDirty}
              >
                Сохранить
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void push()} disabled={!hasRemote || pushing || busy}>
                {pushing ? (
                  <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                ) : (
                  <UploadCloud size={14} strokeWidth={1.75} />
                )}
                Отправить на GitHub
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void pull()} disabled={!hasRemote || pulling || busy}>
                {pulling ? (
                  <Loader size={14} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />
                ) : (
                  <DownloadCloud size={14} strokeWidth={1.75} />
                )}
                Забрать
              </Button>
              {!hasRemote ? <span className="text-caption text-text-3">Сначала укажите адрес</span> : null}
            </div>
            <Presence>
              {hasRemote ? (
                <Fade key="auto-push-row" className="flex items-center justify-between gap-4 border-t border-stroke-0 pt-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-ui text-text-0">Авто-отправка на GitHub</span>
                    <span className="text-caption text-text-2">
                      После каждого снимка отправлять резервную копию в облако
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <EnabledHint on={autoPush} label="Включена" reduced={reduced} />
                    <Switch checked={autoPush} onCheckedChange={setAutoPush} />
                  </div>
                </Fade>
              ) : null}
            </Presence>
          </div>
        </>
      )}
    </>
  );
}
