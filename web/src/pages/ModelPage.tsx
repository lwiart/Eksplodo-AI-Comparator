import * as Switch from '@radix-ui/react-switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MODELS_KEY, getModel, getModelStats, modelStatsKey, type ModelStats, type Rank, updateModel, type ModelPatch, type PublicModel, type PublicProvider } from '../api/catalog';
import { ApiError } from '../api/client';
import { messageForError } from '../api/messages';
import { useAuth } from '../auth/AuthProvider';
import { formatNumber } from '../components/catalog/format';
import { reliabilityPercent, rankLabel, score, tokensPerSecond, ttft } from '../components/results/format';
import { ModelForm, draftFromModel, hasValidPrices, parsePrice, type ModelDraft } from '../components/catalog/ModelForm';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';

type Model = PublicModel & { provider: PublicProvider };

// Recharts n'est chargé qu'à l'affichage du radar.
const ModelRadar = lazy(() => import('../components/catalog/ModelRadar'));

const EMPTY_SERIES = 'Aucune série pour l’instant';

function KeyChip({ provider, isAdmin }: { provider: PublicProvider; isAdmin: boolean }) {
  if (provider.fake) return <Chip tone="live">Faux fournisseur</Chip>;
  if (provider.keyState === 'stored') {
    return (
      <Chip tone="good">
        Clé enregistrée
        {isAdmin && provider.keyLast4 ? <span className="ml-1.5 text-white">{`…${provider.keyLast4}`}</span> : null}
      </Chip>
    );
  }
  if (provider.keyState === 'unreadable') return <Chip tone="bad">Clé illisible</Chip>;
  return <Chip tone="live">Clé manquante</Chip>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className="m-0 mt-0.5 font-mono text-lg font-semibold text-white">{children}</dd>
    </div>
  );
}

function Figure({ label, value, rank }: { label: string; value: string; rank?: Rank | null }) {
  return (
    <div>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className="m-0 mt-0.5 font-mono text-2xl font-semibold text-white">{value}</dd>
      {rank !== undefined ? <dd className="m-0 mt-0.5 text-xs text-peach">{rank ? rankLabel(rank) : 'Pas de rang'}</dd> : null}
    </div>
  );
}

