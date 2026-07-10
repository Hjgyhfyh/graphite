import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getVersion } from '@tauri-apps/api/app';
import {
  Check,
  Cloud,
  Copy,
  Database,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HardDrive,
  Keyboard,
  Loader,
  Palette,
  PanelLeft,
  Plug,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Switch, Tooltip, cx } from '@graphite/ui';
import { commands, isGraphiteError, isTauriAvailable } from '@graphite/bindings';
import type { ClaudeCliInfo, IndexStatus } from '@graphite/bindings';
import { Fade, REDUCED_CROSSFADE, springSnappy, usePrefersReducedMotion } from '../../motion';
import {
  ANIMATION_SPEED_MAX,
  ANIMATION_SPEED_MIN,
  useUiStore,
} from '../../stores/uiStore';
import { isSyncPath, useSyncStore } from '../../stores/syncStore';
import { useUpdaterStore } from '../../stores/updaterStore';
import { forgetVault, pickVaultFolder, switchVault } from '../../stores/vaultActions';
import { useVaultStore } from '../../stores/vaultStore';
import { useVaultsStore, vaultKey } from '../../stores/vaultsStore';
import { BackupSection } from '../backup/BackupSection';
import { KeybindingsEditor } from './KeybindingsEditor';
import { RailLayoutEditor } from './RailLayoutEditor';
import { SyncSection } from './SyncSection';
import { ThemeSelect } from './ThemeSelect';

const MCP_ADD_COMMAND = 'claude mcp add graphite';

const SECTIONS = [
  { id: 'storage', title: 'Хранилище', icon: Database },
  { id: 'sync', title: 'Синхронизация', icon: Cloud },
  { id: 'mcp', title: 'Ассистент', icon: Plug },
  { id: 'appearance', title: 'Внешний вид', icon: Palette },
  { id: 'sidebar', title: 'Боковая панель', icon: PanelLeft },
  { id: 'backup', title: 'Копии', icon: GitBranch },
  { id: 'updates', title: 'Обновления', icon: Sparkles },
  { id: 'keys', title: 'Клавиши', icon: Keyboard },
] as const satisfies readonly { id: string; title: string; icon: LucideIcon }[];

type DotKind = 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

const DOT_COLOR: Record<DotKind, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-text-3',
  accent: 'bg-accent',
};

function StatusDot({ kind, pulse }: { kind: DotKind; pulse?: boolean }) {
  return <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', DOT_COLOR[kind], pulse && 'animate-pulse')} />;
}

interface RowProps {
  title: string;
  hint?: string;
  children: ReactNode;
}

function Row({ title, hint, children }: RowProps) {
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

interface SectionProps {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  sectionRef: (el: HTMLElement | null) => void;
  children: ReactNode;
}

function Section({ id, icon: Icon, title, description, sectionRef, children }: SectionProps) {
  return (
    <section id={id} ref={sectionRef} className="scroll-mt-6 rounded-l border border-stroke-0 bg-bg-1 p-5">
      <header className="mb-3 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-s border border-stroke-0 bg-bg-2 text-text-1">
          <Icon size={16} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col">
          <h2 className="text-h3 text-text-0">{title}</h2>
          {description !== undefined ? <p className="text-caption text-text-2">{description}</p> : null}
        </div>
      </header>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Chip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-0 bg-bg-2 px-2.5 py-1 text-caption">
      <span className="text-text-2">{label}</span>
      <span className="font-mono text-text-0">{value}</span>
    </span>
  );
}

function CopyBlock({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(value)}
      className="group flex w-full items-center gap-2 overflow-hidden rounded-s border border-stroke-1 bg-bg-2 px-2.5 py-1.5 text-left font-mono text-caption text-text-1 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <Copy size={13} strokeWidth={1.75} className="shrink-0 text-text-2 group-hover:text-text-0" />
    </button>
  );
}

type PingState = { state: 'idle' | 'busy' | 'ok' | 'fail'; ms?: number };
type CliState = 'checking' | 'found' | 'missing' | 'offline';

