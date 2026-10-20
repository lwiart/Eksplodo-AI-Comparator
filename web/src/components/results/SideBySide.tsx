import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MODELS_KEY, listModels } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import {
  answerAttachmentUrl,
  answersKey,
  answersPrefix,
  getAnswers,
  overrideScore,
  rankingKey,
  rescoreRun,
  type Answer,
  type RescoreBody,
  type ScoringMethod,
} from '../../api/results';
import { RUNS_KEY, rerunResults } from '../../api/runs';
import { AttachmentGallery } from '../ui/AttachmentGallery';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { SelectField } from '../ui/SelectField';
import { costPerAnswer, DASH, score, tokensPerSecond } from './format';
import { Markdown } from './Markdown';
import { RaterSpread } from './RaterSpread';
import { NO_FILTER, type AnswersFilter } from './answers-filter';
import { TestDetailDialog } from './TestDetailDialog';

type Tab = 'side' | 'blind' | 'spread';

/** Réponses qu'une relance choisie peut remettre en attente (terminées, hors combinaisons non supportées). */
const RERUNNABLE = new Set<Answer['status']>(['done', 'error', 'timeout', 'truncated']);

/** Sélection des réponses à relancer (Admin) ; absente pour les autres rôles. */
type RerunSelection = { picked: Set<string>; toggle(resultId: string): void; pickAll(resultIds: string[]): void };
const RerunSelectionContext = createContext<RerunSelection | null>(null);

/** Case « Relancer » d'une réponse terminée, quand la sélection est disponible (Admin). */
function RerunToggle({ answer }: { answer: Answer }) {
  const selection = useContext(RerunSelectionContext);
  if (!selection || !RERUNNABLE.has(answer.status)) return null;
  return (
    <label className="flex cursor-pointer items-center gap-1 font-mono text-[10.5px] text-mute hover:text-white">
      <input
        type="checkbox"
        checked={selection.picked.has(answer.resultId)}
        onChange={() => selection.toggle(answer.resultId)}
        aria-label={`Relancer ${answer.modelName}, répétition ${answer.repetition}`}
        className="accent-orange"
      />
      Relancer
    </label>
  );
}

/** « Cocher ces réponses » : les réponses terminées affichées pour ce test. */
function PickAllButton({ answers }: { answers: Answer[] }) {
  const selection = useContext(RerunSelectionContext);
  const ids = answers.filter((a) => RERUNNABLE.has(a.status)).map((a) => a.resultId);
  if (!selection || ids.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => selection.pickAll(ids)}
      className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] text-sky underline decoration-dotted underline-offset-2 hover:text-white"
    >
      Cocher ces réponses pour les relancer
    </button>
  );
}

/** Barre de relance des réponses cochées : la limite de tokens actuelle de chaque test est toujours reprise. */
function RerunBar({ runId, onDone }: { runId: string; onDone: () => Promise<unknown> }) {
  const selection = useContext(RerunSelectionContext);
  const rerun = useMutation({
    mutationFn: () => rerunResults(runId, [...selection!.picked]),
    onSuccess: async () => {
      selection!.pickAll([]);
      await onDone();
    },
  });
  if (!selection || (selection.picked.size === 0 && !rerun.isError)) return null;
  const n = selection.picked.size;
  return (
    <div
      role="region"
      aria-label="Relance des réponses cochées"
      className="sticky top-2 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-orange/50 bg-night-1/95 px-3.5 py-2.5 text-sm text-white shadow-lg backdrop-blur"
    >
      <b>
        {n} réponse{n > 1 ? 's' : ''} à relancer
      </b>
      <span className="ml-auto flex gap-2">
        <Button variant="ghost" disabled={rerun.isPending} onClick={() => selection.pickAll([])}>
          Vider
        </Button>
        <Button variant="primary" disabled={rerun.isPending || n === 0} onClick={() => rerun.mutate()}>
          <span aria-hidden="true">⟳</span>
          Relancer la sélection
        </Button>
      </span>
      <p className="m-0 w-full text-xs text-mute">
        Les réponses et notes de la sélection sont effacées puis rejouées avec la limite de tokens actuelle de chaque test (appels
        facturés). Les autres réponses ne changent pas.
      </p>
      {rerun.isError ? (
        <p role="alert" className="m-0 w-full text-sm text-bad">
          {messageForError(rerun.error)}
        </p>
      ) : null}
    </div>
  );
}

