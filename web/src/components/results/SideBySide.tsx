import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { RUNS_KEY } from '../../api/runs';
import { AttachmentGallery } from '../ui/AttachmentGallery';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { SelectField } from '../ui/SelectField';
import { costPerAnswer, DASH, score, tokensPerSecond } from './format';
import { Markdown } from './Markdown';
import { RaterSpread } from './RaterSpread';

type Tab = 'side' | 'blind' | 'spread';

export type SideBySideTest = { runTestId: string; testName: string };

/** Note imposée saisie : `undefined` quand ce n'est pas un nombre entier compris entre 0 et 100. */
export function parseOverride(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= 100 ? n : undefined;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="text-ink">{value}</span>
    </span>
  );
}

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
        <span className="ml-auto flex flex-col items-end">
          <span aria-label="Note finale" className="font-display text-[15px] font-extrabold text-peach">
            {score(answer.finalScore)}
          </span>
          <ScoreDetail a={answer} />
        </span>
      </header>
      {answer.status === 'truncated' ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm [overflow-wrap:anywhere] text-peach">
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
        <p className="m-0 border-l-2 border-orange pl-2 text-[11.5px] text-mute">
          {RATIONALE_LABEL[method]} : {answer.judgeRationale}
        </p>
      ) : null}
      <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 font-mono text-[10.5px] text-mute">
        <Metric label="1er token" value={answer.ttftMs === null ? DASH : `${answer.ttftMs.toLocaleString('fr-FR')} ms`} />
        <Metric label="Débit" value={tokensPerSecond(answer.tokensPerS)} />
        <Metric label="Coût" value={costPerAnswer(answer.costUsd)} />
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
}: {
  runId: string;
  tests: SideBySideTest[];
  isAdmin: boolean;
  judgePending?: number;
  /** Intervalle de relecture des réponses (celui du classement pendant la série), `false` une fois tout rendu. */
  pollMs?: number | false;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<Tab>('side');
  const runTestId = tests.some((t) => t.runTestId === selected) ? selected : (tests[0]?.runTestId ?? '');
  const answers = useQuery({
    queryKey: answersKey(runId, runTestId),
    queryFn: () => getAnswers(runId, runTestId),
    enabled: runTestId !== '',
    refetchInterval: pollMs,
  });
  const tabs: Tab[] = isAdmin ? ['side', 'blind', 'spread'] : ['side', 'blind'];
  const hiddenCount = answers.data?.answers.filter((a) => a.hiddenUntilScored).length ?? 0;
  const method = answers.data?.test.scoringMethod;
  // Relance du juge proposée seulement sur un test noté par le juge (le serveur refuse les autres : `not_rescorable`).
  const canRescore = isAdmin && method === 'judge';
  const testIndex = tests.findIndex((t) => t.runTestId === runTestId);

  // Une note imposée ou une relance change les réponses et le classement (la progression suit le juge en attente).
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: answersPrefix(runId) }),
      queryClient.invalidateQueries({ queryKey: rankingKey(runId) }),
      queryClient.invalidateQueries({ queryKey: [...RUNS_KEY, runId, 'progress'] }),
    ]);

  if (tests.length === 0) return null;
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-display text-base font-bold text-white">
          Réponses côte à côte
          {answers.data ? (
            <small className="ml-2 font-mono text-[11px] font-medium text-mute">
              test {testIndex + 1} / {tests.length} · « {answers.data.test.name} »
            </small>
          ) : null}
        </h2>
        {judgePending > 0 ? (
          <span role="status" className="rounded-full border border-orange/50 bg-orange/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-peach">
            Notation en cours · {judgePending} en attente
          </span>
        ) : null}
      </div>

      <SelectField label="Test" value={runTestId} options={tests.map((t) => ({ value: t.runTestId, label: t.testName }))} onChange={(e) => setSelected(e.target.value)} />

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
        {tab === 'side' ? (
          <>
            {canRescore ? <RescorePanel key={runTestId} runId={runId} runTestId={runTestId} onQueued={refresh} /> : null}
            {answers.isError ? (
              <p role="alert" className="text-sm text-bad">
                {messageForError(answers.error)}
              </p>
            ) : !answers.data ? (
              <p className="text-sm text-mute">Chargement des réponses…</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
                {answers.data.answers.filter((a) => !a.hiddenUntilScored).map((a) => (
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
  );
}
