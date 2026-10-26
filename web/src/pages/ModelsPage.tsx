import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MODELS_KEY, PROVIDERS_KEY, listModels, listProviders, type PublicModel, type PublicProvider } from '../api/catalog';
import { messageForError } from '../api/messages';
import { useAuth } from '../auth/AuthProvider';
import { formatContextShort, formatPricePair } from '../components/catalog/format';
import { CapabilitiesBulkDialog } from '../components/catalog/CapabilitiesBulkDialog';
import { PricesUpdateDialog } from '../components/catalog/PricesUpdateDialog';
import { RemoteModelsDialog } from '../components/catalog/RemoteModelsDialog';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { HelpButton } from '../components/ui/HelpButton';
import { InfoTip } from '../components/ui/InfoTip';
import { SelectField } from '../components/ui/SelectField';

type SortKey = 'name' | 'provider';
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Modèles triés par nom, ou par fournisseur puis nom ; ordre alphabétique français (accents, nombres). */
export function sortModels(models: PublicModel[], key: SortKey, dir: 'asc' | 'desc'): PublicModel[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...models].sort((a, b) => {
    const primary = key === 'provider' ? collator.compare(a.providerName, b.providerName) : 0;
    return sign * (primary || collator.compare(a.displayName, b.displayName));
  });
}

function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <span aria-label={`${label} : ${on ? 'oui' : 'non'}`} className={on ? 'text-good' : 'text-mute'}>
      {on ? '✓' : '–'}
    </span>
  );
}

/** Pourquoi un fournisseur ne peut pas être interrogé, ou `null` s'il le peut. */
function unusableReason(p: PublicProvider): string | null {
  if (!p.enabled) return 'désactivé';
  if (!p.usable) return p.keyState === 'unreadable' ? 'clé illisible' : 'clé manquante';
  return null;
}

/** Assistant d'ajout (Admin) : le fournisseur à interroger se choisit dans la fenêtre même. */
function AddModels() {
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: listProviders });
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState('');

  const list = providers.data ?? [];
  const chosen = list.find((p) => p.id === providerId && unusableReason(p) === null);
  const anyUsable = list.some((p) => unusableReason(p) === null);

  function change(next: boolean) {
    setOpen(next);
    if (!next) setProviderId('');
  }

  const picker = (
    <div className="flex flex-col gap-2">
      <SelectField
        label="Fournisseur à interroger"
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        options={[
          { value: '', label: anyUsable ? 'Choisir…' : 'Aucun fournisseur utilisable' },
          ...list.map((p) => {
            const reason = unusableReason(p);
            return { value: p.id, label: reason ? `${p.name} (${reason})` : p.name, disabled: reason !== null };
          }),
        ]}
      />
      <p className="m-0 text-xs text-mute">
        Un fournisseur manque (Ollama, serveur local, autre service compatible OpenAI) ? Ajoutez-le d&apos;abord dans{' '}
        <Link to="/admin/fournisseurs" className="text-peach underline">
          Fournisseurs
        </Link>
        .
      </p>
    </div>
  );

  return (
    <>
      <Button variant="primary" onClick={() => change(true)}>
        Ajouter des modèles
      </Button>
      {open ? (
        <RemoteModelsDialog providerId={chosen?.id ?? ''} providerBaseUrl={chosen?.baseUrl} open onOpenChange={change} providerPicker={picker} />
      ) : null}
    </>
  );
}

