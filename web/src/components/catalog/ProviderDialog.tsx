import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PROVIDERS_KEY, createProvider, updateProvider, type ProviderType, type PublicProvider } from '../../api/catalog';
import { messageForKeyError } from '../../api/messages';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { SelectField } from '../ui/SelectField';
import { KeyInput } from './ApiKeyDialog';

const TYPE_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: 'openai_compatible', label: 'Compatible OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google (Gemini)' },
];

type Props = { provider?: PublicProvider; open: boolean; onOpenChange(open: boolean): void };

/** Création ou modification d'un fournisseur (la clé se remplace dans sa propre fenêtre, sauf à la création). */
export function ProviderDialog({ provider, open, onOpenChange }: Props) {
  const client = useQueryClient();
  const [name, setName] = useState(provider?.name ?? '');
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai_compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [concurrency, setConcurrency] = useState(String(provider?.maxConcurrency ?? 2));
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  function close() {
    setApiKey('');
    setError(null);
    onOpenChange(false);
  }

  const save = useMutation({
    gcTime: 0, // la clé éventuelle ne reste pas dans le cache de TanStack
    mutationFn: () => {
      const base = { name: name.trim(), type, baseUrl: baseUrl.trim(), maxConcurrency: Number(concurrency) };
      if (provider) {
        const all = { ...base, enabled };
        const changed = Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== provider[k as keyof typeof all]));
        return Object.keys(changed).length === 0 ? Promise.resolve(null) : updateProvider(provider.id, changed);
      }
      const key = apiKey.trim();
      return createProvider({ ...base, ...(key !== '' ? { apiKey: key } : {}) });
    },
    onSettled: () => {
      setApiKey('');
      void client.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onSuccess: () => {
      if (!provider) {
        setName('');
        setBaseUrl('');
      }
      close();
    },
    onError: (err) => setError(messageForKeyError(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={provider ? `Modifier ${provider.name}` : 'Ajouter un fournisseur'}
      description="Une passerelle ou un service compatible avec l'API d'OpenAI se déclare avec le type « Compatible OpenAI »."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Nom" autoComplete="off" required value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField label="Type" value={type} options={TYPE_OPTIONS} onChange={(e) => setType(e.target.value as ProviderType)} />
        <Field
          label="URL de base"
          type="url"
          autoComplete="off"
          required
          placeholder="https://api.exemple.com/v1"
          hint={provider ? 'Changer l’hôte de l’URL efface la clé enregistrée : ressaisissez-la.' : undefined}
          className="font-mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Field
          label="Requêtes simultanées"
          type="number"
          min={1}
          max={10}
          required
          hint="Nombre maximal d'appels en parallèle vers ce fournisseur."
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
        />
        {provider ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Fournisseur actif
          </label>
        ) : (
          <KeyInput label="Clé API (facultative)" value={apiKey} onChange={setApiKey} />
        )}
        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Annuler
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {provider ? 'Enregistrer' : 'Ajouter'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
