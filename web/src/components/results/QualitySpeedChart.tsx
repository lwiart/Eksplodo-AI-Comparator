import { useCallback, useMemo, useRef, useState } from 'react';
import { CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from 'recharts';
import type { RankingModel } from '../../api/results';
import { InfoTip } from '../ui/InfoTip';
import { ChartPopup, HoverLayer, Pulse, useChosenPosition, type At } from './chart-popup';
import { AXIS_TICK, GRID_STROKE } from './chart-theme';
import { DEFINITIONS } from './definitions';
import { score } from './format';

/** Seuil, sur 100, à partir duquel une note qualité ou vitesse entre dans la zone idéale. */
const IDEAL_FROM = 75;

export type ScatterPoint = { modelId: string; name: string; color: string; speed: number; quality: number };

/** Un point par modèle ayant une note de qualité et une note de vitesse. */
export function scatterPoints(models: RankingModel[]): ScatterPoint[] {
  return models.flatMap((m) => (m.quality === null || m.speed === null ? [] : [{ modelId: m.modelId, name: m.name, color: m.color, speed: m.speed, quality: m.quality }]));
}

/** Contenu de la bulle d'un point : nom du modèle, couleur, qualité et vitesse. */
function PointDetails({ p }: { p: ScatterPoint }) {
  return (
    <>
      <div className="flex items-center gap-2 font-semibold whitespace-nowrap text-white">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
        {p.name}
      </div>
      <div className="font-mono">Qualité {score(p.quality)}</div>
      <div className="font-mono">Vitesse {score(p.speed)}</div>
    </>
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
 * libellé pour ne masquer aucun point). Toucher un point, ou son nom dans la légende sous le graphe, le choisit : il
 * pulse et sa bulle reste affichée ; à la souris, la bulle apparaît aussi au survol.
 */
export function QualitySpeedChart({ models }: { models: RankingModel[] }) {
  const points = useMemo(() => scatterPoints(models), [models]);
  const frame = useRef<HTMLDivElement>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const hoverRef = useRef<(v: { point: ScatterPoint; at: At } | null) => void>(() => {});
  const chosen = points.find((p) => p.modelId === chosenId) ?? null;
  // Position du point choisi, relue dans le DOM : le choix peut venir de la légende, sans coordonnées.
  const chosenAt = useChosenPosition(frame, chosen ? `[data-model="${CSS.escape(chosen.modelId)}"] [data-dot]` : null);
  // Données stables tant que le choix ne change pas : le survol ne redessine pas les points (recharts ne redessine que sur
  // changement de données, et l'état « choisi » y figure).
  const series = useMemo(() => points.map((p) => [{ ...p, chosen: p.modelId === chosenId }]), [points, chosenId]);
  const toggle = useCallback((id: string) => setChosenId((c) => (c === id ? null : id)), []);

  // Fonction de dessin stable : une nouvelle fonction à chaque rendu ferait redessiner (remplacer) tous les points.
  const renderPoint = useCallback(
    (props: unknown) => {
      const { cx = 0, cy = 0, payload } = props as { cx?: number; cy?: number; payload: ScatterPoint & { chosen: boolean } };
      const { chosen: isChosen, ...point } = payload;
      return (
        <g
          data-testid="quality-speed-point"
          data-model={point.modelId}
          data-pinned={isChosen || undefined}
          aria-label={point.name}
          style={{ cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation();
            toggle(point.modelId);
          }}
          onMouseEnter={() => hoverRef.current({ point, at: { x: cx, y: cy } })}
          onMouseLeave={() => hoverRef.current(null)}
        >
          {isChosen ? <Pulse cx={cx} cy={cy} color={point.color} /> : null}
          {/* Zone de toucher plus large que le point, invisible. */}
          <circle cx={cx} cy={cy} r={14} fill="transparent" />
          <circle data-dot cx={cx} cy={cy} r={isChosen ? 8 : 6} fill={point.color} stroke={isChosen ? '#fff' : 'none'} strokeWidth={2} />
        </g>
      );
    },
    [toggle],
  );
  if (points.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de modèle avec une qualité et une vitesse.</p>;
  const frameWidth = frame.current?.clientWidth ?? 0;

  return (
    <div data-testid="quality-speed-chart" className="w-full">
      {/* Pas de contour de focus du navigateur sur le graphe (le rectangle blanc au toucher) ; un toucher hors d'un point referme la bulle. */}
      <div
        ref={frame}
        role="img"
        aria-label="Nuage qualité et vitesse des modèles"
        className="relative h-[280px] w-full [&_*:focus]:outline-none [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none"
        onClick={() => setChosenId(null)}
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
        {chosen && chosenAt ? (
          <ChartPopup at={chosenAt} frameWidth={frameWidth} testId="quality-speed-popup">
            <PointDetails p={chosen} />
          </ChartPopup>
        ) : (
          <HoverLayer
            hoverRef={hoverRef}
            render={(h) => (
              <ChartPopup at={h.at} frameWidth={frame.current?.clientWidth ?? 0} testId="quality-speed-popup">
                <PointDetails p={h.point} />
              </ChartPopup>
            )}
          />
        )}
      </div>
      {/* Légende sous le graphe, hors du SVG : chaque nom choisit son point (pulsation et bulle). */}
      <ul aria-label="Légende du nuage" className="m-0 mt-2 flex list-none flex-wrap justify-center gap-x-1 gap-y-1 p-0">
        {points.map((p) => {
          const active = p.modelId === chosenId;
          return (
            <li key={p.modelId}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => toggle(p.modelId)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                  active ? 'border-peach bg-night-2 text-white' : 'border-transparent bg-transparent text-ink hover:text-white'
                }`}
              >
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                {p.name}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