export type SideBySideTest = {
  runTestId: string;
  testName: string;
  category?: string;
  /** Modèles ayant au moins une réponse tronquée / en erreur sur ce test (matrice de progression). */
  truncatedModelIds?: string[];
  failedModelIds?: string[];
};

/** Filtre « Statut » des réponses : toutes, seulement les tronquées, seulement les erreurs (y compris délais dépassés). */
type StatusFilter = 'all' | 'truncated' | 'failed';

const STATUS_SUFFIX: Record<StatusFilter, string> = { all: '', truncated: ' · réponses tronquées', failed: ' · réponses en erreur' };

const matchesStatus = (a: Answer, status: StatusFilter) =>
  status === 'all' || (status === 'truncated' ? a.status === 'truncated' : a.status === 'error' || a.status === 'timeout');

/** Test retenu par le filtre « Statut » : un modèle choisi (ou n'importe lequel) a une réponse de ce statut. */
function testMatchesStatus(t: SideBySideTest, status: StatusFilter, modelId: string | null): boolean {
  if (status === 'all') return true;
  const ids = (status === 'truncated' ? t.truncatedModelIds : t.failedModelIds) ?? [];
  return modelId === null ? ids.length > 0 : ids.includes(modelId);
}

export { NO_FILTER, type AnswersFilter } from './answers-filter';

/** Note imposée saisie : `undefined` quand ce n'est pas un nombre entier compris entre 0 et 100. */
export function parseOverride(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= 100 ? n : undefined;
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span title={title}>
      {label} <span className="text-ink">{value}</span>
    </span>
  );
}

// Nombre de tokens à la française ; valeur absente (inconnue ou non transmise) : tiret.
const tokenCount = (n: number | null | undefined) => (n == null ? DASH : n.toLocaleString('fr-FR'));

/** « entrée / réflexion / sortie », « ≈ » devant quand le fournisseur n'a pas donné les comptes (estimation). */
const tokensLine = (a: Answer) =>
  `${a.tokensEstimated ? '≈ ' : ''}${tokenCount(a.inputTokens)} / ${tokenCount(a.reasoningTokens)} / ${tokenCount(a.outputTokens)}`;

const TOKENS_TITLE =
  'Tokens d’entrée, de réflexion et de sortie. La réflexion est comptée à part quand le fournisseur la détaille ; chez Anthropic, elle est comprise dans la sortie.';

function ScoreDetail({ a }: { a: Answer }) {
  const parts: string[] = [];
  if (a.autoScore !== null) parts.push(`auto ${score(a.autoScore)}`);
  if (a.manualAvg !== null) parts.push(`manuelle ${score(a.manualAvg)}`);
  if (a.overrideScore !== null) parts.push(`imposée ${score(a.overrideScore)}`);
  return parts.length > 0 ? <span className="font-mono text-[10.5px] text-mute">{parts.join(' · ')}</span> : null;
}

/** Imposition (ou retrait) de la note d'un résultat, réservée à l'Admin. */
function OverrideEditor({ answer, onSaved }: { answer: Answer; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const value = parseOverride(raw);
  const save = useMutation({
    mutationFn: (next: number | null) => overrideScore(answer.resultId, next),
    onSuccess: async () => {
      await onSaved();
      setOpen(false);
      setRaw('');
    },
  });
  return (
    <div className="flex flex-col gap-2">
      {open ? (
        // Formulaire : la touche Entrée dans le champ enregistre la note (si elle est valide).
        <form
          aria-label="Note imposée"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value !== undefined && !save.isPending) save.mutate(value);
          }}
        >
          <Field
            label="Note imposée (0 à 100)"
            inputMode="numeric"
            value={raw}
            maxLength={3}
            className="w-28"
            error={raw !== '' && value === undefined ? 'Nombre entier entre 0 et 100 (ex. 75).' : null}
            onChange={(e) => setRaw(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={value === undefined || save.isPending}>
            Enregistrer
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Annuler
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setRaw(answer.overrideScore === null ? '' : String(answer.overrideScore).replace('.', ','));
              setOpen(true);
            }}
          >
            Imposer une note
          </Button>
          {answer.overrideScore !== null ? (
            <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Retirer la note imposée
            </Button>
          ) : null}
        </div>
      )}
      {save.isError ? (
        <span role="alert" className="text-xs text-bad">
          {messageForError(save.error)}
        </span>
      ) : null}
    </div>
  );
}

