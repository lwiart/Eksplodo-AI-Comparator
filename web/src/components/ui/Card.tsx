import type { ComponentProps } from 'react';

/** Carte « Nuit » : dégradé bleu nuit, bordure fine, angles de 18 px (accepte `ref`, React 19). */
export function Card({ className = '', ...rest }: ComponentProps<'div'>) {
  return <div className={`card-surface p-4 ${className}`} {...rest} />;
}
