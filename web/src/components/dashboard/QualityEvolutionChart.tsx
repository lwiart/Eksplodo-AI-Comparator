import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { evolutionKey, getEvolution, type Dashboard } from '../../api/dashboard';
import { messageForError } from '../../api/messages';
import { Card } from '../ui/Card';
import { plottedSeries } from './evolution-series';

// Recharts n'est chargé qu'à l'affichage des courbes.
const EvolutionLines = lazy(() => import('./EvolutionLines'));

/** Évolution de la qualité par modèle sur les dernières séries terminées d'une suite (la première par défaut). */
export function QualityEvolutionChart({ suites }: { suites: Dashboard['evolutionSuites'] }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const suiteId = suites.find((s) => s.id === chosen)?.id ?? suites[0]?.id ?? null;
  const evolution = useQuery({
    queryKey: evolutionKey(suiteId ?? ''),
    queryFn: () => getEvolution(suiteId!),
    enabled: suiteId !== null,
  });
  const empty = suiteId === null || (evolution.isSuccess && (evolution.data.runs.length === 0 || plottedSeries(evolution.data.series).length === 0));

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="m-0 font-display text-lg font-bold text-white">
          Évolution de la qualité <small className="ml-1 text-xs font-normal text-mute">6 dernières séries terminées</small>
        </h2>
        {suites.length > 0 ? (
          <select
            aria-label="Suite affichée"
            value={suiteId ?? ''}
            onChange={(e) => setChosen(e.target.value)}
            className="rounded-full border border-line-strong bg-night-2/60 px-3 py-1.5 text-xs text-ink"
          >
            {suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="mt-3">
        {empty ? (
          <p className="m-0 py-8 text-center text-sm text-mute">Aucune série terminée pour cette suite</p>
        ) : evolution.isError ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {messageForError(evolution.error)}
          </p>
        ) : evolution.isPending ? (
          <p className="m-0 py-8 text-center text-sm text-mute">Chargement de l’évolution…</p>
        ) : (
          <Suspense fallback={<p className="m-0 py-8 text-center text-sm text-mute">Chargement du graphique…</p>}>
            <EvolutionLines evolution={evolution.data} />
          </Suspense>
        )}
      </div>
    </Card>
  );
}
