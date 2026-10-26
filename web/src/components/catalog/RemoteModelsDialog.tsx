import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { MODELS_KEY, PROVIDERS_KEY, createModel, listRemoteModels, type RemoteModelView } from '../../api/catalog';
import { ApiError } from '../../api/client';
import { messageForError } from '../../api/messages';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { ModelForm, draftFromRemote, draftToInput, emptyDraft, hasValidPrices, parsePrice, type ModelDraft } from './ModelForm';

type Props = {
  /** Vide : aucun fournisseur choisi, rien n'est interrogé (le choix se fait dans `providerPicker`). */
  providerId: string;
  providerBaseUrl?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  initialSearch?: string;
  /** Choix du fournisseur affiché en tête de la fenêtre ; changer de fournisseur repart d'une liste vierge. */
  providerPicker?: ReactNode;
};

type PanelProps = Pick<Props, 'providerId' | 'providerBaseUrl' | 'initialSearch'> & { close(): void };

type Entry = {
  key: string;
  draft: ModelDraft;
  manual: boolean;
  /** Prix fournis par le fournisseur (les deux connus) : sert à savoir si l'Admin les a modifiés. */
  remote: { input: number; output: number } | null;
};

/** Même critère que le serveur (`isOpenRouter`) : seul l'hôte openrouter.ai alimente la synchronisation des prix. */
function isOpenRouter(baseUrl: string | undefined): boolean {
  try {
    return baseUrl !== undefined && new URL(baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** `openrouter` seulement si le fournisseur est OpenRouter et que les deux prix sont ceux d'origine, inchangés. */
function priceSourceFor(entry: Entry, openRouter: boolean) {
  if (!openRouter || !entry.remote) return undefined;
  const input = parsePrice(entry.draft.inputPricePerM);
  const output = parsePrice(entry.draft.outputPricePerM);
  return input === entry.remote.input && output === entry.remote.output ? ('openrouter' as const) : undefined;
}

/** Message d'une erreur : celui du fournisseur quand c'est lui qui refuse, sinon le texte français du code. */
function describe(err: unknown): string {
  return err instanceof ApiError && err.code === 'provider_error' ? err.message : messageForError(err);
}

/** Assistant d'ajout : interroge `/models` du fournisseur, filtre, puis crée les modèles cochés un par un. */
export function RemoteModelsDialog({ providerId, providerBaseUrl, open, onOpenChange, initialSearch, providerPicker }: Props) {
  const close = () => onOpenChange(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="Ajouter des modèles"
      description={
        providerPicker
          ? 'Choisissez le fournisseur à interroger, cochez les modèles à ajouter au catalogue, puis vérifiez leur nom, leurs prix et leurs capacités.'
          : 'Cochez les modèles à ajouter au catalogue, puis vérifiez leur nom, leurs prix et leurs capacités.'
      }
    >
      {providerPicker ? <div className="mb-4">{providerPicker}</div> : null}
      {providerId ? (
        <RemoteModelsPanel key={providerId} providerId={providerId} providerBaseUrl={providerBaseUrl} initialSearch={initialSearch} close={close} />
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={close}>
            Fermer
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/** Liste des modèles d'un fournisseur et formulaires des modèles cochés. */
function RemoteModelsPanel({ providerId, providerBaseUrl, initialSearch = '', close }: PanelProps) {
  const client = useQueryClient();
  const remote = useQuery({
    queryKey: ['providers', providerId, 'remote-models'],
    queryFn: () => listRemoteModels(providerId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const [search, setSearch] = useState(initialSearch);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [manualCount, setManualCount] = useState(0);

  const models = remote.data ?? [];
  const term = search.trim().toLowerCase();
  const visible = term === '' ? models : models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(term));
  const find = (key: string) => entries.find((e) => e.key === key);

  function toggle(m: RemoteModelView, checked: boolean) {
    setEntries((list) =>
      checked ? [...list, {
              key: m.id,
              draft: draftFromRemote(m, list.length, providerBaseUrl),
              manual: false,
              remote:
                m.inputPricePerM !== null && m.outputPricePerM !== null ? { input: m.inputPricePerM, output: m.outputPricePerM } : null,
            }] : list.filter((e) => e.key !== m.id),
    );
  }

  function addManual() {
    setEntries((list) => [...list, { key: `manual-${manualCount}`, draft: emptyDraft(list.length, providerBaseUrl), manual: true, remote: null }]);
    setManualCount((n) => n + 1);
  }

  function edit(key: string, draft: ModelDraft) {
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, draft } : e)));
  }

  async function submit() {
    setBusy(true);
    const next: Record<string, string> = {};
    const done = new Set<string>();
    for (const entry of entries) {
      try {
        await createModel(draftToInput(providerId, entry.draft, priceSourceFor(entry, isOpenRouter(providerBaseUrl))));
        done.add(entry.key);
      } catch (err) {
        next[entry.key] = describe(err);
      }
    }
    setErrors(next);
    setEntries((list) => list.filter((e) => !done.has(e.key)));
    setBusy(false);
    if (done.size > 0) {
      void client.invalidateQueries({ queryKey: MODELS_KEY });
      void client.invalidateQueries({ queryKey: PROVIDERS_KEY });
      void remote.refetch(); // les modèles tout juste ajoutés passent en « déjà ajouté »
    }
    if (done.size > 0 && Object.keys(next).length === 0) close();
  }

  const count = entries.length;
  const manualEntries = entries.filter((e) => e.manual);

  return (
    <>
      <div className="-mx-2 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-2">
        {remote.isError ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="m-0 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {describe(remote.error)}
            </p>
            <p className="m-0 text-xs text-mute">
              La liste n&apos;a pas pu être récupérée. Vous pouvez saisir le modèle vous-même avec son identifiant d&apos;API.
            </p>
          </div>
        ) : remote.isPending ? (
          <p className="m-0 text-sm text-mute">Interrogation du fournisseur…</p>
        ) : (
          <>
            <input
              type="search"
              aria-label="Filtrer les modèles"
              placeholder="Filtrer par nom ou identifiant"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 text-sm text-white placeholder:text-mute/70"
            />
            {visible.length === 0 ? (
              <p className="m-0 text-sm text-mute">Aucun modèle ne correspond à « {search} ».</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {visible.map((m) => {
                  const entry = find(m.id);
                  return (
                    <li key={m.id} className={`rounded-xl border border-line p-3 ${m.alreadyAdded ? 'opacity-50' : ''}`}>
                      <label className="flex items-center gap-3 text-sm text-ink">
                        <input
                          type="checkbox"
                          disabled={m.alreadyAdded || busy}
                          checked={entry !== undefined}
                          onChange={(e) => toggle(m, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <b className="font-semibold text-white">{m.name}</b>
                          <span className="block truncate font-mono text-xs text-mute">{m.id}</span>
                        </span>
                        {m.alreadyAdded ? <Chip>déjà ajouté</Chip> : null}
                      </label>
                      {entry ? (
                        <div className="mt-3">
                          <ModelForm providerId={providerId} value={entry.draft} onChange={(d) => edit(entry.key, d)} />
                        </div>
                      ) : null}
                      {errors[m.id] ? (
                        <p role="alert" className="m-0 mt-2 text-xs text-bad">
                          {errors[m.id]}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {manualEntries.map((entry) => (
          <div key={entry.key} className="rounded-xl border border-line p-3">
            <ModelForm idEditable providerId={providerId} providerBaseUrl={providerBaseUrl} value={entry.draft} onChange={(d) => edit(entry.key, d)} />
            {errors[entry.key] ? (
              <p role="alert" className="m-0 mt-2 text-xs text-bad">
                {errors[entry.key]}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {!remote.isPending ? (
          <Button variant="ghost" disabled={busy} onClick={addManual}>
            Ajouter un modèle à la main
          </Button>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button variant="ghost" onClick={close}>
            Fermer
          </Button>
          <Button variant="primary" disabled={busy || count === 0 || !entries.every((e) => hasValidPrices(e.draft))} onClick={() => void submit()}>
            {count > 1 ? `Ajouter ${count} modèles` : `Ajouter ${count} modèle`}
          </Button>
        </span>
      </div>
    </>
  );
}
