import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from 'recharts';
import type { RankingModel } from '../../api/results';
import { InfoTip } from '../ui/InfoTip';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from './chart-theme';
import { DEFINITIONS } from './definitions';
import { score } from './format';

/** Seuil, sur 100, à partir duquel une note qualité ou vitesse entre dans la zone idéale. */
const IDEAL_FROM = 75;

export type ScatterPoint = { modelId: string; name: string; color: string; speed: number; quality: number };

/** Un point par modèle ayant une note de qualité et une note de vitesse. */
export function scatterPoints(models: RankingModel[]): ScatterPoint[] {
  return models.flatMap((m) => (m.quality === null || m.speed === null ? [] : [{ modelId: m.modelId, name: m.name, color: m.color, speed: m.speed, quality: m.quality }]));
}

/** Point montré : le modèle et sa position dans le graphe (pixels). */
type Shown = { point: ScatterPoint; cx: number; cy: number };

/** Largeur approximative de la bulle : elle reste dans le cadre du graphe. */
const POPUP_HALF = 80;
/** Hauteur approximative de la bulle : un point plus haut que cela la reçoit en dessous, sinon elle serait coupée. */
const POPUP_HEIGHT = 80;

/**
 * Calque de la bulle : il garde le point survolé dans son propre état, si bien que le survol ne redessine pas le graphe
 * (recharts remplacerait alors les points sous la souris, qui relanceraient le survol). Le point choisi l'emporte.
 */
function PopupLayer({ pinned, hoverRef, frame }: { pinned: Shown | null; hoverRef: { current: (s: Shown | null) => void }; frame: { current: HTMLDivElement | null } }) {
  const [hovered, setHovered] = useState<Shown | null>(null);
  useEffect(() => {
    hoverRef.current = setHovered;
    return () => {
      hoverRef.current = () => {};
    };
  }, [hoverRef]);
  const shown = pinned ?? hovered;
  return shown ? <PointPopup shown={shown} width={frame.current?.clientWidth ?? 0} /> : null;
}

/** Bulle d'un point : nom du modèle, couleur, qualité et vitesse, posée au-dessus du point. */
function PointPopup({ shown, width }: { shown: Shown; width: number }) {
  const { point: p, cx, cy } = shown;
  const left = Math.min(Math.max(cx, POPUP_HALF), Math.max(POPUP_HALF, width - POPUP_HALF));
  const below = cy < POPUP_HEIGHT;
  return (
    <div
      data-testid="quality-speed-popup"
      data-placement={below ? 'below' : 'above'}
      style={{ ...TOOLTIP_STYLE.contentStyle, left, top: cy, transform: below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 14px))' }}
      className="pointer-events-none absolute z-10 px-3 py-2 whitespace-nowrap"
    >
      <div className="flex items-center gap-2 font-semibold text-white">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
        {p.name}
      </div>
      <div className="font-mono text-xs">Qualité {score(p.quality)}</div>
      <div className="font-mono text-xs">Vitesse {score(p.speed)}</div>
    </div>
  );
}

/**
 * Titre du bloc, commun à la page de résultats et à la page publique : la zone idéale est expliquée dans le sous-titre
 * (un libellé dans le graphe masquait des points), les définitions de la qualité et de la vitesse dans l'aide « ? ».
 */
export function QualitySpeedHeading() {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="m-0 font-display text-sm font-bold text-white">
        Qualité et vitesse <span className="ml-1 font-mono text-[11px] font-medium text-mute">zone orangée en haut à droite : idéal</span>
      </h2>
      <InfoTip label="Qualité et vitesse" width="w-80">
        <span className="block">
          <strong className="text-white">Qualité.</strong> {DEFINITIONS.quality}
        </span>
        <span className="mt-1.5 block">
          <strong className="text-white">Vitesse.</strong> {DEFINITIONS.speed}
        </span>
      </InfoTip>
    </div>
  );
}

/**
 * Nuage qualité × vitesse (notes sur 100) de tous les modèles ; en haut à droite, la zone idéale (zone orangée, sans
 * libellé pour ne masquer aucun point). La légende, dessinée en HTML sous le graphe, peut passer sur plusieurs lignes.
 */
