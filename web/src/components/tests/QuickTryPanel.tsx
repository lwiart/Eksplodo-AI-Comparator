import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MODELS_KEY, listModels } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { getQuickTry, startQuickTry, type QuickTryOutcome, type QuickTryScore } from '../../api/tests';
import { formatNumber } from '../catalog/format';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { SelectField } from '../ui/SelectField';

/** Intervalle d'interrogation : aucune requête HTTP ne attend le résultat (limite de 60 s du proxy). */
const POLL_MS = 2000;

export const formatDuration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${formatNumber(Math.round(ms / 100) / 10)} s`);
const formatCost = (usd: number): string => `${formatNumber(Number(usd.toFixed(6)))} $`;

type Phase = { kind: 'idle' } | { kind: 'waiting'; label: string } | { kind: 'done'; outcome: QuickTryOutcome } | { kind: 'failed'; message: string };

function Metric({ label, children, title }: { label: string; children: string; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className="m-0 font-mono text-sm text-white">{children}</dd>
    </div>
  );
}

function ScoreBlock({ score }: { score: QuickTryScore }) {
  return (
    <div className="rounded-xl border border-line bg-night-0/60 p-3">
      {score.score !== null ? <p className="m-0 font-display text-base font-bold text-white">{`Note : ${formatNumber(score.score)}/10`}</p> : null}
      {/* Texte brut : React échappe la justification. */}
      <p className="m-0 mt-1 text-sm break-words whitespace-pre-wrap text-ink">{score.rationale}</p>
      {score.judgeModelName ? <p className="m-0 mt-1 text-xs text-mute">{`Noté par ${score.judgeModelName}`}</p> : null}
    </div>
  );
}

function Outcome({ outcome }: { outcome: QuickTryOutcome }) {
  const failed = outcome.status !== 'done';
  const tokens =
    `${formatNumber(outcome.inputTokens)} en entrée, ${formatNumber(outcome.outputTokens)} en sortie` +
    (outcome.reasoningTokens ? `, ${formatNumber(outcome.reasoningTokens)} de raisonnement` : '') +
    (outcome.tokensEstimated ? ' (estimé)' : '');
  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {outcome.errorMessage ?? (outcome.status === 'timeout' ? 'Le modèle n’a pas répondu à temps.' : 'Le modèle a renvoyé une erreur.')}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 min-[700px]:grid-cols-4">
        <Metric label="Premier token">{outcome.ttftMs === null ? '—' : formatDuration(outcome.ttftMs)}</Metric>
        <Metric label="Durée totale">{formatDuration(outcome.totalMs)}</Metric>
        <Metric label="Débit">{outcome.tokensPerS === null ? '—' : `${formatNumber(Math.round(outcome.tokensPerS * 10) / 10)} tokens/s`}</Metric>
        <Metric label="Coût" title={outcome.costSource === 'provider' ? 'Coût annoncé par le fournisseur' : outcome.costSource === 'computed' ? 'Coût calculé d’après les prix du catalogue' : undefined}>
          {outcome.costUsd === null ? '—' : formatCost(outcome.costUsd)}
        </Metric>
        <div className="col-span-full">
          <Metric label="Tokens">{tokens}</Metric>
        </div>
      </dl>
      {outcome.score ? <ScoreBlock score={outcome.score} /> : null}
      {outcome.text !== '' ? (
        <div>
          <p className="m-0 mb-1.5 text-xs text-mute">Réponse de {outcome.modelName}</p>
          {/* Texte brut : React échappe tout, aucune balise de la réponse n'est interprétée. */}
          <pre className="m-0 max-h-96 overflow-auto rounded-xl border border-line bg-night-0/60 p-3 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">{outcome.text}</pre>
        </div>
      ) : null}
    </div>
  );
}

type Props = {
  /** Des modifications ne sont pas enregistrées : l'essai les enregistre d'abord. */
  dirty: boolean;
  /** Enregistre si besoin ; renvoie l'identifiant du test, ou `null` si l'enregistrement est refusé (erreurs affichées par l'éditeur). */
  ensureSaved(): Promise<string | null>;
};

/** Essai rapide d'un test sur un modèle : tâche de la voie rapide, résultat interrogé toutes les 2 s. */
export function QuickTryPanel({ dirty, ensureSaved }: Props) {
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });
  const [modelId, setModelId] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = (models.data ?? []).filter((m) => m.available);
  const waiting = starting || phase.kind === 'waiting';

  useEffect(() => {
    if (jobId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await getQuickTry(jobId);
        if (cancelled) return;
        if (state.status === 'done' && state.outcome) setPhase({ kind: 'done', outcome: state.outcome });
        else if (state.status === 'failed' || state.status === 'done') setPhase({ kind: 'failed', message: state.message ?? "L'essai n'a pas pu être exécuté. Réessayez." });
        else {
          setPhase({ kind: 'waiting', label: state.status === 'running' ? 'Appel du modèle en cours…' : "En file d'attente…" });
          timer = setTimeout(() => void poll(), POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setPhase({ kind: 'failed', message: messageForError(err) });
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  async function start() {
    setError(null);
    setStarting(true);
    setJobId(null);
    setPhase({ kind: 'idle' });
    try {
      const id = await ensureSaved();
      if (id === null) return;
      const job = await startQuickTry(id, modelId);
      setPhase({ kind: 'waiting', label: "En file d'attente…" });
      setJobId(job);
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 id="quick-try-title" className="m-0 font-display text-lg font-bold text-white">
          Essai rapide
        </h2>
        <p className="mt-1 mb-0 text-sm text-mute">Envoie ce test à un seul modèle, sans créer de série. Le coût est tout de même facturé.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <SelectField
            label="Modèle"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            options={[
              { value: '', label: models.isPending ? 'Chargement…' : 'Choisir un modèle' },
              ...available.map((m) => ({ value: m.id, label: `${m.displayName} (${m.providerName})` })),
            ]}
          />
        </div>
        <Button variant="primary" disabled={modelId === '' || waiting} onClick={() => void start()}>
          {dirty ? 'Enregistrer et essayer' : 'Essayer'}
        </Button>
      </div>

      <div aria-live="polite">
        {models.isError ? <p className="m-0 text-sm text-bad">{messageForError(models.error)}</p> : null}
        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        {phase.kind === 'waiting' ? <p className="m-0 text-sm text-mute">{phase.label}</p> : null}
        {phase.kind === 'failed' ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {phase.message}
          </p>
        ) : null}
        {phase.kind === 'done' ? <Outcome outcome={phase.outcome} /> : null}
      </div>
    </Card>
  );
}
