import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MODELS_KEY, listModels } from '../api/catalog';
import { messageForError } from '../api/messages';
import { answersPrefix, getRanking, rankingKey } from '../api/results';
import { RUNS_KEY, getRun, getRunProgress, getRunResults, renameRun, type RunProgress, type RunStatus, type RunSummary } from '../api/runs';
import { useAuth } from '../auth/AuthProvider';
import { ShareDialog } from '../components/sharing/ShareDialog';
import { ActivityFeed } from '../components/runs/ActivityFeed';
import type { HeatmapSelection } from '../components/results/CategoryHeatmap';
import { NO_FILTER, selectionOf, type AnswersFilter } from '../components/results/answers-filter';
import { SideBySide, type SideBySideTest } from '../components/results/SideBySide';
import { LiveMatrix } from '../components/runs/LiveMatrix';
import { PauseNotice, RunControls } from '../components/runs/RunControls';
import { RunMetricsTable } from '../components/runs/RunMetricsTable';
import { RunStatusChip } from '../components/runs/RunStatusChip';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { RUN_STATUS_LABELS, duration, finishedCalls, plural, usd } from '../lib/format';
import { LiveFlowFallback } from '../three/LiveFlowFallback';
import { ThreeStage } from '../three/ThreeStage';
import { liveFlowScene, type LiveFlowData } from '../three/live-flow-scene';

/** Intervalle d'interrogation : aucune requête HTTP n'attend la fin d'un appel (limite de 60 s du proxy). */
const POLL_MS = 2000;
const ACTIVE: readonly RunStatus[] = ['queued', 'running', 'paused'];
/** Le classement (agrégation en base) est rafraîchi moins souvent que l'avancement pendant la série. */
const RANKING_POLL_MS = 10_000;

/** Vue résultats chargée à la demande : Recharts reste hors du fragment principal. */
const ResultsView = lazy(() => import('../components/results/ResultsView'));

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
  // Plus aucun appel de modèle à faire : la série attend encore les notes du juge (ou se termine).
  const callsLeft = progress.counts.pending + progress.counts.running;
  const remaining =
    progress.status === 'paused'
      ? 'En pause'
      : progress.status === 'interrupted'
        ? 'Interrompue'
        : callsLeft === 0 && progress.judgePending > 0
          ? `Notation du juge : ${progress.judgePending} en attente`
          : callsLeft === 0
            ? 'Finalisation…'
            : progress.etaSeconds === null
              ? 'Après les premières réponses'
              : `≈ ${duration(progress.etaSeconds)}`;
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
            {remaining}
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

