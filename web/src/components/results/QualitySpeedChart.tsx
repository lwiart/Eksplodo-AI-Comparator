import { CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { RankingModel } from '../../api/results';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from './chart-theme';
import { score } from './format';

/** Seuil, sur 10, à partir duquel une note qualité ou vitesse entre dans la zone idéale. */
const IDEAL_FROM = 7.5;

export type ScatterPoint = { modelId: string; name: string; color: string; speed: number; quality: number };

/** Un point par modèle ayant une note de qualité et une note de vitesse. */
export function scatterPoints(models: RankingModel[]): ScatterPoint[] {
  return models.flatMap((m) => (m.quality === null || m.speed === null ? [] : [{ modelId: m.modelId, name: m.name, color: m.color, speed: m.speed, quality: m.quality }]));
}

/** Nuage qualité × vitesse (notes sur 10) ; en haut à droite, la zone idéale. */
export function QualitySpeedChart({ models }: { models: RankingModel[] }) {
  const points = scatterPoints(models);
  if (points.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de modèle avec une qualité et une vitesse.</p>;
  return (
    <div role="img" aria-label="Nuage qualité et vitesse des modèles" data-testid="quality-speed-chart" className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <ReferenceArea
            x1={IDEAL_FROM}
            x2={10}
            y1={IDEAL_FROM}
            y2={10}
            fill="#F0631F"
            fillOpacity={0.08}
            stroke="#F0631F"
            strokeOpacity={0.3}
            label={{ value: 'Zone idéale', position: 'insideTopLeft', fill: '#FFB48A', fontSize: 10 }}
          />
          <XAxis
            type="number"
            dataKey="speed"
            name="Vitesse"
            domain={[0, 10]}
            ticks={[0, 2, 4, 6, 8, 10]}
            tick={AXIS_TICK}
            stroke={GRID_STROKE}
            label={{ value: 'Vitesse (note sur 10)', position: 'insideBottom', offset: -12, fill: '#7FA3B5', fontSize: 11 }}
          />
          <YAxis type="number" dataKey="quality" name="Qualité" domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={AXIS_TICK} stroke={GRID_STROKE} width={36} />
          <ZAxis range={[110, 110]} />
          <Tooltip cursor={{ stroke: GRID_STROKE }} {...TOOLTIP_STYLE} formatter={(v) => score(typeof v === 'number' ? v : null)} />
          {points.map((p) => (
            <Scatter key={p.modelId} name={p.name} data={[p]} fill={p.color} isAnimationActive={false} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