/** Auteur de la justification : la correction automatique pour un test à réponse attendue, le juge sinon. */
const RATIONALE_LABEL: Record<ScoringMethod, string> = { expected: 'Correction automatique', judge: 'Juge', manual: 'Juge' };

function AnswerCard({
  answer,
  method,
  isAdmin,
  onOverride,
}: {
  answer: Answer;
  method: ScoringMethod;
  isAdmin: boolean;
  onOverride: () => Promise<unknown>;
}) {
  const failed = answer.status !== 'done';
  return (
    <article
      aria-label={`${answer.modelName}, répétition ${answer.repetition}`}
      className="flex flex-col gap-2.5 rounded-2xl border border-line bg-night-0/40 p-3.5 text-[12.5px] leading-normal"
    >
      <header className="flex items-center gap-2">
        <i aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: answer.color, boxShadow: `0 0 10px ${answer.color}` }} />
        <b className="font-display text-[13px] text-white">{answer.modelName}</b>
        <span className="font-mono text-[10.5px] text-mute">rép. {answer.repetition}</span>
        <span className="ml-auto">
          <RerunToggle answer={answer} />
        </span>
        <span className="flex flex-col items-end">
          <span aria-label="Note finale" className="font-display text-[15px] font-extrabold text-peach">
            {score(answer.finalScore)}
          </span>
          <ScoreDetail a={answer} />
        </span>
      </header>
      {answer.status === 'pending' || answer.status === 'running' ? (
        <p className="m-0 text-sm text-mute">{answer.status === 'running' ? 'Appel en cours…' : 'En attente de lancement.'}</p>
      ) : answer.status === 'truncated' ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm [overflow-wrap:anywhere] text-truncated-text">
            <b>Réponse tronquée.</b> {answer.errorMessage ?? 'Aucun texte : la limite de tokens a été atteinte pendant la réflexion.'}
          </p>
          <p className="m-0 text-xs text-mute">Elle n’entre pas dans la note. « Relancer les erreurs » la rejoue avec une marge de réflexion.</p>
        </div>
      ) : failed ? (
        // Message du fournisseur souvent long et sans espaces (JSON) : il passe à la ligne au lieu de déborder de la carte.
        <p className="m-0 text-sm [overflow-wrap:anywhere] text-bad">{answer.errorMessage ?? 'Pas de réponse pour ce résultat.'}</p>
      ) : (
        <div className="max-h-[360px] overflow-y-auto pr-1 text-ink">
          {answer.responseText ? <Markdown text={answer.responseText} /> : <span className="text-mute">Réponse vide.</span>}
        </div>
      )}
      {answer.judgeRationale ? (
        <p className="m-0 border-l-2 border-orange pl-2.5 text-[13px] leading-relaxed text-ink/80">
          {RATIONALE_LABEL[method]} : {answer.judgeRationale}
        </p>
      ) : null}
      <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 font-mono text-[10.5px] text-mute">
        <Metric label="1er token" value={answer.ttftMs === null ? DASH : `${answer.ttftMs.toLocaleString('fr-FR')} ms`} />
        <Metric label="Débit" value={tokensPerSecond(answer.tokensPerS)} />
        {answer.status === 'pending' || answer.status === 'running' ? null : (
          <Metric label="Tokens entrée/réflexion/sortie :" value={tokensLine(answer)} title={TOKENS_TITLE} />
        )}
        <Metric label="Coût" value={answer.status === 'pending' || answer.status === 'running' ? DASH : costPerAnswer(answer.costUsd)} />
      </footer>
      {isAdmin && !failed ? <OverrideEditor answer={answer} onSaved={onOverride} /> : null}
    </article>
  );
}

