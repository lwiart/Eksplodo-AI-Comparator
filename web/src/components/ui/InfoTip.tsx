import { useId, type ReactNode } from 'react';

type Props = {
  /** Sujet de l'aide, lu par les lecteurs d'écran (« Aide : Qualité »). */
  label: string;
  children: ReactNode;
  /** Côté d'ouverture de la bulle. */
  align?: 'left' | 'right';
  /** Largeur de la bulle (classe Tailwind), à réduire dans un conteneur étroit qui coupe ce qui déborde. */
  width?: string;
};

/**
 * Petite icône « ? » : la définition s'affiche au survol ou au focus clavier (Échap ou départ du focus la referment),
 * et reste lisible par les lecteurs d'écran grâce à `aria-describedby`. Masquée à l'impression.
 */
export function InfoTip({ label, children, align = 'left', width = 'w-64' }: Props) {
  const id = useId();
  return (
    <span className="no-print group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`Aide : ${label}`}
        aria-describedby={id}
        className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-line-strong bg-night-0/60 p-0 font-mono text-[10px] leading-none font-bold text-mute hover:border-peach hover:text-white focus-visible:border-peach focus-visible:text-white focus-visible:outline-none"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none invisible absolute top-full z-30 mt-2 ${width} rounded-xl border border-line-strong bg-night-1 px-3 py-2 text-left font-sans text-xs leading-relaxed font-normal normal-case tracking-normal text-ink opacity-0 shadow-2xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </span>
    </span>
  );
}
