import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
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

/** Point d'une courbe, avec une zone de survol plus large que le point visible : elle désigne le modèle survolé. */
function HoverDot({ cx, cy, color, name, onEnter, onLeave }: { cx?: number | null; cy?: number | null; color: string; name: string; onEnter(): void; onLeave(): void }) {
  if (cx == null || cy == null || Number.isNaN(cx) || Number.isNaN(cy)) return null;
  return (
    <g data-evolution-dot={name} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ cursor: 'pointer' }}>
      <circle cx={cx} cy={cy} r={10} fill="transparent" />
      <circle cx={cx} cy={cy} r={3} fill={color} />
    </g>
  );
}

/** Courbes « Nuit » de la qualité par modèle ; chargé à la demande (Recharts). */
export default function EvolutionLines({ evolution }: { evolution: Evolution }) {
  const series = plottedSeries(evolution.series);
  const rows = evolutionRows(evolution);
  // Courbe dont un point est survolé : l'infobulle ne détaille que ce modèle (une infobulle de tous les modèles masquait le graphe).
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredSeries = series.find((_, k) => `m${k}` === hovered);
  return (
    <div>
      <div role="img" aria-label={`Évolution de la qualité sur la suite ${evolution.suite.name}`} data-testid="evolution-chart" className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval={0} tickFormatter={(_, i) => `#${i + 1}`} />
          <YAxis domain={[0, 100]} tickCount={6} tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <Tooltip
            isAnimationActive={false}
            cursor={false}
            content={(props: TooltipContentProps<ValueType, NameType>) => {
              const row = props.payload?.[0]?.payload as Row | undefined;
              if (!props.active || !row || !hovered || !hoveredSeries) return null;
              const value = row[hovered];
              return (
                <div data-testid="evolution-tooltip" style={TOOLTIP_STYLE.contentStyle} className="max-w-[280px] px-3 py-2 text-xs">
                  <div className="mb-1 font-semibold text-white">{`${row.name} · ${row.date} · juge : ${row.judge}`}</div>
                  <div className="flex items-center gap-1.5 text-ink">
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: hoveredSeries.color }} />
                    {`${hoveredSeries.name} : ${typeof value === 'number' ? score(value) : DASH}`}
                  </div>
                </div>
              );
            }}
          />
          {series.map((s, k) => {
            const key = `m${k}`;
            const dot = (props: { cx?: number | null; cy?: number | null; index?: number }) => (
              <HoverDot
                key={`${key}-${props.index}`}
                cx={props.cx}
                cy={props.cy}
                color={s.color}
                name={s.name}
                onEnter={() => setHovered(key)}
                onLeave={() => setHovered((h) => (h === key ? null : h))}
              />
            );
            return (
              <Line key={s.modelId} type="monotone" dataKey={key} name={s.name} stroke={s.color} strokeWidth={2} dot={dot} activeDot={dot} connectNulls isAnimationActive={false} />
            );
          })}
        </LineChart>
        </ResponsiveContainer>
      </div>
      <ul aria-label="Légende" className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-ink">
        {series.map((s) => (
          <li key={s.modelId} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            {s.name}
          </li>
        ))}
      </ul>
      {/* Alternative textuelle du graphe : les séries comparées dans l'ordre des abscisses (#1, #2…). */}
      <ol aria-label="Séries comparées" className="sr-only">
        {rows.map((row, i) => (
          <li key={i}>{`#${i + 1} : ${row.name}, ${row.date}, juge : ${row.judge}`}</li>
        ))}
      </ol>
    </div>
  );
}
