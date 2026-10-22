import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MODELS_KEY, listModels } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import {
  RUNS_KEY,
  addRunModels,
  addRunTests,
  cancelPendingRun,
  getMissingSuiteTests,
  missingSuiteTestsKey,
  pauseRun,
  removeRunModel,
  resumeRun,
  retryRunErrors,
  updateRun,
  type MissingSuiteTest,
  type RunProgress,
} from '../../api/runs';
import { budgetUsd, parseBudget, usd } from '../../lib/format';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { SelectField } from '../ui/SelectField';

const spentOf = (p: Pick<RunProgress, 'modelsCostUsd' | 'judgeCostUsd'>) => p.modelsCostUsd + p.judgeCostUsd;

/** À la reprise, `budget_exceeded` signifie « plafond insuffisant » (et non l'estimation du lancement). */
function controlError(err: unknown): string {
  return (err as { code?: unknown } | null)?.code === 'budget_exceeded'
    ? 'Plafond insuffisant : il doit couvrir la dépense et le coût maximal du prochain appel.'
    : messageForError(err);
}

/**
 * Plafond minimal pour lancer un appel de plus : dépense + coût maximal du prochain appel, arrondi au dix-millième
 * supérieur (précision du plafond) ; `null` quand ce coût est inconnu.
 */
