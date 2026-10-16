import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 font-sans text-[13px] font-semibold ' +
  'transition-[box-shadow,background-color,opacity] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer';

const VARIANTS: Record<Variant, string> = {
  primary:
    'border-0 bg-gradient-to-r from-orange to-orange-soft text-white shadow-[0_8px_24px_-8px_rgba(240,99,31,0.7)] hover:shadow-[0_8px_28px_-6px_rgba(240,99,31,0.85)]',
  secondary: 'border border-line-strong bg-night-2/70 text-white hover:bg-night-2',
  ghost: 'border border-transparent bg-transparent text-ink hover:bg-blue/10',
  danger: 'border border-bad/50 bg-bad/10 text-bad hover:bg-bad/20',
};

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest} />;
}
