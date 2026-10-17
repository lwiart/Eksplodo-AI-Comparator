import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Evolution } from '../../api/dashboard';
import { formatDate } from '../catalog/format';
import { AXIS_TICK, GRID_STROKE, TOOLTIP_STYLE } from '../results/chart-theme';
import { DASH, score } from '../results/format';
import { plottedSeries } from './evolution-series';

type Row = { name: string; date: string; judge: string } & Record<string, number | string | null>;

/** Une ligne par série (abscisse), une colonne par modèle tracé (clé `m<i>` : les identifiants ne servent pas de clé). */
export function evolutionRows(evolution: Evolution): Row[] {
  const series = plottedSeries(evolution.series);
  return evolution.runs.map((run, i) => ({
    name: run.name,
    date: formatDate(run.completedAt),
    judge: run.judgeName ?? 'aucun',
    ...Object.fromEntries(series.map((s, k) => [`m${k}`, s.points[i] ?? null])),
  }));
}

/** Courbes « Nuit » de la qualité par modèle ; chargé à la demande (Recharts). */
export default function EvolutionLines({ evolution }: { evolution: Evolution }) {
  const series = plottedSeries(evolution.series);
  const rows = evolutionRows(evolution);
  return (
    <div role="img" aria-label={`Évolution de la qualité sur la suite ${evolution.suite.name}`} data-testid="evolution-chart" className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval={0} tickFormatter={(_, i) => `#${i + 1}`} />
          <YAxis domain={[0, 10]} tickCount={6} tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={(_, payload) => {
              const row = payload?.[0]?.payload as Row | undefined;
              return row ? `${row.name} · ${row.date} · juge : ${row.judge}` : '';
            }}
            formatter={(v) => (typeof v === 'number' ? score(v) : DASH)}
          />
          {series.map((s, k) => (
            <Line key={s.modelId} type="monotone" dataKey={`m${k}`} name={s.name} stroke={s.color} strokeWidth={2} dot={{ r: 3, fill: s.color }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
