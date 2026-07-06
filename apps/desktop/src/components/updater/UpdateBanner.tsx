import { useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, CircleCheck, Download, Loader, RotateCw, Sparkles } from 'lucide-react';
import { Button, cx } from '@graphite/ui';
import { REDUCED_CROSSFADE, springSnappy, springStandard, usePrefersReducedMotion } from '../../motion';
import { useUpdaterStore } from '../../stores/updaterStore';
import type { UpdateProgress } from '../../stores/updaterStore';

const BRAND_GRADIENT = 'linear-gradient(120deg, var(--accent), var(--ai))';
const BADGE_GRADIENT = 'linear-gradient(135deg, var(--accent-dim), var(--ai-dim))';
const SHEEN_GRADIENT = 'linear-gradient(90deg, transparent, var(--accent), var(--ai), transparent)';
const BAR_GRADIENT = 'linear-gradient(90deg, var(--accent), var(--ai))';
const SHIMMER_GRADIENT = 'linear-gradient(90deg, transparent, var(--accent), var(--ai), transparent)';

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} МБ`;
}

function formatDate(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.replace(/ (\d{2}:\d{2}:\d{2}).*$/, 'T$1');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function IconBadge({ icon, tint }: { icon: ReactNode; tint: 'accent' | 'ai' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-m border border-stroke-0 inset-shadow-hairline',
        tint === 'accent' ? 'text-accent' : 'text-ai',
      )}
      style={{ backgroundImage: BADGE_GRADIENT }}
    >
      {icon}
    </span>
  );
}

interface AccentButtonProps {
  onClick: () => void;
  glow: boolean;
  reduced: boolean;
  children: ReactNode;
}

function AccentButton({ onClick, glow, reduced, children }: AccentButtonProps) {
  return (
    <span className="relative inline-flex shrink-0">
      {glow ? (
        <motion.span
          aria-hidden
          className="absolute -inset-1 -z-10 rounded-m blur-md"
          style={{ backgroundImage: BRAND_GRADIENT }}
          initial={{ opacity: 0.35 }}
          animate={reduced ? { opacity: 0.4 } : { opacity: [0.3, 0.6, 0.3] }}
          transition={reduced ? undefined : { duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        style={{ backgroundImage: BRAND_GRADIENT }}
        className="relative inline-flex h-8 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-s px-3.5 text-ui font-medium text-bg-0 shadow-1 inset-shadow-hairline transition-[transform,filter] duration-[120ms] ease-out hover:brightness-[1.06] active:scale-98"
      >
        {children}
      </button>
    </span>
  );
}

function AvailableContent({
  version,
  notes,
  date,
  reduced,
}: {
  version: string;
  notes: string | undefined;
  date: string | undefined;
  reduced: boolean;
}) {
  const install = useUpdaterStore((s) => s.install);
  const dismiss = useUpdaterStore((s) => s.dismiss);
  const [notesOpen, setNotesOpen] = useState(false);
  const released = formatDate(date);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 p-3.5">
        <IconBadge tint="accent" icon={<Sparkles size={18} strokeWidth={1.75} />} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui text-text-0">
            Доступно обновление <span className="font-medium text-accent">Graphite v{version}</span>
          </div>
          <div className="truncate text-caption text-text-2">
            {released !== undefined ? `Выпущено ${released}` : 'Свежая версия готова к установке'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => dismiss()}>
            Позже
          </Button>
          <AccentButton glow={false} reduced={reduced} onClick={() => void install()}>
            <Download size={15} strokeWidth={1.75} />
            Обновить
          </AccentButton>
        </div>
      </div>

      {notes !== undefined ? (
        <div className="border-t border-stroke-0">
          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            className="flex w-full select-none items-center gap-1.5 px-3.5 py-2 text-caption text-text-2 transition-colors duration-[120ms] hover:text-text-1"
          >
            <ChevronRight
              size={13}
              strokeWidth={2}
              className={cx('shrink-0 transition-transform duration-150 ease-out', notesOpen && 'rotate-90')}
            />
            Что нового
          </button>
          {notesOpen ? (
            <motion.div
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={reduced ? REDUCED_CROSSFADE : { duration: 0.18, ease: 'easeOut' }}
              className="max-h-40 overflow-y-auto whitespace-pre-line px-3.5 pb-3.5 text-caption leading-relaxed text-text-1"
            >
              {notes}
            </motion.div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DownloadingContent({ progress, reduced }: { progress: UpdateProgress | null; reduced: boolean }) {
  const total = progress?.total;
  const downloaded = progress?.downloaded ?? 0;
  const determinate = total !== undefined && total > 0;
  const fraction = determinate ? Math.min(1, downloaded / total) : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-center gap-3">
        <IconBadge
          tint="ai"
          icon={<Loader size={17} strokeWidth={1.75} className={cx(!reduced && 'animate-spin')} />}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui text-text-0">Загрузка обновления…</div>
          <div className="truncate text-caption text-text-2">
            {determinate ? `${formatMb(downloaded)} из ${formatMb(total)}` : 'Подготовка загрузки…'}
          </div>
        </div>
        {determinate ? <span className="shrink-0 text-ui tabular-nums text-text-1">{percent}%</span> : null}
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
        {determinate ? (
          <div
            className="h-full origin-left rounded-full transition-transform duration-300 ease-out"
            style={{ backgroundImage: BAR_GRADIENT, transform: `scaleX(${fraction})` }}
          />
        ) : reduced ? (
          <div className="h-full w-2/5 rounded-full bg-accent/60 animate-pulse" />
        ) : (
          <motion.div
            className="absolute inset-y-0 w-1/3 rounded-full"
            style={{ backgroundImage: SHIMMER_GRADIENT }}
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 1.15, ease: 'easeInOut', repeat: Infinity }}
          />
        )}
      </div>
    </div>
  );
}

function ReadyContent({ version, reduced }: { version: string | undefined; reduced: boolean }) {
  const relaunch = useUpdaterStore((s) => s.relaunch);
  return (
    <div className="flex items-center gap-3 p-3.5">
      <IconBadge tint="ai" icon={<CircleCheck size={18} strokeWidth={1.75} />} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-text-0">Обновление готово</div>
        <div className="truncate text-caption text-text-2">
          {version !== undefined ? `Перезапустите, чтобы перейти на v${version}` : 'Перезапустите, чтобы применить'}
        </div>
      </div>
      <AccentButton glow reduced={reduced} onClick={() => void relaunch()}>
        <RotateCw size={15} strokeWidth={1.75} />
        Перезапустить
      </AccentButton>
    </div>
  );
}

export function UpdateBanner() {
  const status = useUpdaterStore((s) => s.status);
  const available = useUpdaterStore((s) => s.available);
  const progress = useUpdaterStore((s) => s.progress);
  const dismissed = useUpdaterStore((s) => s.dismissed);
  const reduced = usePrefersReducedMotion();

  const visible =
    (status === 'available' && !dismissed) || status === 'downloading' || status === 'ready';

  let body: ReactNode = null;
  if (status === 'available' && available !== null) {
    body = (
      <AvailableContent version={available.version} notes={available.notes} date={available.date} reduced={reduced} />
    );
  } else if (status === 'downloading') {
    body = <DownloadingContent progress={progress} reduced={reduced} />;
  } else if (status === 'ready') {
    body = <ReadyContent version={available?.version} reduced={reduced} />;
  }

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-12 z-30 flex justify-center px-4">
      <AnimatePresence>
        {visible ? (
          <motion.div
            key="update-banner"
            role="status"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.965 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, y: 16, scale: 0.985, transition: { duration: 0.16, ease: 'easeIn' } }
            }
            transition={reduced ? REDUCED_CROSSFADE : { default: springStandard, opacity: { duration: 0.18 } }}
            className="pointer-events-auto relative w-[440px] max-w-full overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3 inset-shadow-hairline"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
              style={{ backgroundImage: SHEEN_GRADIENT }}
            />
            <motion.div layout={!reduced} transition={springSnappy}>
              <motion.div
                key={status}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduced ? REDUCED_CROSSFADE : { duration: 0.2, ease: 'easeOut' }}
              >
                {body}
              </motion.div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
