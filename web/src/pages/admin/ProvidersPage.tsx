import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Switch from '@radix-ui/react-switch';
import { useState } from 'react';
import {
  PROVIDERS_KEY,
  listProviders,
  testProvider,
  updateProvider,
  type ConnectionTest,
  type ProviderType,
  type PublicProvider,
} from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { ApiKeyDialog } from '../../components/catalog/ApiKeyDialog';
import { ProviderDialog } from '../../components/catalog/ProviderDialog';
import { RemoteModelsDialog } from '../../components/catalog/RemoteModelsDialog';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { logoFor } from '../../lib/providers';
import { DefaultJudgeCard } from './DefaultJudgeCard';

const TYPE_LABEL: Record<ProviderType, string> = {
  openai_compatible: 'Compatible OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
};

function ProviderLogo({ name }: { name: string }) {
  const src = logoFor(name);
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-night-0/60">
      {src ? (
        <img src={src} alt="" className="h-6 w-6 object-contain" />
      ) : (
        <span className="font-display text-base font-bold text-sky">{name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

function KeyChip({ provider }: { provider: PublicProvider }) {
  if (provider.keyState === 'stored') {
    return (
      <Chip tone="good">
        Clé enregistrée <span className="text-white">{provider.keyLast4 ? `…${provider.keyLast4}` : ''}</span>
      </Chip>
    );
  }
  if (provider.keyState === 'unreadable') return <Chip tone="bad">Clé illisible</Chip>;
  return <Chip tone="live">Clé manquante</Chip>;
}

type Dialogs = 'key' | 'edit' | 'models' | null;

function ProviderCard({ provider }: { provider: PublicProvider }) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateProvider(provider.id, { enabled }),
    onMutate: () => setError(null),
    onError: (err) => setError(messageForError(err)),
    onSettled: () => client.invalidateQueries({ queryKey: PROVIDERS_KEY }),
  });
  const test = useMutation<ConnectionTest>({
    gcTime: 0,
    mutationFn: () => testProvider(provider.id),
  });

  const hasKey = provider.keyState !== 'missing';
  const switchId = `enabled-${provider.id}`;

  return (
    <section aria-label={provider.name}>
      <Card className={`flex h-full flex-col gap-4 ${provider.enabled ? '' : 'opacity-70'}`}>
        <div className="flex items-start gap-3">
          <ProviderLogo name={provider.name} />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 font-display text-lg leading-tight font-bold text-white">{provider.name}</h2>
            <p className="m-0 text-xs text-mute">{TYPE_LABEL[provider.type]}</p>
            <p className="m-0 mt-1 truncate font-mono text-xs text-mute" title={provider.baseUrl}>
              {provider.baseUrl}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={switchId} className="text-xs text-mute">
              {provider.enabled ? 'Actif' : 'Inactif'}
            </label>
            <Switch.Root
              id={switchId}
              checked={provider.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(on) => toggle.mutate(on)}
              className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-line-strong bg-night-2 data-[state=checked]:border-orange data-[state=checked]:bg-orange"
            >
              <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px]" />
            </Switch.Root>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <KeyChip provider={provider} />
          {provider.fake ? <Chip tone="live">Faux fournisseur</Chip> : null}
          <Chip>
            {provider.modelCount} {provider.modelCount > 1 ? 'modèles' : 'modèle'}
          </Chip>
          <Chip>{provider.maxConcurrency} en parallèle</Chip>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!provider.usable || test.isPending} onClick={() => test.mutate()}>
            Tester la connexion
          </Button>
          <Button variant="secondary" disabled={!provider.usable} onClick={() => setDialog('models')}>
            Interroger /models
          </Button>
          <Button variant={hasKey ? 'secondary' : 'primary'} onClick={() => setDialog('key')}>
            {hasKey ? 'Remplacer la clé' : 'Saisir la clé'}
          </Button>
          <Button variant="ghost" onClick={() => setDialog('edit')}>
            Modifier
          </Button>
        </div>

        <div aria-live="polite" className="min-h-0 text-sm">
          {test.isPending ? <span className="text-mute">Test en cours…</span> : null}
          {test.isError ? <span className="text-bad">{messageForError(test.error)}</span> : null}
          {test.data?.ok === true ? (
            <span className="text-good">
              Connexion réussie · {test.data.modelCount} {test.data.modelCount > 1 ? 'modèles' : 'modèle'}
            </span>
          ) : null}
          {test.data?.ok === false ? <span className="text-bad">{test.data.message}</span> : null}
          {error ? <span className="text-bad">{error}</span> : null}
        </div>
      </Card>

      {dialog === 'key' ? (
        <ApiKeyDialog
          providerId={provider.id}
          providerName={provider.name}
          hasKey={hasKey}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      ) : null}
      {dialog === 'edit' ? <ProviderDialog provider={provider} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'models' ? <RemoteModelsDialog providerId={provider.id} providerBaseUrl={provider.baseUrl} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </section>
  );
}

/** Fournisseurs (Admin) : état des clés, test de connexion, ajout de modèles depuis `/models`. */
export function ProvidersPage() {
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: listProviders });
  const [adding, setAdding] = useState(false);

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Fournisseurs</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
            Les clés sont chiffrées dans la base avec la clé maîtresse du serveur ; seuls leurs 4 derniers caractères sont affichés.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Ajouter un fournisseur
        </Button>
      </header>

      <DefaultJudgeCard />

      {providers.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(providers.error)}
        </p>
      ) : providers.isPending ? (
        <p className="text-sm text-mute">Chargement des fournisseurs…</p>
      ) : (
        <div className="grid gap-4 min-[900px]:grid-cols-2">
          {providers.data.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      )}

      {adding ? <ProviderDialog open onOpenChange={(o) => !o && setAdding(false)} /> : null}
    </div>
  );
}
