import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { TOOLTIP_STYLE } from './chart-theme';

/** Position d'un point dans le cadre du graphe (pixels, origine en haut à gauche du cadre). */
export type At = { x: number; y: number };

/** Largeur approximative de la bulle : elle reste dans le cadre du graphe. */
const POPUP_HALF = 80;
/** Hauteur approximative de la bulle : un point plus haut que cela la reçoit en dessous, sinon elle serait coupée. */
const POPUP_HEIGHT = 80;

/** Bulle posée au-dessus d'un point (en dessous s'il est trop haut), gardée dans la largeur du cadre. */
export function ChartPopup({ at, frameWidth, testId, children }: { at: At; frameWidth: number; testId: string; children: ReactNode }) {
  const left = Math.min(Math.max(at.x, POPUP_HALF), Math.max(POPUP_HALF, frameWidth - POPUP_HALF));
  const below = at.y < POPUP_HEIGHT;
  return (
    <div
      data-testid={testId}
      data-placement={below ? 'below' : 'above'}
      style={{ ...TOOLTIP_STYLE.contentStyle, left, top: at.y, transform: below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 14px))' }}
      className="pointer-events-none absolute z-10 max-w-[260px] px-3 py-2 text-xs"
    >
      {children}
    </div>
  );
}

/** Centre de l'élément `selector` dans le cadre, ou `null` s'il n'est pas (encore) dessiné. */
export function centerIn(frame: HTMLElement | null, selector: string): At | null {
  const el = frame?.querySelector(selector);
  if (!frame || !el) return null;
  const f = frame.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - f.left, y: r.top + r.height / 2 - f.top };
}

/**
 * Position du point choisi, relue dans le DOM après chaque rendu où le choix change (le graphe le dessine où il veut :
 * pas de calcul d'échelle à refaire). `null` sans choix ou tant que le point n'est pas dessiné.
 */
export function useChosenPosition(frame: RefObject<HTMLElement | null>, selector: string | null): At | null {
  const [at, setAt] = useState<At | null>(null);
  useLayoutEffect(() => {
    setAt(selector ? centerIn(frame.current, selector) : null);
  }, [frame, selector]);
  return selector ? at : null;
}

/**
 * Calque du survol : il garde l'élément survolé dans son propre état, si bien que le survol ne redessine pas le graphe
 * (recharts remplacerait alors les points sous la souris, qui relanceraient le survol). `render` reçoit l'élément survolé.
 */
export function HoverLayer<T>({ hoverRef, render }: { hoverRef: { current: (v: T | null) => void }; render(v: T): ReactNode }) {
  const [hovered, setHovered] = useState<T | null>(null);
  useEffect(() => {
    hoverRef.current = setHovered;
    return () => {
      hoverRef.current = () => {};
    };
  }, [hoverRef]);
  return hovered === null ? null : <>{render(hovered)}</>;
}

/** Point qui pulse (anneau qui grandit et s'efface), sous le point choisi. */
export function Pulse({ cx, cy, color, r = 7 }: { cx: number; cy: number; color: string; r?: number }) {
  return (
    <circle cx={cx} cy={cy} r={r} fill={color}>
      <animate attributeName="r" values={`${r};${r * 2.8};${r}`} dur="1.4s" repeatCount="indefinite" />
      <animate attributeName="opacity" values="0.55;0;0.55" dur="1.4s" repeatCount="indefinite" />
    </circle>
  );
}
