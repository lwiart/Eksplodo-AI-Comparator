import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RankingModel } from '../../api/results';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from './chart-theme';
import { score } from './format';

/** Une ligne par catégorie, une clé par modèle (identifiant) ; absente quand le modèle n'a aucune note dans la catégorie. */
export function categoryRows(models: RankingModel[], categories: string[]): Record<string, string | number>[] {
  return categories.map((category) => {
    const row: Record<string, string | number> = { category };
    for (const m of models) {
      const q = m.byCategory[category];
      if (q !== null && q !== undefined) row[m.modelId] = q;
    }
    return row;
  });
}

/** Barres groupées : qualité moyenne (sur 10) de chaque modèle dans chaque catégorie de test. */
export function CategoryChart({ models, categories }: { models: RankingModel[]; categories: string[] }) {
  const scored = models.filter((m) => categories.some((c) => m.byCategory[c] != null));
  if (categories.length === 0 || scored.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de note par catégorie.</p>;
  const names = new Map(scored.map((m) => [m.modelId, m.name]));
  const nameOf = (key: unknown) => names.get(String(key)) ?? String(key);
  return (
    <div role="img" aria-label="Qualité par catégorie de test" data-testid="category-chart" className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={categoryRows(scored, categories)} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="category" tick={AXIS_TICK} stroke={GRID_STROKE} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={AXIS_TICK} stroke={GRID_STROKE} width={36} />
          <Tooltip cursor={{ fill: 'rgba(63,162,224,0.08)' }} {...TOOLTIP_STYLE} formatter={(v, key) => [score(typeof v === 'number' ? v : null), nameOf(key)]} />
          <Legend formatter={(key) => <span className="text-xs text-ink">{nameOf(key)}</span>} iconType="circle" />
          {scored.map((m) => (
            <Bar key={m.modelId} dataKey={m.modelId} fill={m.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
