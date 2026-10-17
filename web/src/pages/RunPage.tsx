import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { messageForError } from '../api/messages';
import { RUNS_KEY, getRun, getRunProgress, getRunResults, type RunProgress, type RunStatus, type RunSummary } from '../api/runs';
import { useAuth } from '../auth/AuthProvider';
import { ActivityFeed } from '../components/runs/ActivityFeed';
import { LiveMatrix } from '../components/runs/LiveMatrix';
import { PauseNotice, RunControls } from '../components/runs/RunControls';
import { RunMetricsTable } from '../components/runs/RunMetricsTable';
import { RunStatusChip } from '../components/runs/RunStatusChip';
import { Card } from '../components/ui/Card';
import { RUN_STATUS_LABELS, duration, finishedCalls, plural, usd } from '../lib/format';
import { LiveFlowFallback } from '../three/LiveFlowFallback';
import { ThreeStage } from '../three/ThreeStage';
import { liveFlowScene, type LiveFlowData } from '../three/live-flow-scene';

/** Intervalle d'interrogation : aucune requête HTTP n'attend la fin d'un appel (limite de 60 s du proxy). */
const POLL_MS = 2000;
const ACTIVE: readonly RunStatus[] = ['queued', 'running', 'paused'];

/**
 * Interrogation seulement pendant la série. Onglet caché, react-query saute les échéances (`refetchIntervalInBackground`
 * est faux par défaut) sans arrêter le minuteur ; au retour, `refetchOnWindowFocus: 'always'` relance aussitôt une requête.
 */
export function pollInterval(status: RunStatus | undefined): number | false {
  return status !== undefined && ACTIVE.includes(status) ? POLL_MS : false;
}

function Facts({ run, progress }: { run: RunSummary; progress: RunProgress | undefined }) {
  const models = progress?.modelsCostUsd ?? run.modelsCostUsd;
  const judge = progress?.judgeCostUsd ?? run.judgeCostUsd;
  const items: [string, string][] = [
    ['Suite', run.suiteName ?? 'Tests à la carte'],
    ['Composition', `${plural(run.testCount, 'test', 'tests')}, ${plural(run.modelCount, 'modèle', 'modèles')} × ${plural(run.repetitions, 'répétition', 'répétitions')}`],
    ['Juge', run.judgeModelName ?? 'Aucun'],
    ['Coût', `${usd(models)} modèles + ${usd(judge)} juge`],
  ];
  return (
    <ul aria-label="Caractéristiques de la série" className="m-0 mb-5 flex list-none flex-wrap gap-x-8 gap-y-3 p-0">
      {items.map(([label, value]) => (
        <li key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-mute">{label}</span>
          <span className="text-sm text-white">{value}</span>
        </li>
      ))}
    </ul>
  );
}

function ProgressStrip({ progress }: { progress: RunProgress }) {
  const done = finishedCalls(progress.counts);
  const total = progress.counts.total;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const spent = progress.modelsCostUsd + progress.judgeCostUsd;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <div className="text-xs text-mute">Avancement</div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[26px] leading-none font-extrabold text-white">{pct} %</span>
            <span className="font-mono text-xs text-mute">
              {done} / {total} appels
            </span>
          </div>
        </div>
        <div>
          <div className="text-xs text-mute">Dépensé</div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-lg font-semibold text-peach">{usd(spent)}</span>
            <span className="font-mono text-xs text-mute">{progress.budgetUsd === null ? 'sans plafond' : `sur ${usd(progress.budgetUsd)}`}</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-mute">Temps restant estimé</div>
          <div className="font-mono text-lg font-semibold text-white">
            {progress.status === 'paused' ? 'En pause' : progress.status === 'interrupted' ? 'Interrompue' : progress.etaSeconds === null ? 'Après les premières réponses' : `≈ ${duration(progress.etaSeconds)}`}
          </div>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Avancement"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full border border-line bg-night-0/60"
      >
        <div className="h-full rounded-full bg-gradient-to-r from-orange to-peach transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
    </Card>
  );
}

