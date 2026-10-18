import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MODELS_KEY, PROVIDERS_KEY, listModels, listProviders } from '../api/catalog';
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

function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <span aria-label={`${label} : ${on ? 'oui' : 'non'}`} className={on ? 'text-good' : 'text-mute'}>
      {on ? '✓' : '–'}
    </span>
  );
}

/** Choix du fournisseur puis assistant d'ajout (Admin). */
function AddModels() {
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: listProviders });
  const [picking, setPicking] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [open, setOpen] = useState(false);

  const usable = (providers.data ?? []).filter((p) => p.enabled && p.usable);
  const chosen = usable.find((p) => p.id === providerId);

  if (!picking) {
    return (
      <Button variant="primary" onClick={() => setPicking(true)}>
        Ajouter des modèles
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField
        label="Fournisseur à interroger"
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        options={[{ value: '', label: usable.length ? 'Choisir…' : 'Aucun fournisseur utilisable' }, ...usable.map((p) => ({ value: p.id, label: p.name }))]}
      />
      <Button variant="primary" disabled={!chosen} onClick={() => setOpen(true)}>
        Ouvrir l&apos;assistant
      </Button>
      <Button variant="ghost" onClick={() => setPicking(false)}>
        Annuler
      </Button>
      {open && chosen ? (
        <RemoteModelsDialog providerId={chosen.id} providerBaseUrl={chosen.baseUrl} open onOpenChange={(o) => !o && setOpen(false)} />
      ) : null}
    </div>
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
  const rows = all.filter((m) => (providerId === '' || m.providerId === providerId) && (!availableOnly || m.available));

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
                <th className="px-4 py-3 font-medium">Modèle</th>
                <th className="px-4 py-3 font-medium">Fournisseur</th>
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