function minimumBudget(p: Pick<RunProgress, 'modelsCostUsd' | 'judgeCostUsd' | 'nextCallMaxCostUsd'>): number | null {
  if (p.nextCallMaxCostUsd === null) return null;
  const microUsd = Math.round((spentOf(p) + p.nextCallMaxCostUsd) * 1_000_000);
  return Math.ceil(microUsd / 100) / 10_000;
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

/** Retrait d'un modèle : choix du modèle, puis confirmation de la suppression définitive de ses résultats. */
function RemoveModelDialog({ onOpenChange, models, onRemove, pending, error }: {
  onOpenChange(open: boolean): void;
  models: RunProgress['models'];
  onRemove(modelId: string): void;
  pending: boolean;
  error: string | null;
}) {
  const [modelId, setModelId] = useState('');
  const chosen = models.find((m) => m.id === modelId);
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Retirer un modèle"
      description="Ses réponses, ses notes (juge, notes manuelles, note imposée) et sa place au classement sont supprimées définitivement. La dépense déjà engagée reste comptée."
    >
      <SelectField
        label="Modèle à retirer"
        value={modelId}
        options={[{ value: '', label: 'Choisir un modèle' }, ...models.map((m) => ({ value: m.id, label: m.name }))]}
        onChange={(e) => setModelId(e.target.value)}
      />
      {error ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
          Annuler
        </Button>
        <Button variant="danger" disabled={pending || !chosen} onClick={() => chosen && onRemove(chosen.id)}>
          {chosen ? `Retirer ${chosen.name} définitivement` : 'Retirer définitivement'}
        </Button>
      </div>
    </Dialog>
  );
}

/** Tests ajoutés à la suite après le lancement : tous cochés au départ, passés par tous les modèles de la série. */
function AddTestsDialog({ onOpenChange, tests, modelCount, onAdd, pending, error }: {
  onOpenChange(open: boolean): void;
  tests: MissingSuiteTest[];
  modelCount: number;
  onAdd(ids: string[]): void;
  pending: boolean;
  error: string | null;
}) {
  const [picked, setPicked] = useState<string[]>(() => tests.map((t) => t.id));
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Ajouter les nouveaux tests de la suite"
      description={`Ces tests ont été ajoutés à la suite après le lancement. Les tests cochés sont passés par ${modelCount > 1 ? `les ${modelCount} modèles` : 'le modèle'} de la série (appels facturés) ; la série reprend aussitôt.`}
    >
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
        {tests.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 has-[:checked]:border-orange/60 has-[:checked]:bg-orange/10"
          >
            <input type="checkbox" className="accent-orange" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-white">{t.name}</span>
              <span className="block text-xs text-mute">{t.category}</span>
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
          Annuler
        </Button>
        <Button variant="primary" disabled={picked.length === 0 || pending} onClick={() => onAdd(picked)}>
          {picked.length > 1 ? `Ajouter et lancer ces ${picked.length} tests` : 'Ajouter et lancer ce test'}
        </Button>
      </div>
    </Dialog>
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

/** Commandes de l'Admin : pause, reprise (relève du plafond après une pause budget), erreurs à relancer, tests et modèles à ajouter. */
export function RunControls({ runId, progress }: { runId: string; progress: RunProgress }) {
  const client = useQueryClient();
  const [budget, setBudget] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addingTests, setAddingTests] = useState(false);
  // Tests ajoutés à la suite depuis le lancement (rafraîchis avec la série).
  const missingTests = useQuery({ queryKey: missingSuiteTestsKey(runId), queryFn: () => getMissingSuiteTests(runId) });
  const newTests = missingTests.data ?? [];

  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setBudget('');
      setAdding(false);
      setRemoving(false);
      setAddingTests(false);
      void client.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
  const busy = action.isPending;

  const { status, pauseReason, counts } = progress;
  const spent = spentOf(progress);
  const budgetPause = status === 'paused' && pauseReason === 'budget';
  // Après une pause budget, la reprise passe par la relève du plafond (sinon le moteur s'arrêterait aussitôt).
  const canResume = status === 'interrupted' || (status === 'paused' && !budgetPause);
  // Les réponses tronquées sont rejouées aussi (avec une marge de réflexion).
  const errors = counts.error + counts.timeout + counts.truncated;
  const canCancel = counts.pending > 0 && status !== 'completed';

  const newBudget = parseBudget(budget);
  const minimum = minimumBudget(progress);
  const budgetError =
    budget.trim() === ''
      ? null
      : newBudget === undefined || newBudget === null
        ? 'Saisissez un montant supérieur à 0 (4 décimales au plus).'
        : minimum !== null
          ? newBudget < minimum
            ? `Saisissez au moins ${budgetUsd(minimum)} pour lancer un appel de plus.`
            : null
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
            <Field
              label="Nouveau plafond en $"
              inputMode="decimal"
              value={budget}
              error={budgetError}
              {...(minimum === null ? {} : { hint: `Au moins ${budgetUsd(minimum)} pour lancer un appel de plus.` })}
              onChange={(e) => setBudget(e.target.value)}
            />
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
        {canCancel ? (
          <Button
            disabled={busy}
            title="Les appels pas encore lancés passent en erreur « annulé » ; ceux en cours se terminent. « Relancer les erreurs » les rejoue."
            onClick={() => action.mutate(() => cancelPendingRun(runId))}
          >
            <span aria-hidden="true">✕</span>
            Annuler les tests en attente ({counts.pending})
          </Button>
        ) : null}
        {errors > 0 ? (
          <Button disabled={busy} onClick={() => action.mutate(() => retryRunErrors(runId))}>
            <span aria-hidden="true">⟳</span>
            Relancer les erreurs
          </Button>
        ) : null}
        {newTests.length > 0 ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              action.reset();
              setAddingTests(true);
            }}
          >
            <span aria-hidden="true">+</span>
            Ajouter les nouveaux tests de la suite ({newTests.length})
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
        {/* Retrait : série arrêtée (en pause, interrompue ou terminée) et au moins deux modèles. */}
        {status !== 'queued' && status !== 'running' && progress.models.length > 1 ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              action.reset();
              setRemoving(true);
            }}
          >
            <span aria-hidden="true">−</span>
            Retirer un modèle
          </Button>
        ) : null}
      </div>

      {action.isError && !adding && !removing && !addingTests ? (
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
      {addingTests && newTests.length > 0 ? (
        <AddTestsDialog
          onOpenChange={setAddingTests}
          tests={newTests}
          modelCount={progress.models.length}
          pending={busy}
          error={action.isError ? controlError(action.error) : null}
          onAdd={(ids) => action.mutate(() => addRunTests(runId, ids))}
        />
      ) : null}
      {removing ? (
        <RemoveModelDialog
          onOpenChange={setRemoving}
          models={progress.models}
          pending={busy}
          error={action.isError ? controlError(action.error) : null}
          onRemove={(modelId) => action.mutate(() => removeRunModel(runId, modelId))}
        />
      ) : null}
    </div>
  );
}