/** Choix du juge et relance de sa notation sur un test ou sur toute la série (Admin). */
function RescorePanel({ runId, runTestId, onQueued }: { runId: string; runTestId: string; onQueued: () => Promise<unknown> }) {
  const [judgeId, setJudgeId] = useState('');
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });
  const rescore = useMutation({ mutationFn: (body: RescoreBody) => rescoreRun(runId, body), onSuccess: onQueued });
  const judge = judgeId === '' ? {} : { judgeModelId: judgeId };
  const options = [{ value: '', label: 'Juge de la série' }, ...(models.data ?? []).filter((m) => m.available).map((m) => ({ value: m.id, label: `${m.displayName} (${m.providerName})` }))];
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-night-0/30 p-3">
      <SelectField label="Juge pour la relance" value={judgeId} options={options} onChange={(e) => setJudgeId(e.target.value)} />
      <Button disabled={rescore.isPending} onClick={() => rescore.mutate({ scope: 'test', runTestId, ...judge })}>
        Relancer le juge sur ce test
      </Button>
      <Button disabled={rescore.isPending} onClick={() => rescore.mutate({ scope: 'run', ...judge })}>
        Relancer le juge sur toute la série
      </Button>
      {rescore.isError ? (
        <span role="alert" className="text-sm text-bad">
          {messageForError(rescore.error)}
        </span>
      ) : rescore.isSuccess ? (
        <span role="status" className="text-sm text-good">
          {rescore.data.queued > 0 ? `${rescore.data.queued} notation(s) relancée(s).` : 'Aucune notation à relancer.'}
        </span>
      ) : null}
    </div>
  );
}

/** Relance du juge sur un seul résultat. */
function ResultRescore({ runId, resultId, onQueued }: { runId: string; resultId: string; onQueued: () => Promise<unknown> }) {
  const rescore = useMutation({ mutationFn: () => rescoreRun(runId, { scope: 'result', resultId }), onSuccess: onQueued });
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" disabled={rescore.isPending} onClick={() => rescore.mutate()}>
        Relancer le juge sur ce résultat
      </Button>
      {rescore.isError ? (
        <span role="alert" className="text-xs text-bad">
          {messageForError(rescore.error)}
        </span>
      ) : null}
    </div>
  );
}

/** Valeur de la liste « Test » qui affiche tous les tests de la sélection, l'un sous l'autre. */
const ALL_TESTS = '__tous__';

