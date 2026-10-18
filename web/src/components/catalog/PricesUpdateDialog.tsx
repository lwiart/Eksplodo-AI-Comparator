import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MODELS_KEY, listRemoteModels, updateModel, type PublicModel, type RemoteModelView } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { formatPricePair } from './format';

/** Tarif proposé pour un modèle, lu dans la liste de modèles de son fournisseur. */
type Proposal =
  | { kind: 'price'; input: number; output: number; changed: boolean }
  | { kind: 'missing'; reason: string };

type Phase = 'loading' | 'ready' | 'applying' | 'finished';

/** Tarifs proposés par fournisseur : un seul appel « liste des modèles » par fournisseur (gratuit, sans tokens). */
async function loadProposals(models: PublicModel[]): Promise<Record<string, Proposal>> {
  const providerIds = [...new Set(models.map((m) => m.providerId))];
  type Listing = { ok: true; list: RemoteModelView[] } | { ok: false; message: string };
  const lists = await Promise.all(
    providerIds.map(async (id): Promise<[string, Listing]> => {
      try {
        return [id, { ok: true, list: await listRemoteModels(id) }];
      } catch (err) {
        return [id, { ok: false, message: messageForError(err) }];
      }
    }),
  );
  const byProvider = new Map(lists);
  const out: Record<string, Proposal> = {};
  for (const m of models) {
    const res = byProvider.get(m.providerId)!;
    if (!res.ok) {
      out[m.id] = { kind: 'missing', reason: `Liste du fournisseur indisponible : ${res.message}` };
      continue;
    }
    const remote = res.list.find((r) => r.id === m.apiModelId);
    if (!remote) out[m.id] = { kind: 'missing', reason: 'Modèle absent de la liste du fournisseur.' };
    else if (remote.inputPricePerM === null || remote.outputPricePerM === null)
      out[m.id] = { kind: 'missing', reason: 'Tarif non communiqué par le fournisseur.' };
    else
      out[m.id] = {
        kind: 'price',
        input: remote.inputPricePerM,
        output: remote.outputPricePerM,
        changed: remote.inputPricePerM !== m.inputPricePerM || remote.outputPricePerM !== m.outputPricePerM,
      };
  }
  return out;
}

/**
 * Mise à jour des tarifs : relit la liste des modèles de chaque fournisseur, montre le tarif actuel et le tarif annoncé,
 * puis enregistre les changements cochés. Un modèle suivi par la synchronisation quotidienne OpenRouter le reste.
 */
export function PricesUpdateDialog({ models, open, onOpenChange }: { models: PublicModel[]; open: boolean; onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('loading');
  const [targets, setTargets] = useState<PublicModel[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(0);

  // Liste figée à l'ouverture : un filtre changé ensuite ne la modifie pas.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const list = [...models];
    setTargets(list);
    setPhase('loading');
    setFailures({});
    void loadProposals(list).then((p) => {
      if (cancelled) return;
      setProposals(p);
      setChecked(new Set(list.filter((m) => p[m.id]?.kind === 'price' && (p[m.id] as { changed: boolean }).changed).map((m) => m.id)));
      setPhase('ready');
    });
    return () => {
      cancelled = true;
    };
    // `models` n'est relu qu'à l'ouverture.
  }, [open]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    setPhase('applying');
    const errors: Record<string, string> = {};
    let ok = 0;
    for (const m of targets) {
      const p = proposals[m.id];
      if (!checked.has(m.id) || p?.kind !== 'price') continue;
      try {
        await updateModel(m.id, { inputPricePerM: p.input, outputPricePerM: p.output, priceSource: m.priceSource });
        ok++;
      } catch (err) {
        errors[m.id] = messageForError(err);
      }
    }
    setFailures(errors);
    setApplied(ok);
    await queryClient.invalidateQueries({ queryKey: MODELS_KEY });
    setPhase('finished');
  };

  const close = (o: boolean) => {
    if (o || phase === 'applying') return;
    onOpenChange(false);
  };

  const changedCount = targets.filter((m) => proposals[m.id]?.kind === 'price' && (proposals[m.id] as { changed: boolean }).changed).length;

  return (
    <Dialog open={open} onOpenChange={close} title="Mettre à jour les tarifs" size="wide">
      <p className="mt-0 mb-3 text-sm text-ink">
        Tarifs en dollars par million de tokens (entrée / sortie), lus dans la liste des modèles de chaque fournisseur (appel gratuit, sans
        tokens). Cochez les changements à enregistrer.
      </p>
      {phase === 'loading' ? (
        <p role="status" className="text-sm text-mute">
          Lecture des tarifs des fournisseurs…
        </p>
      ) : (
        <>
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-mute">
                  <th className="w-8 px-3 py-2 font-medium">
                    <span className="sr-only">Appliquer</span>
                  </th>
                  <th className="px-3 py-2 font-medium">Modèle</th>
                  <th className="px-3 py-2 font-medium">Actuel</th>
                  <th className="px-3 py-2 font-medium">Annoncé</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((m) => {
                  const p = proposals[m.id];
                  const current = formatPricePair(m.inputPricePerM, m.outputPricePerM);
                  return (
                    <tr key={m.id} className="border-t border-line align-top">
                      <td className="px-3 py-2">
                        {p?.kind === 'price' && p.changed ? (
                          <input
                            type="checkbox"
                            aria-label={`Appliquer le tarif annoncé à ${m.displayName}`}
                            checked={checked.has(m.id)}
                            disabled={phase !== 'ready'}
                            onChange={() => toggle(m.id)}
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-white">{m.displayName}</span>
                        <span className="block text-xs text-mute">{m.providerName}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-ink">{current}</td>
                      <td className="px-3 py-2 text-xs [overflow-wrap:anywhere]">
                        {p?.kind === 'price' ? (
                          <span className={`font-mono ${p.changed ? 'text-orange-soft' : 'text-mute'}`}>
                            {formatPricePair(p.input, p.output)}
                            {p.changed ? null : ' (inchangé)'}
                          </span>
                        ) : (
                          <span className="text-mute">{p?.reason}</span>
                        )}
                        {failures[m.id] ? <span className="block text-bad">Échec : {failures[m.id]}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p role="status" className="mt-3 mb-0 text-sm text-ink">
            {phase === 'finished'
              ? `${applied} tarif${applied > 1 ? 's' : ''} mis à jour${Object.keys(failures).length ? `, ${Object.keys(failures).length} en échec` : ''}.`
              : changedCount === 0
                ? 'Tous les tarifs connus sont à jour.'
                : `${changedCount} tarif${changedCount > 1 ? 's ont' : ' a'} changé chez le fournisseur.`}
          </p>
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {phase === 'finished' || (phase === 'ready' && changedCount === 0) ? (
          <Button variant="primary" onClick={() => close(false)}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={phase === 'applying'} onClick={() => close(false)}>
              Annuler
            </Button>
            <Button variant="primary" disabled={phase !== 'ready' || checked.size === 0} onClick={() => void apply()}>
              {phase === 'applying' ? 'Enregistrement…' : `Appliquer ${checked.size} changement${checked.size > 1 ? 's' : ''}`}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
