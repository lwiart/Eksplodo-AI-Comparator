import type { HTMLAttributes } from 'react';

type Tone = 'default' | 'live' | 'good' | 'bad';

const TONES: Record<Tone, string> = {
  default: 'border-line-strong bg-night-2/60 text-ink',
  live: 'border-orange/50 bg-orange/10 text-peach',
  good: 'border-good/40 bg-good/15 text-good',
  bad: 'border-bad/40 bg-bad/15 text-bad',
};

/** Pastille d'information (étiquette, statut) en Noto Sans Mono. */
export function Chip({
  tone = 'default',
  className = '',
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${TONES[tone]} ${className}`}
      {...rest}
    />
  );
}