function LiveView({ progress }: { progress: RunProgress }) {
  // Données de la scène mémorisées : la scène reçoit `setData` à chaque nouvelle identité.
  const { models, running, activity } = progress;
  const flow = useMemo<LiveFlowData>(
    () => ({
      models: models.map((m) => ({ id: m.id, color: m.color })),
      running: running.map((r) => ({ modelId: r.modelId })),
      finished: activity.map((a) => ({ resultId: a.resultId, modelId: a.modelId, ok: a.status === 'done' })),
    }),
    [models, running, activity],
  );
  return (
    <div className="flex flex-col gap-4">
      <ProgressStrip progress={progress} />
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card className="relative h-[300px] overflow-hidden p-0">
          <ThreeStage factory={liveFlowScene} fallback={<LiveFlowFallback data={flow} />} data={flow} />
          <span className="absolute top-3.5 left-4 rounded-full border border-orange/50 bg-orange/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-peach">
            {plural(running.length, 'appel en cours', 'appels en cours')}
          </span>
          <p className="absolute right-4 bottom-3 left-4 m-0 text-[11px] text-mute">
            Chaque traînée est un appel en cours. Éclair vert : réponse reçue ; rouge : erreur.
          </p>
        </Card>
        <ActivityFeed activity={activity} />
      </div>
      <LiveMatrix matrix={progress.matrix} models={models} />
    </div>
  );
}

function CompletedView({ runId }: { runId: string }) {
  const results = useQuery({ queryKey: [...RUNS_KEY, runId, 'results'], queryFn: () => getRunResults(runId) });
  if (results.isError)
    return (
      <p role="alert" className="text-sm text-bad">
        {messageForError(results.error)}
      </p>
    );
  if (results.isPending) return <p className="text-sm text-mute">Chargement des résultats…</p>;
  return <RunMetricsTable rows={results.data} />;
}

/** Page d'une série : en-tête, suivi en direct (interrogé toutes les 2 s) puis mesures par modèle une fois terminée. */
export function RunPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const run = useQuery({ queryKey: [...RUNS_KEY, id], queryFn: () => getRun(id) });
  const progress = useQuery({
    queryKey: [...RUNS_KEY, id, 'progress'],
    queryFn: () => getRunProgress(id),
    refetchInterval: (query) => pollInterval(query.state.data?.status),
    // Désactivé globalement (main.tsx) : ici, le retour sur l'onglet doit rafraîchir l'avancement.
    refetchOnWindowFocus: 'always',
  });

  const status = progress.data?.status ?? run.data?.status;
  const live = status === 'queued' || status === 'running';
  const error = run.error ?? progress.error;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-1 font-mono text-xs text-mute">
        <Link to="/series" className="text-mute no-underline hover:text-white">
          Séries
        </Link>
        {status ? ` / ${RUN_STATUS_LABELS[status]}` : ''}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(error)}
        </p>
      ) : !run.data ? (
        <p className="text-sm text-mute">Chargement de la série…</p>
      ) : (
        <>
          <header className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">{run.data.name}</h1>
            {status ? <RunStatusChip status={status} /> : null}
          </header>
          {live ? (
            <p className="mt-0 mb-4 max-w-prose text-sm text-mute">
              Les résultats arrivent au fil de l’eau. Vous pouvez fermer la page : la série continue sur le serveur.
            </p>
          ) : null}
          <Facts run={run.data} progress={progress.data} />

          {progress.data ? (
            <div className="flex flex-col gap-4">
              <PauseNotice progress={progress.data} isAdmin={isAdmin} />
              {isAdmin ? <RunControls runId={id} progress={progress.data} /> : null}
              {progress.data.status === 'completed' ? <CompletedView runId={id} /> : <LiveView progress={progress.data} />}
            </div>
          ) : (
            <p className="text-sm text-mute">Chargement de l’avancement…</p>
          )}
        </>
      )}
    </div>
  );
}
