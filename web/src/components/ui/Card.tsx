import type { HTMLAttributes } from 'react';

/** Carte « Nuit » : dégradé bleu nuit, bordure fine, angles de 18 px. */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card-surface p-4 ${className}`} {...rest} />;
}
