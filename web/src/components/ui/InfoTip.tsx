import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  /** Sujet de l'aide, lu par les lecteurs d'écran (« Aide : Qualité »). */
  label: string;
  children: ReactNode;
  /** Côté d'ouverture de la bulle : alignée sur le bord gauche (`left`) ou droit (`right`) de l'icône. */
  align?: 'left' | 'right';
  /** Largeur de la bulle (classe Tailwind). */
  width?: string;
};

const GAP = 8;
const MARGIN = 8;

/**
 * Bulle partagée par `InfoTip` et `HoverTip` : ouverte au survol de l'enveloppe ou au focus du déclencheur (Échap,
 * départ du pointeur ou du focus, défilement la referment). Elle est rendue dans `document.body`, en position fixe :
 * aucune carte, zone défilante ou couche (flou d'arrière-plan) ne peut la couper ni passer par-dessus. Elle reste dans
 * le DOM, masquée, pour `aria-describedby`.
 */
function useTip(align: 'left' | 'right', width: string, children: ReactNode) {
  const id = useId();
  const trigger = useRef<HTMLElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const b = trigger.current?.getBoundingClientRect();
    if (!b) return;
    const w = bubble.current?.offsetWidth ?? 0;
    const h = bubble.current?.offsetHeight ?? 0;
    let left = align === 'right' ? b.right - w : b.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    // Sous le déclencheur ; au-dessus quand la place manque en bas de la fenêtre.
    const below = b.bottom + GAP;
    const top = below + h > window.innerHeight - MARGIN && b.top - GAP - h > MARGIN ? b.top - GAP - h : below;
    setPos({ top, left });
  }, [align]);

  // Position recalculée une fois la bulle rendue (sa taille est alors connue).
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const portal = createPortal(
    <span
      ref={bubble}
      id={id}
      role="tooltip"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
      className={`no-print pointer-events-none fixed z-[60] ${width} rounded-xl border border-line-strong bg-night-1 px-3 py-2 text-left font-sans text-xs leading-relaxed font-normal normal-case tracking-normal text-ink shadow-2xl ${
        open && pos ? 'visible opacity-100' : 'invisible opacity-0'
      }`}
    >
      {children}
    </span>,
    document.body,
  );
  const hover = { onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) };
  const focus = { onFocus: () => setOpen(true), onBlur: () => setOpen(false) };
  return { id, trigger, open, portal, hover, focus };
}

/** Petite icône « ? » : la définition s'affiche au survol ou au focus clavier. Icône et bulle sont masquées à l'impression. */
export function InfoTip({ label, children, align = 'left', width = 'w-64' }: Props) {
  const tip = useTip(align, width, children);
  return (
    <span className="no-print relative inline-flex align-middle" {...tip.hover}>
      <button
        ref={tip.trigger as RefObject<HTMLButtonElement>}
        type="button"
        aria-label={`Aide : ${label}`}
        aria-describedby={tip.id}
        aria-expanded={tip.open}
        {...tip.focus}
        className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-line-strong bg-night-0/60 p-0 font-mono text-[10px] leading-none font-bold text-mute hover:border-peach hover:text-white focus-visible:border-peach focus-visible:text-white focus-visible:outline-none"
      >
        ?
      </button>
      {tip.portal}
    </span>
  );
}

/**
 * Texte souligné en pointillé dont le détail (`tip`) s'affiche au survol ou au focus clavier, dans la même bulle
 * qu'`InfoTip`.
 */
export function HoverTip({ tip: content, children, align = 'left', width = 'w-56' }: { tip: ReactNode; children: ReactNode; align?: 'left' | 'right'; width?: string }) {
  const tip = useTip(align, width, content);
  return (
    <span
      ref={tip.trigger as RefObject<HTMLSpanElement>}
      tabIndex={0}
      aria-describedby={tip.id}
      {...tip.hover}
      {...tip.focus}
      className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:decoration-peach"
    >
      {children}
      {tip.portal}
    </span>
  );
}
