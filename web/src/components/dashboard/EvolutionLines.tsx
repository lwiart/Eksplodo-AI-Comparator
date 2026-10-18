import { useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Evolution } from '../../api/dashboard';
import { formatDate } from '../catalog/format';
import { ChartPopup, HoverLayer, Pulse, useChosenPosition, type At } from '../results/chart-popup';
import { AXIS_TICK, GRID_STROKE } from '../results/chart-theme';
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

/** Point désigné : la courbe (`m<i>`) et la série (abscisse). */
type PointRef = { key: string; index: number };

/**
 * Point d'une courbe, avec une zone de toucher plus large que le point visible ; le point choisi pulse et grossit.
 * `data-series` et `data-index` permettent de relire sa position pour y poser la bulle.
 */
function Dot({
  cx,
  cy,
  color,
  name,
  seriesKey,
  index,
  chosen,
  onChoose,
  onEnter,
  onLeave,
}: {
  cx?: number | null;
  cy?: number | null;
  color: string;
  name: string;
  seriesKey: string;
  index: number;
  chosen: boolean;
  onChoose(): void;
  onEnter(at: At): void;
  onLeave(): void;
}) {
  if (cx == null || cy == null || Number.isNaN(cx) || Number.isNaN(cy)) return null;
  return (
    <g
      data-evolution-dot={name}
      data-series={seriesKey}
      data-index={index}
      data-pinned={chosen || undefined}
      onClick={(e) => {
        e.stopPropagation();
        onChoose();
      }}
      onMouseEnter={() => onEnter({ x: cx, y: cy })}
      onMouseLeave={onLeave}
      style={{ cursor: 'pointer' }}
    >
      {chosen ? <Pulse cx={cx} cy={cy} color={color} r={5} /> : null}
      <circle cx={cx} cy={cy} r={12} fill="transparent" />
      <circle data-dot cx={cx} cy={cy} r={chosen ? 6 : 3} fill={color} stroke={chosen ? '#fff' : 'none'} strokeWidth={2} />
    </g>
  );
}

/** Contenu de la bulle : la série (nom, date, juge) et la note du modèle. */
function DotDetails({ row, name, color, value }: { row: Row; name: string; color: string; value: number | string | null }) {
  return (
    <>
      <div className="mb-1 font-semibold text-white">{`${row.name} · ${row.date} · juge : ${row.judge}`}</div>
      <div className="flex items-center gap-1.5 text-ink">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {`${name} : ${typeof value === 'number' ? score(value) : DASH}`}
      </div>
    </>
  );
}

/** Dernière série où la courbe a une note (point mis en avant quand on choisit le modèle dans la légende). */
function lastPointOf(rows: Row[], key: string): number | null {
  for (let i = rows.length - 1; i >= 0; i--) if (typeof rows[i]![key] === 'number') return i;
  return null;
}

/**
 * Courbes « Nuit » de la qualité par modèle ; chargé à la demande (Recharts). Toucher un point le choisit (il pulse, sa
 * bulle reste affichée) ; un nom de la légende choisit le dernier point du modèle et met sa courbe en avant. À la souris,
 * la bulle apparaît aussi au survol, pour ce seul modèle.
 */
export default function EvolutionLines({ evolution }: { evolution: Evolution }) {
  const series = plottedSeries(evolution.series);
  const baseRows = evolutionRows(evolution);
  const frame = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<PointRef | null>(null);
  const hoverRef = useRef<(v: (PointRef & { at: At }) | null) => void>(() => {});
  // Le choix figure dans les données : recharts ne redessine les points que si les données changent.
  const rows: Row[] = baseRows.map((r) => ({ ...r, chosen: chosen ? `${chosen.key}:${chosen.index}` : '' }));
  const chosenAt = useChosenPosition(frame, chosen ? `[data-series="${chosen.key}"][data-index="${chosen.index}"] [data-dot]` : null);
  const nameOf = (key: string) => series.find((_, k) => `m${k}` === key);
  const details = (ref: PointRef) => {
    const s = nameOf(ref.key);
    const row = rows[ref.index];
    return s && row ? <DotDetails row={row} name={s.name} color={s.color} value={row[ref.key] ?? null} /> : null;
  };
  const chooseSeries = (key: string) => {
    if (chosen?.key === key) return setChosen(null);
    const index = lastPointOf(rows, key);
    setChosen(index === null ? null : { key, index });
  };
  const frameWidth = frame.current?.clientWidth ?? 0;

  return (
    <div>
      {/* Pas de contour de focus au toucher ; un toucher hors d'un point referme la bulle. */}
      <div
        ref={frame}
        role="img"
        aria-label={`Évolution de la qualité sur la suite ${evolution.suite.name}`}
        data-testid="evolution-chart"
        className="relative h-[260px] w-full [&_*:focus]:outline-none [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none"
        onClick={() => setChosen(null)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval={0} tickFormatter={(_, i) => `#${i + 1}`} />
            <YAxis domain={[0, 100]} tickCount={6} tick={AXIS_TICK} tickLine={false} axisLine={false} />
            {series.map((s, k) => {
              const key = `m${k}`;
              const dimmed = chosen !== null && chosen.key !== key;
              const dot = (props: { cx?: number | null; cy?: number | null; index?: number }) => {
                const index = props.index ?? 0;
                return (
                  <Dot
                    key={`${key}-${index}`}
                    cx={props.cx}
                    cy={props.cy}
                    color={s.color}
                    name={s.name}
                    seriesKey={key}
                    index={index}
                    chosen={chosen?.key === key && chosen.index === index}
                    onChoose={() => setChosen((c) => (c?.key === key && c.index === index ? null : { key, index }))}
                    onEnter={(at) => hoverRef.current({ key, index, at })}
                    onLeave={() => hoverRef.current(null)}
                  />
                );
              };
              return (
                <Line
                  key={s.modelId}
                  type="monotone"
                  dataKey={key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={chosen?.key === key ? 3 : 2}
                  strokeOpacity={dimmed ? 0.25 : 1}
                  dot={dot}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
        {chosen && chosenAt ? (
          <ChartPopup at={chosenAt} frameWidth={frameWidth} testId="evolution-tooltip">
            {details(chosen)}
          </ChartPopup>
        ) : (
          <HoverLayer
            hoverRef={hoverRef}
            render={(h) => (
              <ChartPopup at={h.at} frameWidth={frame.current?.clientWidth ?? 0} testId="evolution-tooltip">
                {details(h)}
              </ChartPopup>
            )}
          />
        )}
      </div>
      {/* Légende : chaque nom met sa courbe en avant et ouvre la bulle de son dernier point. */}
      <ul aria-label="Légende" className="m-0 mt-2 flex list-none flex-wrap gap-x-1 gap-y-1 p-0 text-xs text-ink">
        {series.map((s, k) => {
          const key = `m${k}`;
          const active = chosen?.key === key;
          return (
            <li key={s.modelId}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => chooseSeries(key)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                  active ? 'border-peach bg-night-2 text-white' : 'border-transparent bg-transparent text-ink hover:text-white'
                }`}
              >
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                {s.name}
              </button>
            </li>
          );
        })}
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
