import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { ModelStats } from '../../api/catalog';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from '../results/chart-theme';
import { DASH, score } from '../results/format';

/** En dessous de trois catégories, un radar n'est plus lisible : on liste les valeurs. */
const MIN_AXES = 3;

/** Radar « Nuit » : qualité du modèle par catégorie de test contre la moyenne des modèles. Chargé à la demande (Recharts). */
export default function ModelRadar({ radar, color, modelName }: { radar: ModelStats['radar']; color: string; modelName: string }) {
  if (radar.length < MIN_AXES) {
    return (
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-mute">
            <th className="py-1 font-medium">Catégorie</th>
            <th className="py-1 text-right font-medium">{modelName}</th>
            <th className="py-1 text-right font-medium">Moyenne</th>
          </tr>
        </thead>
        <tbody>
          {radar.map((r) => (
            <tr key={r.category} className="border-t border-line">
              <td className="py-1.5 text-ink">{r.category}</td>
              <td className="py-1.5 text-right font-mono text-white">{score(r.model)}</td>
              <td className="py-1.5 text-right font-mono text-mute">{score(r.average)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div role="img" aria-label={`Qualité par catégorie : ${modelName} contre la moyenne des modèles`} data-testid="model-radar" className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={radar} outerRadius="72%">
          <PolarGrid stroke={GRID_STROKE} />
          <PolarAngleAxis dataKey="category" tick={{ ...AXIS_TICK, fill: '#D8ECF5' }} />
          <PolarRadiusAxis domain={[0, 100]} tickCount={6} tick={AXIS_TICK} stroke={GRID_STROKE} angle={90} />
          <Radar name="Moyenne des modèles" dataKey="average" stroke="#7CC4EF" strokeDasharray="4 3" fill="#7CC4EF" fillOpacity={0.08} isAnimationActive={false} />
          <Radar name={modelName} dataKey="model" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.28} isAnimationActive={false} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v) => (typeof v === 'number' ? score(v) : DASH)} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
