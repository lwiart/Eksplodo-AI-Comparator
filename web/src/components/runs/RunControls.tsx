import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MODELS_KEY, listModels } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { RUNS_KEY, addRunModels, pauseRun, resumeRun, retryRunErrors, updateRun, type RunProgress } from '../../api/runs';
import { parseBudget, usd } from '../../pages/LaunchRunPage';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';

const spentOf = (p: Pick<RunProgress, 'modelsCostUsd' | 'judgeCostUsd'>) => p.modelsCostUsd + p.judgeCostUsd;

/** À la reprise, `budget_exceeded` signifie « plafond atteint » (et non l'estimation du lancement). */
function controlError(err: unknown): string {
  return (err as { code?: unknown } | null)?.code === 'budget_exceeded'
    ? 'Plafond atteint : relevez-le au-dessus de la dépense avant de reprendre.'
    : messageForError(err);
}

/** Raison d'une pause ou d'une interruption, pour tous les rôles ; la consigne d'action est réservée à l'Admin. */
export function PauseNotice({ progress, isAdmin }: { progress: RunProgress; isAdmin: boolean }) {
  let text: string | null = null;
  if (progress.status === 'paused' && progress.pauseReason === 'budget') {
    // Le moteur s'arrête avant l'appel qui pourrait faire dépasser le plafond : la dépense peut lui rester inférieure.
    const spent = spentOf(progress);
    const budget = progress.budgetUsd ?? 0;
    text =
      (spent >= budget
        ? `Plafond atteint : ${usd(spent)} dépensés pour un plafond de ${usd(budget)}. `
        : `Plafond presque atteint : ${usd(spent)} dépensés pour un plafond de ${usd(budget)}, les appels suivants risqueraient de le dépasser. `) +
      (isAdmin ? 'Relevez le plafond pour reprendre la série.' : 'Un Admin peut le relever pour reprendre la série.');
  } else if (progress.status === 'paused') {
    text = 'Série en pause : les appels déjà lancés se terminent, aucun nouvel appel ne part.';
  } else if (progress.status === 'interrupted') {
    text = 'Série interrompue avant la fin.' + (isAdmin ? ' Reprenez-la pour lancer les appels restants.' : '');
  }
  if (!text) return null;
  return (
    <p role="status" className="m-0 rounded-xl border border-orange/40 bg-orange/10 px-4 py-3 text-sm text-peach">
      {text}
    </p>
  );
}

function AddModelsDialog({ open, onOpenChange, runModelIds, onAdd, pending, error }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  runModelIds: string[];
  onAdd(ids: string[]): void;
  pending: boolean;
  error: string | null;
}) {
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels, enabled: open });
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = (models.data ?? []).filter((m) => m.available && !runModelIds.includes(m.id));
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Ajouter un modèle"
      description="Le modèle passe tous les tests de la série ; la série reprend aussitôt."
    >
      {models.isError ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {messageForError(models.error)}
        </p>
      ) : models.isPending ? (
        <p className="m-0 text-sm text-mute">Chargement des modèles…</p>
      ) : candidates.length === 0 ? (
        <p className="m-0 text-sm text-mute">Tous les modèles disponibles font déjà partie de la série.</p>
      ) : (
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {candidates.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 has-[:checked]:border-orange/60 has-[:checked]:bg-orange/10"
            >
              <input type="checkbox" className="accent-orange" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{m.displayName}</span>
                <span className="block text-xs text-mute">{m.providerName}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Annuler
        </Button>
        <Button variant="primary" disabled={picked.length === 0 || pending} onClick={() => onAdd(picked)}>
          Ajouter à la série
        </Button>
      </div>
    </Dialog>
  );
}

/** Commandes de l'Admin : pause, reprise (relève du plafond après une pause budget), erreurs à relancer, modèles à ajouter. */
export function RunControls({ runId, progress }: { runId: string; progress: RunProgress }) {
  const client = useQueryClient();
  const [budget, setBudget] = useState('');
  const [adding, setAdding] = useState(false);

  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setBudget('');
      setAdding(false);
      void client.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
  const busy = action.isPending;

  const { status, pauseReason, counts } = progress;
  const spent = spentOf(progress);
  const budgetPause = status === 'paused' && pauseReason === 'budget';
  // Après une pause budget, la reprise passe par la relève du plafond (sinon le moteur s'arrêterait aussitôt).
  const canResume = status === 'interrupted' || (status === 'paused' && !budgetPause);
  const errors = counts.error + counts.timeout;

  const newBudget = parseBudget(budget);
  const budgetError =
    budget.trim() === ''
      ? null
      : newBudget === undefined || newBudget === null
        ? 'Saisissez un montant supérieur à 0 (4 décimales au plus).'
        : newBudget <= spent
          ? `Saisissez un montant supérieur à la dépense (${usd(spent)}).`
          : null;
  const budgetOk = typeof newBudget === 'number' && budgetError === null;

  return (
    <div className="flex flex-col gap-3">
      {budgetPause ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!budgetOk) return;
            action.mutate(async () => {
              await updateRun(runId, { budgetUsd: newBudget });
              await resumeRun(runId);
            });
          }}
        >
          <div className="w-56">
            <Field label="Nouveau plafond en $" inputMode="decimal" value={budget} error={budgetError} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" disabled={!budgetOk || busy}>
            Relever le plafond et reprendre
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === 'queued' || status === 'running' ? (
          <Button disabled={busy} onClick={() => action.mutate(() => pauseRun(runId))}>
            <span aria-hidden="true">⏸</span>
            Mettre en pause
          </Button>
        ) : null}
        {canResume ? (
          <Button variant="primary" disabled={busy} onClick={() => action.mutate(() => resumeRun(runId))}>
            <span aria-hidden="true">▶</span>
            Reprendre
          </Button>
        ) : null}
        {errors > 0 ? (
          <Button disabled={busy} onClick={() => action.mutate(() => retryRunErrors(runId))}>
            <span aria-hidden="true">⟳</span>
            Relancer les erreurs
          </Button>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => {
            action.reset();
            setAdding(true);
          }}
        >
          <span aria-hidden="true">+</span>
          Ajouter un modèle
        </Button>
      </div>

      {action.isError && !adding ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {controlError(action.error)}
        </p>
      ) : null}

      {/* Monté seulement ouvert : chaque ouverture repart d'une sélection vide (pas d'identifiants périmés). */}
      {adding ? (
        <AddModelsDialog
          open
          onOpenChange={setAdding}
          runModelIds={progress.models.map((m) => m.id)}
          pending={busy}
          error={action.isError ? controlError(action.error) : null}
          onAdd={(ids) => action.mutate(() => addRunModels(runId, ids))}
        />
      ) : null}
    </div>
  );
}
