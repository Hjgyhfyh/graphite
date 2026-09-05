import { motion } from 'motion/react';
import { cx, easePoints } from '@graphite/ui';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { THEMES, startThemeCrossfade } from '../../theme';
import type { Theme } from '../../theme';

/**
 * Сегмент-контрол выбора темы: свотчи палитры + подпись, активный вариант
 * подсвечен «таблеткой», перелетающей между кнопками (как в наве настроек).
 * Сама смена палитры идёт кроссфейдом (startThemeCrossfade), свотчи выбранной
 * темы подтверждают выбор коротким пружинным «пыхом».
 */
export function ThemeSelect() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const reduced = usePrefersReducedMotion();

  const select = (next: Theme) => {
    if (next === theme) {
      return;
    }
    if (!reduced) {
      startThemeCrossfade();
    }
    setTheme(next);
  };

  return (
    <div aria-label="Тема оформления" className="flex max-w-full flex-wrap items-center gap-1 rounded-m border border-stroke-0 bg-bg-2 p-1">
      {THEMES.map((option) => {
        const on = option.id === theme;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => select(option.id)}
            className={cx(
              'relative isolate flex h-8 select-none items-center gap-2 rounded-s px-3 text-ui transition-[color,transform] duration-[120ms] ease-out active:scale-98',
              on ? 'text-text-0' : 'text-text-2 hover:text-text-1',
            )}
          >
            {on ? (
              <motion.span
                layoutId={reduced ? undefined : 'settingsThemeActive'}
                className="absolute inset-0 -z-10 rounded-s border border-stroke-1 bg-bg-3 shadow-1"
                transition={springSnappy}
              />
            ) : null}
            <motion.span
              aria-hidden
              initial={false}
              className="flex shrink-0 items-center -space-x-1"
              animate={on && !reduced ? { scale: [1, 1.18, 1] } : { scale: 1 }}
              transition={{ duration: 0.38, ease: easePoints.out, times: [0, 0.35, 1] }}
            >
              {option.swatch.map((color) => (
                <span
                  key={color}
                  className="size-3 rounded-full border border-bg-1"
                  style={{ backgroundColor: color }}
                />
              ))}
            </motion.span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