function StatsSections({ model }: { model: Model }) {
  const stats = useQuery({ queryKey: modelStatsKey(model.id), queryFn: () => getModelStats(model.id), retry: false });
  if (stats.isError) {
    return (
      <p role="alert" className="m-0 text-sm text-bad min-[800px]:col-span-2">
        {messageForError(stats.error)}
      </p>
    );
  }
  if (stats.isPending) return <p className="m-0 text-sm text-mute min-[800px]:col-span-2">Chargement des mesures…</p>;
  const s: ModelStats = stats.data;
  if (s.history.length === 0) {
    return (
      <>
        <EmptySection title="Chiffres clés" />
        <EmptySection title="Radar par catégorie" />
        <div className="min-[800px]:col-span-2">
          <EmptySection title="Historique des séries" />
        </div>
      </>
    );
  }
  return (
    <>
      <Card>
        <h2 className="m-0 mb-3 font-display text-lg font-bold text-white">Chiffres clés</h2>
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-5">
          <Figure label="Qualité moyenne" value={s.quality === null ? '—' : `${score(s.quality)} / 100`} />
          <Figure label="Fiabilité" value={reliabilityPercent(s.reliability)} />
          <Figure label="Premier token médian" value={ttft(s.medianTtftMs)} rank={s.ttftRank} />
          <Figure label="Débit médian" value={tokensPerSecond(s.medianTokensPerS)} rank={s.tpsRank} />
        </dl>
      </Card>
      <Card>
        <h2 className="m-0 mb-1 font-display text-lg font-bold text-white">
          Radar par catégorie <small className="font-sans text-xs font-normal text-mute">contre la moyenne des modèles</small>
        </h2>
        {s.radar.length === 0 ? (
          <p className="mt-3 mb-0 text-sm text-mute">Pas encore de note par catégorie.</p>
        ) : (
          <Suspense fallback={<p className="text-sm text-mute">Chargement du radar…</p>}>
            <ModelRadar radar={s.radar} color={model.color} modelName={model.displayName} />
          </Suspense>
        )}
      </Card>
      <Card className="min-[800px]:col-span-2">
        <h2 className="m-0 mb-3 font-display text-lg font-bold text-white">Historique des séries</h2>
        <div className="overflow-x-auto">
          <table className="table-sticky-first w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-mute">
                <th className="py-1.5 pr-3 font-medium">Série</th>
                <th className="py-1.5 pr-3 pl-4 font-medium whitespace-nowrap">Terminée le</th>
                <th className="py-1.5 pr-3 text-right font-medium">Rang</th>
                <th className="py-1.5 pr-3 text-right font-medium">Qualité</th>
                <th className="py-1.5 text-right font-medium">Score global</th>
              </tr>
            </thead>
            <tbody>
              {s.history.map((h) => (
                <tr key={h.runId} className="border-t border-line">
                  <td className="py-2 pr-3">
                    <Link to={`/series/${h.runId}`} className="text-sky no-underline hover:underline">
                      {h.runName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 pl-4 whitespace-nowrap text-mute">{new Date(h.completedAt).toLocaleDateString('fr-FR')}</td>
                  <td className="py-2 pr-3 text-right font-mono font-semibold text-peach">{h.rank === null ? '—' : `${h.rank} / ${h.of}`}</td>
                  <td className="py-2 pr-3 text-right font-mono text-white">{score(h.quality)}</td>
                  <td className="py-2 text-right font-mono text-white">{score(h.global)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function EmptySection({ title }: { title: string }) {
  return (
    <Card>
      <h2 className="m-0 font-display text-lg font-bold text-white">{title}</h2>
      <p className="mt-3 mb-0 text-sm text-mute">{EMPTY_SERIES}</p>
    </Card>
  );
}

/** Corps de PATCH : seuls les champs modifiés partent (un prix modifié fait passer la source sur « saisi » côté serveur). */
function patchFrom(model: Model, draft: ModelDraft, enabled: boolean): ModelPatch {
  const patch: ModelPatch = {};
  const before = draftFromModel(model);
  if (draft.displayName.trim() !== before.displayName) patch.displayName = draft.displayName.trim();
  if (draft.color !== before.color) patch.color = draft.color;
  const input = parsePrice(draft.inputPricePerM);
  const output = parsePrice(draft.outputPricePerM);
  if (input !== null && input !== model.inputPricePerM) patch.inputPricePerM = input;
  if (output !== null && output !== model.outputPricePerM) patch.outputPricePerM = output;
  if (draft.supportsVision !== before.supportsVision) patch.supportsVision = draft.supportsVision;
  if (draft.supportsPdf !== before.supportsPdf) patch.supportsPdf = draft.supportsPdf;
  if (draft.contextWindow !== before.contextWindow) {
    const n = Number(draft.contextWindow.trim().replace(',', '.'));
    if (draft.contextWindow.trim() === '') patch.contextWindow = null;
    else if (Number.isFinite(n)) patch.contextWindow = Math.round(n);
  }
  if (enabled !== model.enabled) patch.enabled = enabled;
  return patch;
}

function EditPanel({ model, onDone }: { model: Model; onDone(): void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => draftFromModel(model));
  const [enabled, setEnabled] = useState(model.enabled);
  const save = useMutation({
    mutationFn: async () => {
      const patch = patchFrom(model, draft, enabled);
      if (Object.keys(patch).length > 0) await updateModel(model.id, patch);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: MODELS_KEY });
      onDone();
    },
  });

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="m-0 font-display text-lg font-bold text-white">Modifier le modèle</h2>
      <ModelForm providerId={model.providerId} value={draft} onChange={setDraft} />
      <div className="flex items-center gap-2">
        <label htmlFor="model-enabled" className="text-[13px] text-ink">
          Actif
        </label>
        <Switch.Root
          id="model-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-line-strong bg-night-2 data-[state=checked]:border-orange data-[state=checked]:bg-orange"
        >
          <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px]" />
        </Switch.Root>
      </div>
      {save.isError ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {messageForError(save.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" disabled={save.isPending || !hasValidPrices(draft) || draft.displayName.trim() === ''} onClick={() => save.mutate()}>
          Enregistrer
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </Card>
  );
}

function ModelDetail({ model, isAdmin }: { model: Model; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const price = (n: number) => `${formatNumber(n)} $`;

  return (
    <>
      <header className="mb-5 flex flex-wrap items-center gap-4">
        <span
          aria-hidden="true"
          className="h-[54px] w-[54px] shrink-0 rounded-2xl"
          style={{ background: `radial-gradient(circle at 30% 30%, #ffffff66, ${model.color} 55%)`, boxShadow: `0 0 30px ${model.color}66` }}
        />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">{model.displayName}</h1>
          <p className="mt-1.5 mb-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-mute">
            <span>{model.providerName}</span>
            <code className="font-mono text-xs text-ink">{model.apiModelId}</code>
            {!model.enabled ? <Chip>Désactivé</Chip> : null}
          </p>
        </div>
        {isAdmin && !editing ? <Button onClick={() => setEditing(true)}>Modifier</Button> : null}
      </header>

      {editing ? (
        <div className="mb-4">
          <EditPanel model={model} onDone={() => setEditing(false)} />
        </div>
      ) : null}

      <div className="mb-4 grid gap-4 min-[800px]:grid-cols-3">
        <Card>
          <h2 className="m-0 mb-3 font-display text-lg font-bold text-white">Prix</h2>
          <dl className="m-0 grid grid-cols-2 gap-3">
            <Stat label="Entrée, par million">{price(model.inputPricePerM)}</Stat>
            <Stat label="Sortie, par million">{price(model.outputPricePerM)}</Stat>
          </dl>
          <p className="mt-3 mb-0 text-xs text-mute">
            Source : <span className="text-ink">{model.priceSource === 'openrouter' ? 'OpenRouter' : 'Saisi'}</span>
          </p>
        </Card>
        <Card>
          <h2 className="m-0 mb-3 font-display text-lg font-bold text-white">Capacités</h2>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Chip tone={model.supportsVision ? 'good' : 'default'}>{model.supportsVision ? 'Vision' : 'Pas de vision'}</Chip>
            <Chip tone={model.supportsPdf ? 'good' : 'default'}>{model.supportsPdf ? 'PDF' : 'Pas de PDF'}</Chip>
          </div>
          <p className="m-0 text-xs text-mute">
            Contexte : <span className="text-ink">{model.contextWindow === null ? 'inconnu' : `${formatNumber(model.contextWindow)} tokens`}</span>
          </p>
        </Card>
        <Card>
          <h2 className="m-0 mb-3 font-display text-lg font-bold text-white">Clé</h2>
          <KeyChip provider={model.provider} isAdmin={isAdmin} />
          <p className="mt-3 mb-0 text-xs text-mute">
            {model.available ? 'Le modèle est disponible pour les comparaisons.' : 'Le modèle n’est pas disponible pour le moment.'}
          </p>
        </Card>
      </div>

      <div className="grid gap-4 min-[800px]:grid-cols-2">
        <StatsSections model={model} />
      </div>
    </>
  );
}

/** Fiche d'un modèle : identité, prix, capacités, état de la clé ; l'Admin peut modifier. */
export function ModelPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const model = useQuery({ queryKey: [...MODELS_KEY, id], queryFn: () => getModel(id), retry: false });
  const notFound = model.error instanceof ApiError && model.error.status === 404;

  return (
    <div className="mx-auto max-w-[1100px]">
      <p className="m-0 mb-3 text-sm">
        <Link to="/modeles" className="text-sky no-underline hover:underline">
          Modèles
        </Link>
      </p>
      {model.isError ? (
        notFound ? (
          <Card className="py-10 text-center">
            <p className="m-0 text-sm text-ink">Modèle introuvable</p>
            <p className="mt-1 mb-0 text-xs text-mute">Il a peut-être été désactivé ou retiré du catalogue.</p>
          </Card>
        ) : (
          <p role="alert" className="text-sm text-bad">
            {messageForError(model.error)}
          </p>
        )
      ) : model.isPending ? (
        <p className="text-sm text-mute">Chargement du modèle…</p>
      ) : (
        <ModelDetail model={model.data} isAdmin={user?.role === 'admin'} />
      )}
    </div>
  );
}