/** Catalogue des modèles : prix, capacités, disponibilité ; filtres par fournisseur. */
export function ModelsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });
  const [providerId, setProviderId] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pricing, setPricing] = useState(false);

  const all = models.data ?? [];
  const providerOptions = [...new Map(all.map((m) => [m.providerId, m.providerName])).entries()].map(([value, label]) => ({ value, label }));
  // Tri au clic sur « Modèle » ou « Fournisseur » : croissant, puis décroissant, puis ordre d'origine.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const filtered = all.filter((m) => (providerId === '' || m.providerId === providerId) && (!availableOnly || m.available));
  const rows = sort ? sortModels(filtered, sort.key, sort.dir) : filtered;
  const cycle = (key: SortKey) => setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const header = (key: SortKey, label: string) => {
    const active = sort?.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} className="px-4 py-3 font-medium">
        <button
          type="button"
          onClick={() => cycle(key)}
          title={active && sort.dir === 'desc' ? 'Revenir à l’ordre d’origine' : 'Trier'}
          className={`inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium ${active ? 'text-white' : 'text-mute hover:text-white'}`}
        >
          {label}
          <span aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
        </button>
      </th>
    );
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Modèles</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">Prix en dollars par million de tokens (entrée / sortie).</p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <HelpButton
              helpLabel="Vérifier les capacités"
              disabled={!rows.some((m) => m.available)}
              onClick={() => setChecking(true)}
              help="Interroge chaque modèle disponible parmi ceux affichés (filtre Fournisseur compris) par trois très petits appels réels : un message sans pièce jointe, une image et un PDF d’une page. Les colonnes Vision et PDF sont corrigées et enregistrées selon la réponse du fournisseur. Un résultat indéterminé ne change rien. Coût : quelques tokens par modèle."
            >
              Vérifier les capacités
            </HelpButton>
            <HelpButton
              helpLabel="Mettre à jour les tarifs"
              disabled={!rows.some((m) => m.available)}
              onClick={() => setPricing(true)}
              help="Relit la liste des modèles de chaque fournisseur (appel gratuit, sans tokens) pour les modèles disponibles affichés, puis montre le tarif actuel et le tarif annoncé. Seuls les changements cochés sont enregistrés. Les modèles OpenRouter suivis par la synchronisation quotidienne le restent."
            >
              Mettre à jour les tarifs
            </HelpButton>
            <AddModels />
          </div>
        ) : null}
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <SelectField label="Fournisseur" value={providerId} onChange={(e) => setProviderId(e.target.value)} options={[{ value: '', label: 'Tous' }, ...providerOptions]} />
        <div className="flex items-center gap-2 pb-2.5">
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} />
            Disponibles seulement
          </label>
          <InfoTip label="Disponibles seulement" width="w-80">
            Le catalogue garde aussi les modèles qu’on ne peut pas appeler en ce moment. « Disponible » veut dire : le modèle est activé, son
            fournisseur aussi, et la clé API du fournisseur est enregistrée et lisible. Les autres sont marqués « Indisponible » (ou
            « Désactivé ») et ne peuvent pas entrer dans une nouvelle série.
          </InfoTip>
        </div>
      </div>

      {isAdmin ? (
        <>
          <CapabilitiesBulkDialog models={rows.filter((m) => m.available)} open={checking} onOpenChange={setChecking} />
          <PricesUpdateDialog models={rows.filter((m) => m.available)} open={pricing} onOpenChange={setPricing} />
        </>
      ) : null}

      {models.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(models.error)}
        </p>
      ) : models.isPending ? (
        <p className="text-sm text-mute">Chargement des modèles…</p>
      ) : rows.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="m-0 text-sm text-mute">Aucun modèle ne correspond.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="table-sticky-first w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-mute">
                {header('name', 'Modèle')}
                {header('provider', 'Fournisseur')}
                <th className="px-4 py-3 font-medium">Prix $/M</th>
                <th className="px-4 py-3 text-center font-medium">Vision</th>
                <th className="px-4 py-3 text-center font-medium">PDF</th>
                <th className="px-4 py-3 font-medium">Contexte</th>
                <th className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2.5">
                      <span data-testid="swatch" aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                      <Link to={`/modeles/${m.id}`} className="font-semibold text-white no-underline hover:underline">
                        {m.displayName}
                      </Link>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink">{m.providerName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink">{formatPricePair(m.inputPricePerM, m.outputPricePerM)}</td>
                  <td className="px-4 py-3 text-center">
                    <Flag label="Vision" on={m.supportsVision} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Flag label="PDF" on={m.supportsPdf} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink">{formatContextShort(m.contextWindow)}</td>
                  <td className="px-4 py-3">
                    {m.available ? <Chip tone="good">Disponible</Chip> : <Chip tone="live">Indisponible</Chip>}
                    {!m.enabled ? <Chip className="ml-1.5">Désactivé</Chip> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