/** Podium, pondération, graphes et classement ; la qualité peut être masquée (nulle) pour un Utilisateur qui n'a pas noté. */
function ResultsSection({
  runId,
  isAdmin,
  show,
  active,
  tests,
  judgePending,
}: {
  runId: string;
  isAdmin: boolean;
  show: boolean;
  active: boolean;
  tests: SideBySideTest[];
  judgePending: number;
}) {
  // Classement et réponses côte à côte interrogés ensemble tant que la série est active ou que des notes du juge sont
  // attendues ; une dernière relecture quand la série passe à un état final ou que ces notes sont toutes rendues (sinon
  // les dernières notes manqueraient jusqu'au rechargement).
  const pollMs = active || judgePending > 0 ? RANKING_POLL_MS : false;
  const queryClient = useQueryClient();
  const previous = useRef({ active, judgePending });
  useEffect(() => {
    const before = previous.current;
    previous.current = { active, judgePending };
    if ((before.active && !active) || (before.judgePending > 0 && judgePending === 0)) {
      void queryClient.invalidateQueries({ queryKey: rankingKey(runId) });
      void queryClient.invalidateQueries({ queryKey: answersPrefix(runId) });
    }
  }, [active, judgePending, queryClient, runId]);
  const ranking = useQuery({
    queryKey: rankingKey(runId),
    queryFn: () => getRanking(runId),
    refetchInterval: pollMs,
    refetchOnWindowFocus: 'always',
  });
  // Filtre des réponses, partagé entre la matrice (clic sur une note) et les listes au-dessus des réponses.
  const [filter, setFilter] = useState<AnswersFilter>(NO_FILTER);
  const [focusKey, setFocusKey] = useState(0);
  const selection = selectionOf(filter);
  const select = (next: HeatmapSelection | null) => {
    setFilter(next ?? NO_FILTER);
    if (next) setFocusKey((k) => k + 1);
  };
  const hasQuality = ranking.data?.models.some((m) => m.quality !== null) ?? false;
  if (!show && !hasQuality && judgePending === 0) return null;
  if (ranking.isError)
    return (
      <p role="alert" className="text-sm text-bad">
        {messageForError(ranking.error)}
      </p>
    );
  if (!ranking.data) return <p className="text-sm text-mute">Chargement du classement…</p>;
  return (
    <Suspense fallback={<p className="text-sm text-mute">Chargement du classement…</p>}>
      <div className="flex flex-col gap-4">
        <ResultsView runId={runId} ranking={ranking.data} isAdmin={isAdmin} selection={selection} onSelect={select} />
        <SideBySide
          runId={runId}
          tests={tests}
          isAdmin={isAdmin}
          judgePending={judgePending}
          pollMs={pollMs}
          filter={filter}
          onFilterChange={setFilter}
          models={ranking.data.models.map((m) => ({ modelId: m.modelId, name: m.name }))}
          focusKey={focusKey}
        />
      </div>
    </Suspense>
  );
}

function CompletedView({ runId }: { runId: string }) {
  const results = useQuery({ queryKey: [...RUNS_KEY, runId, 'results'], queryFn: () => getRunResults(runId) });
  // Tarifs du catalogue (la série ne les fige pas) : colonne « Tarif entrée / sortie ».
  const catalog = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });
  const prices = useMemo(() => new Map((catalog.data ?? []).map((m) => [m.id, { inputPricePerM: m.inputPricePerM, outputPricePerM: m.outputPricePerM }])), [catalog.data]);
  if (results.isError)
    return (
      <p role="alert" className="text-sm text-bad">
        {messageForError(results.error)}
      </p>
    );
  if (results.isPending) return <p className="text-sm text-mute">Chargement des résultats…</p>;
  return <RunMetricsTable rows={results.data} prices={prices} />;
}

const TITLE = 'm-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white';
/** Titre long : passe à la ligne (un mot très long est coupé) au lieu de repousser la pastille d'état et « Partager ». */
const TITLE_WRAP = 'min-w-0 [overflow-wrap:anywhere]';
/** Même borne que le serveur (création et renommage d'une série). */
const NAME_MAX = 200;

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * Titre de la série ; pour l'Admin, renommage sur place : crayon au survol, clic sur le titre ou le crayon pour éditer,
 * Entrée ou perte du focus enregistre, Échap annule. Nom vide refusé sans appel serveur.
 */
