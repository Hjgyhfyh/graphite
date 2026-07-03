import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BASE =
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-s text-ui transition-[background-color,color,transform] duration-[120ms] ease-out active:scale-98 disabled:pointer-events-none disabled:opacity-45';

const SIZES: Record<ButtonSize, string> = {
  md: 'h-8 px-3',
  sm: 'h-7 px-2.5',
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg-0 shadow-1 inset-shadow-hairline hover:bg-accent/90 active:bg-accent/80',
  ghost: 'bg-transparent text-text-1 hover:bg-bg-3 hover:text-text-0 active:bg-bg-4',
  danger: 'bg-danger text-bg-0 shadow-1 inset-shadow-hairline hover:bg-danger/90 active:bg-danger/80',
};

export function Button({ variant = 'primary', size = 'md', type = 'button', className, ...props }: ButtonProps) {
  return <button type={type} className={cx(BASE, SIZES[size], VARIANTS[variant], className)} {...props} />;
}