const CLI_LABEL: Record<CliState, string> = {
  checking: 'Проверка…',
  found: 'Обнаружен',
  missing: 'Не найден',
  offline: 'Ядро офлайн',
};

const CLI_DOT: Record<CliState, DotKind> = {
  checking: 'muted',
  found: 'ok',
  missing: 'warn',
  offline: 'danger',
};

const INDEX_LABEL: Record<IndexStatus['state'], string> = {
  idle: 'Индекс актуален',
  scanning: 'Сканирование файлов…',
  indexing: 'Индексация…',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function KnownVaults() {
  const known = useVaultsStore((s) => s.known);
  const root = useVaultStore((s) => s.info?.root);
  const syncCodes = useSyncStore((s) => s.codes);
  const syncStatus = useSyncStore((s) => s.status);
  const reduced = usePrefersReducedMotion();
  const [switchingPath, setSwitchingPath] = useState<string | undefined>(undefined);

  const activeKey = root === undefined ? undefined : vaultKey(root);
  const busy = switchingPath !== undefined;

  const select = async (path: string) => {
    if (busy) {
      return;
    }
    setSwitchingPath(path);
    try {
      await switchVault(path);
    } finally {
      setSwitchingPath(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-stroke-0 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ui text-text-0">Мои хранилища</span>
          <span className="text-caption text-text-2">
            Переключение между папками с заметками; список хранится на этом устройстве
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void pickVaultFolder(false)}>
            <FolderOpen size={14} strokeWidth={1.75} />
            Открыть другую…
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void pickVaultFolder(true)}>
            <FolderPlus size={14} strokeWidth={1.75} />
            Создать…
          </Button>
        </div>
      </div>
      {known.length === 0 ? (
        <p className="text-caption text-text-2">Откройте папку — она появится здесь для быстрого переключения.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <AnimatePresence initial={false}>
            {known.map((vault) => {
              const active = activeKey !== undefined && vaultKey(vault.path) === activeKey;
              const switching = switchingPath === vault.path;
              const sync = isSyncPath(syncCodes, syncStatus, vault.path);
              const VaultIcon = sync ? Cloud : HardDrive;
              return (
                <motion.div
                  key={vaultKey(vault.path)}
                  layout={!reduced}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                  transition={reduced ? REDUCED_CROSSFADE : { layout: springSnappy, default: springSnappy, opacity: { duration: 0.14 } }}
                  className={cx(
                    'group flex items-center gap-2.5 rounded-m border px-3 py-2 transition-colors duration-[120ms]',
                    active ? 'border-accent/35 bg-bg-2' : 'border-stroke-0 bg-bg-2 hover:border-stroke-1 hover:bg-bg-3',
                  )}
                >
                  <VaultIcon
                    size={15}
                    strokeWidth={1.75}
                    className={cx('shrink-0', active ? 'text-accent' : 'text-text-2')}
                  />
                  <button
                    type="button"
                    disabled={active || busy}
                    onClick={() => void select(vault.path)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-ui text-text-0">{vault.name}</span>
                      {active ? (
                        <motion.span
                          layoutId="settings-vault-active"
                          transition={reduced ? { duration: 0 } : springSnappy}
                          className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-micro text-accent"
                        >
                          Активное
                        </motion.span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-micro text-text-2">{vault.path}</span>
                  </button>
                  {switching ? (
                    <Loader
                      size={14}
                      strokeWidth={1.75}
                      className={cx('shrink-0 text-text-2', !reduced && 'animate-spin')}
                    />
                  ) : null}
                  {!active ? (
                    <Tooltip content="Убрать из списка" side="left">
                      <button
                        type="button"
                        aria-label={`Убрать «${vault.name}» из списка`}
                        onClick={() => forgetVault(vault.path)}
                        className="flex size-6 shrink-0 items-center justify-center rounded-xs text-text-3 opacity-0 transition-[color,opacity,background-color] duration-[120ms] hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 active:scale-90 group-hover:opacity-100"
                      >
                        <X size={13} strokeWidth={1.75} />
                      </button>
                    </Tooltip>
                  ) : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const setReducedMotion = useUiStore((s) => s.setReducedMotion);
  const animationSpeed = useUiStore((s) => s.animationSpeed);
  const setAnimationSpeed = useUiStore((s) => s.setAnimationSpeed);
  const readingMode = useUiStore((s) => s.readingMode);
  const setReadingMode = useUiStore((s) => s.setReadingMode);
  const showPropsInText = useUiStore((s) => s.showPropsInText);
  const setShowPropsInText = useUiStore((s) => s.setShowPropsInText);
  const pushToast = useUiStore((s) => s.pushToast);

  const updaterStatus = useUpdaterStore((s) => s.status);
  const updaterAvailable = useUpdaterStore((s) => s.available);

  const info = useVaultStore((s) => s.info);
  const indexStatus = useVaultStore((s) => s.indexStatus);

  const reduced = usePrefersReducedMotion();

  const mounted = useRef(true);
  const scrollRef = useRef<HTMLElement | null>(null);
  const sectionEls = useRef<Record<string, HTMLElement | null>>({});

  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const [cli, setCli] = useState<ClaudeCliInfo | undefined>(undefined);
  const [cliState, setCliState] = useState<CliState>('checking');
  const [ping, setPing] = useState<PingState>({ state: 'idle' });
  const [reindexing, setReindexing] = useState(false);
  const [polled, setPolled] = useState<IndexStatus | undefined>(undefined);
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined);

  const detect = async () => {
    setCliState('checking');
    try {
      const result = await commands.detectClaudeCli();
      if (!mounted.current) {
        return;
      }
      setCli(result);
      setCliState(result.found ? 'found' : 'missing');
    } catch {
      if (!mounted.current) {
        return;
      }
      setCli(undefined);
      setCliState('offline');
    }
  };

  useEffect(() => {
    mounted.current = true;
    void useVaultStore.getState().loadInfo();
    void detect();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) {
      return;
    }
    let active = true;
    void getVersion().then(
      (version) => {
        if (active) {
          setAppVersion(version);
        }
      },
      () => {
        // версия недоступна вне приложения — мягкая деградация
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      { root, rootMargin: '-10% 0px -75% 0px', threshold: 0 },
    );
    for (const section of SECTIONS) {
      const el = sectionEls.current[section.id];
      if (el !== null && el !== undefined) {
        observer.observe(el);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, []);

  const scrollTo = (id: string) => {
    sectionEls.current[id]?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  const copyValue =
    (okMessage: string) =>
    (value: string): void => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        pushToast({ kind: 'error', text: 'Буфер обмена недоступен' });
        return;
      }
      try {
        void navigator.clipboard.writeText(value).then(
          () => pushToast({ kind: 'success', text: okMessage }),
          () => pushToast({ kind: 'error', text: 'Не удалось скопировать' }),
        );
      } catch {
        pushToast({ kind: 'error', text: 'Не удалось скопировать' });
      }
    };

  const reindex = async () => {
    if (reindexing) {
      return;
    }
    setReindexing(true);
    setPolled({ state: 'scanning', done: 0, total: 0 });
    try {
      await commands.reindex(true);
    } catch (error) {
      if (mounted.current) {
        setReindexing(false);
        setPolled(undefined);
      }
      pushToast({
        kind: 'error',
        text:
          isGraphiteError(error) && error.code === 'UNAVAILABLE'
            ? 'Ядро ещё не подключено'
            : 'Не удалось пересобрать индекс',
      });
      return;
    }
    let completed = false;
    let failed = false;
    for (let i = 0; i < 300 && mounted.current; i += 1) {
      let status: IndexStatus;
      try {
        status = await commands.indexStatus();
      } catch {
        failed = true;
        break;
      }
      if (!mounted.current) {
        return;
      }
      setPolled(status);
      if (status.state === 'idle') {
        completed = true;
        break;
      }
      await delay(350);
    }
    if (mounted.current) {
      setReindexing(false);
      setPolled(undefined);
      if (completed) {
        pushToast({ kind: 'success', text: 'Индекс пересобран' });
      } else if (failed) {
        pushToast({ kind: 'error', text: 'Не удалось подтвердить пересборку' });
      } else {
        pushToast({ kind: 'info', text: 'Индексация ещё идёт — обновите позже' });
      }
    }
  };

  const testPing = async () => {
    setPing({ state: 'busy' });
    const started = performance.now();
    try {
      await commands.vaultInfo();
      if (!mounted.current) {
        return;
      }
      const ms = Math.round(performance.now() - started);
      setPing({ state: 'ok', ms });
      pushToast({ kind: 'success', text: `Ядро отвечает · ${ms} мс` });
    } catch {
      if (!mounted.current) {
        return;
      }
      setPing({ state: 'fail' });
      pushToast({ kind: 'error', text: 'Ядро не отвечает' });
    }
  };

  const command = cli?.mcpAddCommand ?? MCP_ADD_COMMAND;
  const inTauri = isTauriAvailable();
  const indexView = reindexing && polled !== undefined ? polled : indexStatus;
  const indexBusy = reindexing || indexView.state !== 'idle';
  const indeterminate = indexView.total === 0;
  const indexProgress = indexView.total > 0 ? Math.min(1, indexView.done / indexView.total) : 0;

  return (
    <main ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto bg-bg-0">
      <Fade className="mx-auto w-full max-w-4xl px-8 py-8">
        <header className="mb-6">
          <h1 className="text-h1 text-text-0">Настройки</h1>
          <p className="mt-1 text-ui text-text-2">Хранилище, ассистент, внешний вид и горячие клавиши</p>
        </header>

        <div className="flex gap-8">
          <nav className="sticky top-0 hidden h-max w-40 shrink-0 flex-col gap-0.5 self-start md:flex">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const on = active === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => scrollTo(section.id)}
                  className={cx(
                    'relative flex h-8 items-center gap-2 rounded-s px-2.5 text-left text-ui transition-colors duration-[120ms]',
                    on ? 'text-text-0' : 'text-text-2 hover:text-text-1',
                  )}
                >
                  {on ? (
                    <motion.span
                      layoutId="settingsNavActive"
                      className="absolute inset-0 -z-10 rounded-s bg-bg-2"
                      transition={springSnappy}
                    />
                  ) : null}
                  <Icon size={15} strokeWidth={1.75} className={cx('shrink-0', on ? 'text-accent' : 'text-text-3')} />
                  <span className="truncate">{section.title}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Section
              id="storage"
              icon={Database}
              title="Хранилище"
              description="Локальная папка с вашими заметками"
              sectionRef={(el) => {
                sectionEls.current.storage = el;
              }}
            >
              <Row
                title="Папка хранилища"
                hint={info?.vaultFormat !== undefined ? `Формат ${info.vaultFormat}` : 'Заметки — обычные markdown-файлы'}
              >
                {info?.root !== undefined ? (
                  <div className="w-64 max-w-full">
                    <CopyBlock value={info.root} onCopy={copyValue('Путь скопирован')} />
                  </div>
                ) : (
                  <span className="text-caption text-text-2">Не открыто</span>
                )}
              </Row>

              {info !== undefined ? (
                <div className="flex flex-wrap gap-1.5 border-t border-stroke-0 py-3">
                  <Chip label="Заметки" value={info.counts.notes} />
                  <Chip label="Планы" value={info.counts.plans} />
                  <Chip label="Задачи" value={info.counts.tasksOpen} />
                  <Chip label="Входящие" value={info.counts.inbox} />
                </div>
              ) : null}

              <KnownVaults />

              <div className="flex items-start justify-between gap-4 border-t border-stroke-0 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-ui text-text-0">Поисковый индекс</span>
                  <span className="text-caption text-text-2">Пересоберите, если поиск устарел или что-то не находится</span>
                  <div className="mt-0.5 flex items-center gap-2 text-caption">
                    <StatusDot kind={indexView.state === 'idle' ? 'ok' : 'accent'} pulse={indexBusy && !reduced} />
                    <span className="text-text-1">
                      {reindexing && indexView.state === 'idle' ? 'Запуск…' : INDEX_LABEL[indexView.state]}
                    </span>
                    {indexView.total > 0 ? (
                      <span className="font-mono text-text-2">
                        {indexView.done} / {indexView.total}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void reindex()} disabled={reindexing}>
                  <RefreshCw size={14} strokeWidth={1.75} className={cx(reindexing && !reduced && 'animate-spin')} />
                  {reindexing ? 'Пересборка…' : 'Пересобрать'}
                </Button>
              </div>

              {indexBusy ? (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
                  {indeterminate ? (
                    <div className="h-full w-2/5 rounded-full bg-accent/60 animate-pulse" />
                  ) : (
                    <div
                      className="h-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out"
                      style={{ transform: `scaleX(${indexProgress})` }}
                    />
                  )}
                </div>
              ) : null}
            </Section>

            <Section
              id="sync"
              icon={Cloud}
              title="Синхронизация"
              description="Одно хранилище на нескольких устройствах — по секретному коду"
              sectionRef={(el) => {
                sectionEls.current.sync = el;
              }}
            >
              <SyncSection />
            </Section>

            <Section
              id="mcp"
              icon={Plug}
              title="Ассистент (MCP)"
              description="Дайте Claude Code доступ к этому хранилищу"
              sectionRef={(el) => {
                sectionEls.current.mcp = el;
              }}
            >
              <Row title="Claude Code" hint={cli?.path ?? 'Локальный ИИ-клиент, работает через MCP'}>
                <div className="flex items-center gap-2">
                  <StatusDot kind={CLI_DOT[cliState]} pulse={cliState === 'checking' && !reduced} />
                  <span className="text-ui text-text-1">{CLI_LABEL[cliState]}</span>
                  <button
                    type="button"
                    aria-label="Проверить снова"
                    onClick={() => void detect()}
                    className="flex size-6 items-center justify-center rounded-xs text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0"
                  >
                    <RefreshCw
                      size={13}
                      strokeWidth={1.75}
                      className={cx(cliState === 'checking' && !reduced && 'animate-spin')}
                    />
                  </button>
                </div>
              </Row>

              <div className="flex flex-col gap-1.5 border-t border-stroke-0 py-3">
                <span className="text-caption text-text-2">Команда подключения — выполните в терминале</span>
                <CopyBlock value={command} onCopy={copyValue('Команда скопирована')} />
              </div>

              <Row title="Проверка связи" hint="Пинг ядра через vault_info">
                <div className="flex items-center gap-2.5">
                  {ping.state === 'ok' ? (
                    <span className="flex items-center gap-1.5 text-caption text-ok">
                      <Check size={13} strokeWidth={1.75} />
                      {ping.ms} мс
                    </span>
                  ) : null}
                  {ping.state === 'fail' ? <span className="text-caption text-danger">Нет ответа</span> : null}
                  <Button variant="ghost" size="sm" onClick={() => void testPing()} disabled={ping.state === 'busy'}>
                    <Zap size={14} strokeWidth={1.75} />
                    {ping.state === 'busy' ? 'Пинг…' : 'Тест-пинг'}
                  </Button>
                </div>
              </Row>
            </Section>

            <Section
              id="appearance"
              icon={Palette}
              title="Внешний вид"
              description="Тема, анимации и режим чтения"
              sectionRef={(el) => {
                sectionEls.current.appearance = el;
              }}
            >
              <Row title="Тема" hint="Палитра всего приложения, включая редактор">
                <ThemeSelect />
              </Row>
              <Row title="Режим чтения" hint="Крупный набор без интерфейса редактора">
                <Switch checked={readingMode} onCheckedChange={setReadingMode} />
              </Row>
              <Row title="Свойства в тексте" hint="Показывать YAML-блок в начале заметки — по умолчанию он скрыт, свойства правятся на панели справа">
                <Switch checked={showPropsInText} onCheckedChange={setShowPropsInText} />
              </Row>
              <Row title="Меньше движения" hint="Заменяет анимации коротким кроссфейдом">
                <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} />
              </Row>
              <Row
                title="Скорость анимаций"
                hint={reducedMotion ? 'Отключено в режиме «меньше движения»' : `${animationSpeed.toFixed(1)}×`}
              >
                <div className="flex w-44 flex-col gap-1">
                  <input
                    type="range"
                    min={ANIMATION_SPEED_MIN}
                    max={ANIMATION_SPEED_MAX}
                    step={0.1}
                    value={animationSpeed}
                    disabled={reducedMotion}
                    onChange={(event) => setAnimationSpeed(Number(event.target.value))}
                    className="h-1 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
                  />
                  <div className="flex justify-between text-micro text-text-3">
                    <span>0.5×</span>
                    <span>1×</span>
                    <span>1.6×</span>
                  </div>
                </div>
              </Row>
            </Section>

            <Section
              id="sidebar"
              icon={PanelLeft}
              title="Боковая панель"
              description="Порядок и видимость разделов на рейке слева"
              sectionRef={(el) => {
                sectionEls.current.sidebar = el;
              }}
            >
              <RailLayoutEditor />
            </Section>

            <Section
              id="backup"
              icon={GitBranch}
              title="Резервные копии и история"
              description="Снимки состояния хранилища и синхронизация с GitHub"
              sectionRef={(el) => {
                sectionEls.current.backup = el;
              }}
            >
              <BackupSection />
            </Section>

            <Section
              id="updates"
              icon={Sparkles}
              title="Обновления"
              description="Приложение обновляется автоматически"
              sectionRef={(el) => {
                sectionEls.current.updates = el;
              }}
            >
              <Row
                title="Версия приложения"
                hint={
                  inTauri
                    ? 'Проверьте и установите новую версию в один клик'
                    : 'Доступно только в установленном приложении'
                }
              >
                <div className="flex items-center gap-2.5">
                  {updaterStatus === 'available' && updaterAvailable !== null ? (
                    <span className="flex items-center gap-1.5 text-caption text-accent">
                      <StatusDot kind="accent" pulse={!reduced} />
                      Доступно v{updaterAvailable.version}
                    </span>
                  ) : null}
                  {updaterStatus === 'uptodate' ? (
                    <span className="flex items-center gap-1.5 text-caption text-ok">
                      <Check size={13} strokeWidth={1.75} />
                      Актуальная
                    </span>
                  ) : null}
                  {updaterStatus === 'error' ? (
                    <span className="text-caption text-danger">Не удалось проверить</span>
                  ) : null}
                  <span className="font-mono text-caption text-text-1">{appVersion ?? '—'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void useUpdaterStore.getState().check(true)}
                    disabled={!inTauri || updaterStatus === 'checking' || updaterStatus === 'downloading'}
                  >
                    <RefreshCw
                      size={14}
                      strokeWidth={1.75}
                      className={cx(updaterStatus === 'checking' && !reduced && 'animate-spin')}
                    />
                    {updaterStatus === 'checking' ? 'Проверка…' : 'Проверить обновления'}
                  </Button>
                </div>
              </Row>
            </Section>

            <Section
              id="keys"
              icon={Keyboard}
              title="Горячие клавиши"
              description="Все действия переназначаемы и работают во всём приложении"
              sectionRef={(el) => {
                sectionEls.current.keys = el;
              }}
            >
              <KeybindingsEditor />
            </Section>
          </div>
        </div>
      </Fade>
    </main>
  );
}