/** Grille des réponses : pleine largeur avec un seul modèle (aussi large que la question), sinon en colonnes. */
const answersGrid = (oneModel: boolean) => (oneModel ? 'grid gap-3' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-3');

/** Un test de la sélection en mode « Tous les tests » : titre cliquable (détail), pièces jointes et réponses filtrées. */
function TestAnswersBlock({
  runId,
  runTestId,
  testName,
  modelId,
  status,
  isAdmin,
  pollMs,
  onRefresh,
}: {
  runId: string;
  runTestId: string;
  testName: string;
  modelId: string | null;
  status: StatusFilter;
  isAdmin: boolean;
  pollMs: number | false;
  onRefresh: () => Promise<unknown>;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const answers = useQuery({ queryKey: answersKey(runId, runTestId), queryFn: () => getAnswers(runId, runTestId), refetchInterval: pollMs });
  const hiddenCount = answers.data?.answers.filter((a) => a.hiddenUntilScored).length ?? 0;
  const visible =
    answers.data?.answers.filter((a) => !a.hiddenUntilScored && (modelId === null || a.modelId === modelId) && matchesStatus(a, status)) ?? [];
  return (
    <section aria-label={testName} className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <button
          type="button"
          title="Voir le détail du test : prompts et résultat attendu"
          onClick={() => setDetailOpen(true)}
          className="cursor-pointer border-0 bg-transparent p-0 text-left font-display text-sm font-bold text-peach underline decoration-dotted underline-offset-2 hover:text-white"
        >
          {testName}
        </button>
        {answers.data ? <span className="font-mono text-[11px] text-mute">{answers.data.test.category}</span> : null}
        <span className="ml-auto">
          <PickAllButton answers={visible} />
        </span>
      </div>
      {answers.data && detailOpen ? <TestDetailDialog test={answers.data.test} open={detailOpen} onOpenChange={setDetailOpen} /> : null}
      {answers.isError ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {messageForError(answers.error)}
        </p>
      ) : !answers.data ? (
        <p className="m-0 text-sm text-mute">Chargement des réponses…</p>
      ) : (
        <>
          <p className="m-0 rounded-xl border border-line bg-night-0/45 px-3.5 py-2.5 text-sm whitespace-pre-line text-ink">{answers.data.test.userPrompt}</p>
          <div className={answersGrid(modelId !== null)}>
            {hiddenCount > 0 ? (
              <p className="m-0 text-sm text-mute">
                {hiddenCount} réponse{hiddenCount > 1 ? 's' : ''} masquée{hiddenCount > 1 ? 's' : ''} :{' '}
                <Link to={`/a-noter/${runTestId}`} className="font-semibold text-peach">
                  noter cette question
                </Link>
              </p>
            ) : null}
            {visible.length === 0 && hiddenCount === 0 ? <p className="m-0 text-sm text-mute">Aucune réponse pour ce test.</p> : null}
            {visible.map((a) => (
              <AnswerCard key={a.resultId} answer={a} method={answers.data.test.scoringMethod} isAdmin={isAdmin} onOverride={onRefresh} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const TAB_LABELS: Record<Tab, string> = { side: 'Côte à côte', blind: 'À l’aveugle', spread: 'Écarts entre évaluateurs' };

/**
 * Réponses d'un test côte à côte avec notes, justification du juge et mesures ; l'Admin peut imposer une note,
 * relancer le juge et consulter les écarts entre évaluateurs.
 */
export function SideBySide({
  runId,
  tests,
  isAdmin,
  judgePending = 0,
  pollMs = false,
  filter,
  onFilterChange,
  models = [],
  focusKey = 0,
}: {
  runId: string;
  tests: SideBySideTest[];
  isAdmin: boolean;
  judgePending?: number;
  /** Intervalle de relecture des réponses (celui du classement pendant la série), `false` une fois tout rendu. */
  pollMs?: number | false;
  /** Filtre contrôlé (la matrice le pose aussi) ; sans lui, le composant garde son propre filtre. */
  filter?: AnswersFilter;
  onFilterChange?: (filter: AnswersFilter) => void;
  /** Modèles de la série, pour la liste « Modèle ». */
  models?: { modelId: string; name: string }[];
  /** Change à chaque clic dans la matrice : la liste des réponses est alors amenée à l'écran. */
  focusKey?: number;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<Tab>('side');
  const [detailOpen, setDetailOpen] = useState(false);
  const [ownFilter, setOwnFilter] = useState<AnswersFilter>(NO_FILTER);
  const current = filter ?? ownFilter;
  const setFilter = onFilterChange ?? setOwnFilter;
  const cardRef = useRef<HTMLDivElement>(null);
  // Réponses cochées pour une relance (Admin), gardées d'un test à l'autre.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const selection: RerunSelection | null = isAdmin
    ? {
        picked,
        toggle: (id) =>
          setPicked((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
          }),
        pickAll: (ids) => setPicked((prev) => (ids.length === 0 ? new Set() : new Set([...prev, ...ids]))),
      }
    : null;
  const categories = [...new Set(tests.map((t) => t.category).filter((c): c is string => !!c))];
  const [status, setStatus] = useState<StatusFilter>('all');
  const inCategory = current.category ? tests.filter((t) => t.category === current.category) : tests;
  const shown = inCategory.filter((t) => testMatchesStatus(t, status, current.modelId));
  const statusCount = (st: StatusFilter) => inCategory.filter((t) => testMatchesStatus(t, st, current.modelId)).length;
  const hasStatusData = tests.some((t) => t.truncatedModelIds !== undefined || t.failedModelIds !== undefined);
  // « Tous les tests » : toute la sélection (catégorie, modèle) l'une sous l'autre ; sinon un test à la fois.
  const allMode = selected === ALL_TESTS && shown.length > 0;
  const runTestId = allMode ? '' : shown.some((t) => t.runTestId === selected) ? selected : (shown[0]?.runTestId ?? '');
  const filterModel = models.find((m) => m.modelId === current.modelId);
  const filtered = current.modelId !== null || current.category !== null || status !== 'all';
  // Clic sur une note de la matrice : tous les tests de la catégorie (et du modèle) choisis, puis défilement jusqu'ici.
  useEffect(() => {
    if (focusKey === 0) return;
    setSelected(ALL_TESTS);
    cardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [focusKey]);
  const answers = useQuery({
    queryKey: answersKey(runId, runTestId),
    queryFn: () => getAnswers(runId, runTestId),
    enabled: runTestId !== '',
    refetchInterval: pollMs,
  });
  const tabs: Tab[] = isAdmin ? ['side', 'blind', 'spread'] : ['side', 'blind'];
  const hiddenCount = answers.data?.answers.filter((a) => a.hiddenUntilScored).length ?? 0;
  const visible =
    answers.data?.answers.filter(
      (a) => !a.hiddenUntilScored && (current.modelId === null || a.modelId === current.modelId) && matchesStatus(a, status),
    ) ?? [];
  const method = answers.data?.test.scoringMethod;
  // Relance du juge proposée seulement sur un test noté par le juge (le serveur refuse les autres : `not_rescorable`).
  const canRescore = isAdmin && method === 'judge';
  const testIndex = shown.findIndex((t) => t.runTestId === runTestId);

  // Une note imposée ou une relance change les réponses et le classement (la progression suit le juge en attente).
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: answersPrefix(runId) }),
      queryClient.invalidateQueries({ queryKey: rankingKey(runId) }),
      queryClient.invalidateQueries({ queryKey: [...RUNS_KEY, runId, 'progress'] }),
    ]);

  if (tests.length === 0) return null;
  return (
    <RerunSelectionContext.Provider value={selection}>
      <Card ref={cardRef} className="flex scroll-mt-4 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-display text-base font-bold text-white">
          Réponses côte à côte
          {allMode ? (
            <small className="ml-2 font-mono text-[11px] font-medium text-mute">
              {shown.length} test{shown.length > 1 ? 's' : ''}
            </small>
          ) : answers.data ? (
            <small className="ml-2 font-mono text-[11px] font-medium text-mute">
              test {testIndex + 1} / {shown.length}
            </small>
          ) : null}
        </h2>
        {judgePending > 0 ? (
          <span role="status" className="rounded-full border border-orange/50 bg-orange/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-peach">
            Notation en cours · {judgePending} en attente
          </span>
        ) : null}
      </div>

      {/* Filtres : catégorie et modèle (posés aussi par un clic dans la matrice), puis le test parmi ceux de la catégorie. */}
      <div className="flex flex-wrap items-end gap-2">
        {categories.length > 1 ? (
          <SelectField
            label="Catégorie"
            value={current.category ?? ''}
            options={[{ value: '', label: 'Toutes' }, ...categories.map((c) => ({ value: c, label: c }))]}
            onChange={(e) => setFilter({ ...current, category: e.target.value || null })}
          />
        ) : null}
        <SelectField
          label="Test"
          value={allMode ? ALL_TESTS : runTestId}
          options={[
            ...(shown.length > 1 ? [{ value: ALL_TESTS, label: `Tous les tests (${shown.length})` }] : []),
            ...shown.map((t) => ({ value: t.runTestId, label: t.testName })),
          ]}
          onChange={(e) => setSelected(e.target.value)}
        />
        {models.length > 1 ? (
          <SelectField
            label="Modèle"
            value={current.modelId ?? ''}
            options={[{ value: '', label: 'Tous' }, ...models.map((m) => ({ value: m.modelId, label: m.name }))]}
            onChange={(e) => setFilter({ ...current, modelId: e.target.value || null })}
          />
        ) : null}
        {hasStatusData ? (
          <SelectField
            label="Statut"
            value={status}
            options={[
              { value: 'all', label: 'Toutes les réponses' },
              { value: 'truncated', label: `Tronquées (${statusCount('truncated')} test${statusCount('truncated') > 1 ? 's' : ''})` },
              { value: 'failed', label: `En erreur (${statusCount('failed')} test${statusCount('failed') > 1 ? 's' : ''})` },
            ]}
            onChange={(e) => {
              const next = e.target.value as StatusFilter;
              setStatus(next);
              // Tronquées ou en erreur : tous les tests concernés l'un sous l'autre.
              if (next !== 'all') setSelected(ALL_TESTS);
            }}
          />
        ) : null}
        {answers.data && !allMode ? (
          <Button variant="ghost" onClick={() => setDetailOpen(true)}>
            Détail du test
          </Button>
        ) : null}
      </div>
      {filtered ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-2xl border border-orange/50 bg-orange/10 px-3 py-2 text-sm text-white">
          <span>
            Filtre : <b>{filterModel?.name ?? 'tous les modèles'}</b> · {current.category ?? 'toutes les catégories'}
            {STATUS_SUFFIX[status]} ({shown.length} test{shown.length > 1 ? 's' : ''})
          </span>
          <Button variant="ghost" className="ml-auto px-3 py-1 text-xs" onClick={() => {
              setFilter(NO_FILTER);
              setStatus('all');
            }}
          >
            Retirer le filtre
          </Button>
        </div>
      ) : null}
      {answers.data && detailOpen ? <TestDetailDialog test={answers.data.test} open={detailOpen} onOpenChange={setDetailOpen} /> : null}

      <div role="tablist" aria-label="Vue des réponses" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 font-sans text-xs font-semibold ${
              tab === t ? 'border-orange/60 bg-orange/10 text-white' : 'border-line bg-transparent text-mute hover:text-white'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TAB_LABELS[tab]} className="flex flex-col gap-3">
        {tab === 'side' ? <RerunBar runId={runId} onDone={refresh} /> : null}
        {tab === 'side' && allMode ? (
          <div className="flex flex-col gap-4">
            {shown.map((t) => (
              <TestAnswersBlock
                key={t.runTestId}
                runId={runId}
                runTestId={t.runTestId}
                testName={t.testName}
                modelId={current.modelId}
                status={status}
                isAdmin={isAdmin}
                pollMs={pollMs}
                onRefresh={refresh}
              />
            ))}
          </div>
        ) : tab === 'side' ? (
          <>
            {answers.data ? (
              <section aria-label={answers.data.test.name} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <button
                    type="button"
                    title="Voir le détail du test : prompts et résultat attendu"
                    onClick={() => setDetailOpen(true)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-left font-display text-sm font-bold text-peach underline decoration-dotted underline-offset-2 hover:text-white"
                  >
                    {answers.data.test.name}
                  </button>
                  <span className="font-mono text-[11px] text-mute">{answers.data.test.category}</span>
                </div>
                <p className="m-0 rounded-xl border border-line bg-night-0/45 px-3.5 py-2.5 text-sm whitespace-pre-line text-ink">{answers.data.test.userPrompt}</p>
              </section>
            ) : null}
            {canRescore ? <RescorePanel key={runTestId} runId={runId} runTestId={runTestId} onQueued={refresh} /> : null}
            <div className="flex justify-end empty:hidden">
              <PickAllButton answers={visible} />
            </div>
            {answers.isError ? (
              <p role="alert" className="text-sm text-bad">
                {messageForError(answers.error)}
              </p>
            ) : !answers.data ? (
              <p className="text-sm text-mute">Chargement des réponses…</p>
            ) : (
              <div className={answersGrid(current.modelId !== null)}>
                {answers.data.test.attachments.length > 0 ? (
                  <div className="md:col-span-2 xl:col-span-3">
                    <AttachmentGallery
                      label="Pièces jointes du test"
                      items={answers.data.test.attachments.map((att) => ({
                        name: att.originalName,
                        mime: att.mime,
                        pages: att.pages,
                        viewUrl: answerAttachmentUrl(runId, runTestId, att.index, true),
                        downloadUrl: answerAttachmentUrl(runId, runTestId, att.index),
                      }))}
                    />
                  </div>
                ) : null}
                {hiddenCount > 0 ? (
                  <div className="flex flex-col gap-3 rounded-2xl border border-line bg-night-0/40 p-3.5 md:col-span-2 xl:col-span-3">
                    <p className="m-0 text-sm text-mute">Notez cette question pour voir les réponses ({hiddenCount} masquée{hiddenCount > 1 ? 's' : ''}).</p>
                    <Link to={`/a-noter/${runTestId}`} className="self-start text-sm font-semibold text-peach">
                      Noter cette question
                    </Link>
                  </div>
                ) : null}
                {current.modelId !== null && visible.length === 0 && hiddenCount === 0 ? (
                  <p className="m-0 text-sm text-mute md:col-span-2 xl:col-span-3">Aucune réponse de {filterModel?.name ?? 'ce modèle'} pour ce test.</p>
                ) : null}
                {visible.map((a) => (
                  <div key={a.resultId} className="flex flex-col gap-1.5">
                    <AnswerCard answer={a} method={answers.data.test.scoringMethod} isAdmin={isAdmin} onOverride={refresh} />
                    {canRescore && a.status === 'done' ? <ResultRescore runId={runId} resultId={a.resultId} onQueued={refresh} /> : null}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : tab === 'blind' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="m-0 max-w-prose text-sm text-mute">
              Notez les réponses de ce test sans connaître le modèle qui les a écrites : les noms apparaissent une fois vos notes enregistrées.
            </p>
            <Link
              to={`/a-noter/${runTestId}`}
              className="inline-flex items-center justify-center rounded-full border border-line-strong bg-night-2/70 px-4 py-2 text-[13px] font-semibold text-white no-underline hover:bg-night-2"
            >
              Noter à l’aveugle
            </Link>
          </div>
        ) : (
          <RaterSpread runId={runId} runTestId={runTestId} />
        )}
      </div>
      </Card>
    </RerunSelectionContext.Provider>
  );
}