export function QualitySpeedChart({ models }: { models: RankingModel[] }) {
  const points = useMemo(() => scatterPoints(models), [models]);
  const frame = useRef<HTMLDivElement>(null);
  // Point touché (ou cliqué) : il pulse et sa bulle reste affichée ; point survolé à la souris : bulle seule (calque).
  const [pinned, setPinned] = useState<Shown | null>(null);
  const hoverRef = useRef<(s: Shown | null) => void>(() => {});
  const pinnedId = pinned?.point.modelId ?? null;
  // Données des points, stables tant que le choix ne change pas : le survol ne redessine pas les points (sinon le point
  // serait remplacé entre le survol et le clic), et l'état « choisi » y figure (recharts ne redessine que sur données).
  const series = useMemo(() => points.map((p) => [{ ...p, pinned: p.modelId === pinnedId }]), [points, pinnedId]);
  // Fonction de dessin stable : une nouvelle fonction à chaque rendu ferait redessiner (remplacer) tous les points.
  const renderPoint = useCallback((props: unknown) => {
    const { cx = 0, cy = 0, payload } = props as { cx?: number; cy?: number; payload: ScatterPoint & { pinned: boolean } };
    const isPinned = payload.pinned;
    const { pinned: _flag, ...point } = payload;
    const here = { point, cx, cy };
    return (
      <g
        data-testid="quality-speed-point"
        data-pinned={isPinned || undefined}
        aria-label={payload.name}
        style={{ cursor: 'pointer' }}
        onClick={(e) => {
          e.stopPropagation();
          setPinned(isPinned ? null : here);
        }}
        onMouseEnter={() => hoverRef.current(here)}
        onMouseLeave={() => hoverRef.current(null)}
      >
        {isPinned ? (
          <circle cx={cx} cy={cy} r={7} fill={payload.color}>
            <animate attributeName="r" values="7;20;7" dur="1.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.55;0;0.55" dur="1.4s" repeatCount="indefinite" />
          </circle>
        ) : null}
        {/* Zone de toucher plus large que le point, invisible. */}
        <circle cx={cx} cy={cy} r={14} fill="transparent" />
        <circle cx={cx} cy={cy} r={isPinned ? 8 : 6} fill={payload.color} stroke={isPinned ? '#fff' : 'none'} strokeWidth={2} />
      </g>
    );
  }, []);
  if (points.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de modèle avec une qualité et une vitesse.</p>;

  return (
    <div data-testid="quality-speed-chart" className="w-full">
      {/* Pas de contour de focus du navigateur sur le graphe (le rectangle blanc au toucher) ; un toucher hors d'un point referme la bulle. */}
      <div
        ref={frame}
        role="img"
        aria-label="Nuage qualité et vitesse des modèles"
        className="relative h-[280px] w-full [&_*:focus]:outline-none [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none"
        onClick={() => setPinned(null)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart accessibilityLayer={false} margin={{ top: 12, right: 24, bottom: 24, left: 4 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <ReferenceArea
              x1={IDEAL_FROM}
              x2={100}
              y1={IDEAL_FROM}
              y2={100}
              fill="#F0631F"
              fillOpacity={0.08}
              stroke="#F0631F"
              strokeOpacity={0.3}
            />
            <XAxis
              type="number"
              dataKey="speed"
              name="Vitesse"
              domain={[0, 100]}
              ticks={[0, 20, 40, 60, 80, 100]}
              tick={AXIS_TICK}
              stroke={GRID_STROKE}
              label={{ value: 'Vitesse (note sur 100)', position: 'insideBottom', offset: -12, fill: '#7FA3B5', fontSize: 11 }}
            />
            {/* Axe élargi : le titre vertical se place à gauche des graduations sans les chevaucher. */}
            <YAxis
              type="number"
              dataKey="quality"
              name="Qualité"
              domain={[0, 100]}
              ticks={[0, 20, 40, 60, 80, 100]}
              tick={AXIS_TICK}
              stroke={GRID_STROKE}
              width={58}
              label={{ value: 'Qualité (note sur 100)', angle: -90, position: 'insideLeft', offset: 10, fill: '#7FA3B5', fontSize: 11, style: { textAnchor: 'middle' } }}
            />
            <ZAxis range={[110, 110]} />
            {points.map((p, i) => (
              <Scatter key={p.modelId} name={p.name} data={series[i]} fill={p.color} isAnimationActive={false} shape={renderPoint} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
        <PopupLayer pinned={pinned} hoverRef={hoverRef} frame={frame} />
      </div>
      {/* Légende sous le graphe, hors du SVG : elle ne chevauche ni le titre de l'axe des vitesses ni les points. */}
      <ul aria-label="Légende du nuage" className="m-0 mt-2 flex list-none flex-wrap justify-center gap-x-4 gap-y-1.5 p-0">
        {points.map((p) => (
          <li key={p.modelId} className="flex items-center gap-1.5 text-xs text-ink">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
            {p.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