function RunTitle({ run, editable }: { run: RunSummary; editable: boolean }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(run.name);
  const [error, setError] = useState<string | null>(null);
  /** Entrée ou Échap déjà traités : la perte du focus qui suit ne doit pas enregistrer une seconde fois. */
  const handled = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Zone d'édition à la hauteur du texte : un nom long s'y lit en entier, sur plusieurs lignes.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  const rename = useMutation({
    mutationFn: (name: string) => renameRun(run.id, name),
    onSuccess: async (updated) => {
      queryClient.setQueryData([...RUNS_KEY, run.id], updated);
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...RUNS_KEY, run.id], exact: true }),
        queryClient.invalidateQueries({ queryKey: RUNS_KEY, exact: true }),
      ]);
    },
    onError: (err) => {
      handled.current = false;
      setError(messageForError(err));
    },
  });

  const start = () => {
    handled.current = false;
    setDraft(run.name);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(run.name);
    setError(null);
  };
  const save = () => {
    if (rename.isPending) return;
    const name = draft.trim();
    if (name === '') {
      setError('Le nom de la série ne peut pas être vide.');
      return;
    }
    if (name === run.name) {
      cancel();
      return;
    }
    setError(null);
    handled.current = true; // la perte du focus au démontage du champ ne relance pas l'enregistrement
    rename.mutate(name);
  };

  if (!editable) return <h1 className={`${TITLE} ${TITLE_WRAP}`}>{run.name}</h1>;

  if (editing)
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={inputId} className="sr-only">
          Nom de la série
        </label>
        <textarea
          ref={field}
          id={inputId}
          rows={1}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={draft}
          maxLength={NAME_MAX}
          readOnly={rename.isPending}
          aria-busy={rename.isPending || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handled.current = true;
              cancel();
            }
          }}
          onBlur={() => {
            if (handled.current) {
              handled.current = false;
              return;
            }
            save();
          }}
          className={`${TITLE} block w-full resize-none overflow-hidden rounded-lg border bg-night-0/60 px-2 py-0.5 ${error ? 'border-bad/60' : 'border-line-strong'}`}
        />
        {error ? (
          <p id={errorId} role="alert" className="m-0 text-xs text-bad">
            {error}
          </p>
        ) : null}
      </div>
    );

  // Titre et crayon frères dans l'en-tête (le crayon hors du titre : le nom accessible du titre reste le nom de la série) ;
  // le crayon apparaît au survol du titre (`peer`), à son propre survol et au focus clavier.
  return (
    <>
      <h1 className={`${TITLE} ${TITLE_WRAP} peer cursor-text`} title="Cliquer pour renommer" onClick={start}>
        {run.name}
      </h1>
      <button
        type="button"
        aria-label="Renommer la série"
        title="Renommer la série"
        onClick={start}
        className="-ml-2 shrink-0 rounded-full p-1.5 text-mute opacity-0 transition-opacity peer-hover:opacity-100 hover:text-white hover:opacity-100 focus-visible:opacity-100"
      >
        <PencilIcon />
      </button>
    </>
  );
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

  const [sharing, setSharing] = useState(false);
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
          {/* Le titre occupe la place libre et passe à la ligne : pastille et « Partager » restent sur sa première ligne. */}
          <header className="mb-4 flex items-start gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <RunTitle run={run.data} editable={isAdmin} />
              {status ? (
                <span className="mt-1.5 shrink-0">
                  <RunStatusChip status={status} />
                </span>
              ) : null}
            </div>
            {isAdmin ? (
              <Button className="shrink-0" onClick={() => setSharing(true)}>
                <span aria-hidden="true">⇪</span>
                Partager
              </Button>
            ) : null}
          </header>
          {live ? (
            <p className="mt-0 mb-4 max-w-prose text-sm text-mute">
              Les résultats arrivent au fil de l’eau. Vous pouvez fermer la page : la série continue sur le serveur.
            </p>
          ) : null}
          {isAdmin && sharing ? <ShareDialog open runId={id} runName={run.data.name} onClose={() => setSharing(false)} /> : null}
          <Facts run={run.data} progress={progress.data} />

          {progress.data ? (
            <div className="flex flex-col gap-4">
              <PauseNotice progress={progress.data} isAdmin={isAdmin} />
              {isAdmin ? <RunControls runId={id} progress={progress.data} /> : null}
              {progress.data.status === 'completed' ? null : <LiveView progress={progress.data} />}
              <ResultsSection
                runId={id}
                isAdmin={isAdmin}
                show={progress.data.status === 'completed'}
                active={ACTIVE.includes(progress.data.status)}
                tests={progress.data.matrix.map((m) => ({ runTestId: m.runTestId, testName: m.testName, category: m.category }))}
                judgePending={progress.data.judgePending}
              />
              {progress.data.status === 'completed' ? <CompletedView runId={id} /> : null}
            </div>
          ) : (
            <p className="text-sm text-mute">Chargement de l’avancement…</p>
          )}
        </>
      )}
    </div>
  );
}
