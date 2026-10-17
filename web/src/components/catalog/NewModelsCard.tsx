import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NEW_MODELS_KEY, PROVIDERS_KEY, dismissNewModel, listNewModels, listProviders, type NewModel } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { formatContextShort, formatDate, formatPricePair } from './format';
import { RemoteModelsDialog } from './RemoteModelsDialog';

function NewModelRow({ model, canAdd, onAdd }: { model: NewModel; canAdd: boolean; onAdd(): void }) {
  const client = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => dismissNewModel(model.id),
    onSettled: () => client.invalidateQueries({ queryKey: NEW_MODELS_KEY }),
  });
  const price = formatPricePair(model.inputPricePerM, model.outputPricePerM);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0 flex-1 basis-56">
        <p className="m-0 truncate text-sm font-semibold text-white">{model.name}</p>
        <p className="m-0 truncate font-mono text-xs text-mute">{model.openrouterId}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-ink">{price ?? 'Prix inconnu'}</span>
        {model.supportsVision ? <Chip>Vision</Chip> : null}
        {model.supportsPdf ? <Chip>PDF</Chip> : null}
        {model.contextWindow !== null ? <Chip>{formatContextShort(model.contextWindow)}</Chip> : null}
        <time dateTime={model.firstSeenAt} className="text-xs text-mute">
          {formatDate(model.firstSeenAt)}
        </time>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" disabled={!canAdd} onClick={onAdd} aria-label={`Ajouter ${model.name}`}>
          Ajouter
        </Button>
        <Button variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate()} aria-label={`Ignorer ${model.name}`}>
          Ignorer
        </Button>
      </div>
      {dismiss.isError ? (
        <p role="alert" className="m-0 basis-full text-xs text-bad">
          {messageForError(dismiss.error)}
        </p>
      ) : null}
    </li>
  );
}

function NewModelsList() {
  const fresh = useQuery({ queryKey: NEW_MODELS_KEY, queryFn: listNewModels });
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: listProviders });
  const [adding, setAdding] = useState<NewModel | null>(null);

  const openRouterId = fresh.data?.openRouterProviderId ?? null;
  const openRouter = providers.data?.find((p) => p.id === openRouterId);
  const canAdd = openRouter?.usable === true;

  return (
    <Card>
      <h2 className="m-0 font-display text-lg font-bold text-white">Nouveaux modèles sur OpenRouter</h2>
      {fresh.isError ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-bad">
          {messageForError(fresh.error)}
        </p>
      ) : fresh.isPending ? (
        <p className="mt-3 mb-0 text-sm text-mute">Chargement des nouveautés…</p>
      ) : fresh.data.models.length === 0 ? (
        <p className="mt-3 mb-0 text-sm text-mute">Rien de nouveau sur OpenRouter ces 30 derniers jours</p>
      ) : (
        <>
          {openRouterId === null ? (
            <p className="mt-2 mb-0 text-xs text-peach">
              Activez le fournisseur OpenRouter dans « Fournisseurs » pour ajouter ces modèles au catalogue.
            </p>
          ) : openRouter && !openRouter.usable ? (
            <p className="mt-2 mb-0 text-xs text-peach">
              La clé du fournisseur OpenRouter est manquante ou illisible : saisissez-la dans « Fournisseurs » pour ajouter ces modèles.
            </p>
          ) : null}
          <ul className="m-0 mt-2 list-none p-0">
            {fresh.data.models.map((m) => (
              <NewModelRow key={m.id} model={m} canAdd={canAdd} onAdd={() => setAdding(m)} />
            ))}
          </ul>
        </>
      )}
      {adding && openRouter ? (
        <RemoteModelsDialog
          providerId={openRouter.id}
          providerBaseUrl={openRouter.baseUrl}
          initialSearch={adding.openrouterId}
          open
          onOpenChange={(o) => !o && setAdding(null)}
        />
      ) : null}
    </Card>
  );
}

/** Nouveautés d'OpenRouter (Admin seulement : l'API est réservée à l'Admin, aucun appel pour un Utilisateur). */
export function NewModelsCard() {
  const { user } = useAuth();
  return user?.role === 'admin' ? <NewModelsList /> : null;
}
