import { CartesianGrid, ReferenceArea, ResponsiveContainer, Legend, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { RankingModel } from '../../api/results';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from './chart-theme';
import { score } from './format';

/** Seuil, sur 100, à partir duquel une note qualité ou vitesse entre dans la zone idéale. */
const IDEAL_FROM = 75;

export type ScatterPoint = { modelId: string; name: string; color: string; speed: number; quality: number };

/** Un point par modèle ayant une note de qualité et une note de vitesse. */
export function scatterPoints(models: RankingModel[]): ScatterPoint[] {
  return models.flatMap((m) => (m.quality === null || m.speed === null ? [] : [{ modelId: m.modelId, name: m.name, color: m.color, speed: m.speed, quality: m.quality }]));
}

/** Infobulle d'un point : nom du modèle, couleur, qualité et vitesse. */
function PointTooltip({ active, payload }: { active?: boolean; payload?: { payload?: ScatterPoint }[] }) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <div style={TOOLTIP_STYLE.contentStyle} className="px-3 py-2">
      <div className="flex items-center gap-2 font-semibold text-white">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
        {p.name}
      </div>
      <div className="font-mono text-xs">Qualité {score(p.quality)}</div>
      <div className="font-mono text-xs">Vitesse {score(p.speed)}</div>
    </div>
  );
}

/** Nuage qualité × vitesse (notes sur 100) ; en haut à droite, la zone idéale. */
export function QualitySpeedChart({ models }: { models: RankingModel[] }) {
  const points = scatterPoints(models);
  if (points.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de modèle avec une qualité et une vitesse.</p>;
  return (
    <div role="img" aria-label="Nuage qualité et vitesse des modèles" data-testid="quality-speed-chart" className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 4 }}>
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
            label={{ value: 'Zone idéale', position: 'insideTopLeft', fill: '#FFB48A', fontSize: 10 }}
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
          <Tooltip cursor={{ stroke: GRID_STROKE }} content={<PointTooltip />} />
          {/* Légende en haut : en bas, elle chevauchait le titre de l'axe des vitesses. */}
          <Legend
            verticalAlign="top"
            wrapperStyle={{ paddingBottom: 8 }}
            formatter={(name) => <span className="text-xs text-ink">{String(name)}</span>}
            iconType="circle"
          />
          {points.map((p) => (
            <Scatter key={p.modelId} name={p.name} data={[p]} fill={p.color} isAnimationActive={false} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
