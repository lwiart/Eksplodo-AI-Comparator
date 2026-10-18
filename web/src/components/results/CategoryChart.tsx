import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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

/**
 * Modèles ayant au moins une note de catégorie, du mieux noté au moins bien noté en qualité globale
 * (sans qualité : en fin de liste) ; à égalité, l'ordre reçu est conservé.
 * Chaque modèle est une série : le même ordre vaut dans chaque groupe de barres et dans la légende.
 */
export function categorySeries(models: RankingModel[], categories: string[]): RankingModel[] {
  const quality = (m: RankingModel) => m.quality ?? Number.NEGATIVE_INFINITY;
  return models.filter((m) => categories.some((c) => m.byCategory[c] != null)).sort((a, b) => quality(b) - quality(a));
}

/** Barres groupées : qualité moyenne (sur 100) de chaque modèle dans chaque catégorie de test. */
export function CategoryChart({ models, categories }: { models: RankingModel[]; categories: string[] }) {
  const scored = categorySeries(models, categories);
  if (categories.length === 0 || scored.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de note par catégorie.</p>;
  const names = new Map(scored.map((m) => [m.modelId, m.name]));
  const nameOf = (key: unknown) => names.get(String(key)) ?? String(key);
  return (
    <div>
      <div role="img" aria-label="Qualité par catégorie de test" data-testid="category-chart" className="h-[250px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={categoryRows(scored, categories)} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="category" tick={AXIS_TICK} stroke={GRID_STROKE} />
            <YAxis domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} tick={AXIS_TICK} stroke={GRID_STROKE} width={36} />
            {/* Infobulle non partagée : seule la barre survolée (un modèle) est détaillée. */}
            <Tooltip
              shared={false}
              isAnimationActive={false}
              cursor={{ fill: 'rgba(63,162,224,0.08)' }}
              {...TOOLTIP_STYLE}
              formatter={(v, key) => [score(typeof v === 'number' ? v : null), nameOf(key)]}
            />
            {scored.map((m) => (
              <Bar key={m.modelId} dataKey={m.modelId} fill={m.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Légende dessinée ici, dans l'ordre des barres (du mieux au moins bien noté) : celle de recharts réordonne les séries. */}
      <ul aria-label="Légende : modèles du mieux au moins bien noté" className="m-0 mt-2 flex list-none flex-wrap justify-center gap-x-4 gap-y-1.5 p-0">
        {scored.map((m) => (
          <li key={m.modelId} className="flex items-center gap-1.5 text-xs text-ink">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: m.color }} />
            {m.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
