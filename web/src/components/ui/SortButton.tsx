import type { ReactNode } from 'react';

/**
 * Bouton d'en-tête de colonne triable : le libellé et une petite flèche (↑ croissant, ↓ décroissant, ↕ non trié).
 * `aria-sort` reste sur la cellule d'en-tête ; la flèche est décorative.
 */
export function SortButton({
  dir,
  onClick,
  children,
  align = 'left',
}: {
  dir: 'asc' | 'desc' | null;
  onClick(): void;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
}) {
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <button
      type="button"
      onClick={onClick}
      title={dir === null ? 'Trier' : dir === 'asc' ? 'Tri croissant : cliquer pour inverser' : 'Tri décroissant : cliquer pour inverser'}
      className={`inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-inherit ${justify} ${dir ? 'font-semibold text-white' : 'hover:text-white'}`}
    >
      {children}
      <span aria-hidden="true" className={`text-[11px] ${dir ? 'text-peach' : 'opacity-50'}`}>
        {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕'}
      </span>
    </button>
  );
}
