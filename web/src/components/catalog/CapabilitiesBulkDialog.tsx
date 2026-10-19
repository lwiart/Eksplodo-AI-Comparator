import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MODELS_KEY, checkCapabilities, updateModel, type CapabilityCheck, type CapabilityResult, type PublicModel } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

/** Vérifications menées en même temps : assez pour aller vite, sans saturer les limites des fournisseurs. */
export const BULK_CONCURRENCY = 3;

type RowState =
  | { status: 'waiting' }
  | { status: 'running' }
  | { status: 'done'; check: CapabilityCheck; vision: boolean; pdf: boolean; context: number | null; changed: boolean }
  | { status: 'failed'; message: string };

type Phase = 'ready' | 'running' | 'finished';

const tone = (r: CapabilityResult) => (r.supported === true ? 'text-good' : r.supported === false ? 'text-bad' : 'text-mute');

/** Case après vérification, avec l'ancienne valeur quand elle a changé. */
const tokens = (n: number | null) => (n === null ? 'inconnu' : n.toLocaleString('fr-FR'));

/** Fenêtre de contexte après vérification, avec l'ancienne valeur quand elle a changé. */
function ContextCell({ before, after }: { before: number | null; after: number | null }) {
  const changed = before !== after;
  return (
    <span
      aria-label={changed ? `Contexte : ${tokens(after)} tokens, était ${tokens(before)}` : `Contexte : ${tokens(after)}${after === null ? '' : ' tokens'}`}
      className={after === null ? 'text-mute' : 'text-ink'}
    >
      {after === null ? '–' : tokens(after)}
      {changed && before !== null ? <span className="ml-1 text-[11px] text-mute line-through">{tokens(before)}</span> : null}
    </span>
  );
}

function Flag({ label, before, after, result }: { label: string; before: boolean; after: boolean; result: CapabilityResult }) {
  const mark = (on: boolean) => (on ? '✓' : '–');
  const text = before === after ? `${label} : ${after ? 'oui' : 'non'}` : `${label} : ${after ? 'oui' : 'non'}, était ${before ? 'oui' : 'non'}`;
  return (
    <span aria-label={text} title={result.message} className={tone(result)}>
      {mark(after)}
      {before !== after ? <span className="ml-1 text-[11px] text-mute line-through">{mark(before)}</span> : null}
    </span>
  );
}

/**
 * Vérifie les capacités (image, PDF) de plusieurs modèles : trois tout petits appels réels par modèle. Les cases suivent la
 * réponse du fournisseur et sont enregistrées aussitôt ; un résultat indéterminé (clé, délai, indisponibilité) ne change rien.
 */
export function CapabilitiesBulkDialog({ models, open, onOpenChange }: { models: PublicModel[]; open: boolean; onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('ready');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Liste figée au lancement : un filtre changé pendant la vérification ne la modifie pas.
  const [targets, setTargets] = useState<PublicModel[]>([]);
  const list = phase === 'ready' ? models : targets;

  const setRow = (id: string, state: RowState) => setRows((prev) => ({ ...prev, [id]: state }));

  const checkOne = async (m: PublicModel) => {
    setRow(m.id, { status: 'running' });
    try {
      const check = await checkCapabilities(m.providerId, m.apiModelId);
      const vision = check.vision.supported ?? m.supportsVision;
      const pdf = check.pdf.supported ?? m.supportsPdf;
      // Fenêtre de contexte publiée par le fournisseur : elle remplace la valeur saisie ; absente, rien ne change.
      const context = check.contextWindow ?? m.contextWindow ?? null;
      const changed = vision !== m.supportsVision || pdf !== m.supportsPdf || context !== m.contextWindow;
      if (changed) {
        await updateModel(m.id, { supportsVision: vision, supportsPdf: pdf, ...(context === m.contextWindow ? {} : { contextWindow: context }) });
      }
      setRow(m.id, { status: 'done', check, vision, pdf, context, changed });
    } catch (err) {
      setRow(m.id, { status: 'failed', message: messageForError(err) });
    }
  };

  const run = async () => {
    const queue = [...models];
    setTargets(queue);
    setRows(Object.fromEntries(queue.map((m) => [m.id, { status: 'waiting' } as RowState])));
    setPhase('running');
    let next = 0;
    const worker = async () => {
      while (next < queue.length) await checkOne(queue[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, worker));
    await queryClient.invalidateQueries({ queryKey: MODELS_KEY });
    setPhase('finished');
  };

  const close = (o: boolean) => {
    if (o || phase === 'running') return; // pas d'interruption au milieu des enregistrements
    onOpenChange(false);
    setPhase('ready');
    setRows({});
  };

  const states = Object.values(rows);
  const updated = states.filter((r) => r.status === 'done' && r.changed).length;
  const unknown = states.filter((r) => r.status === 'done' && (r.check.vision.supported === null || r.check.pdf.supported === null)).length;
  const failed = states.filter((r) => r.status === 'failed').length;

  return (
    <Dialog open={open} onOpenChange={close} title="Vérifier les capacités des modèles" size="wide">
      <p className="mt-0 mb-3 text-sm text-ink">
        {list.length} modèle{list.length > 1 ? 's' : ''} disponible{list.length > 1 ? 's' : ''} parmi ceux affichés. Pour chacun, trois très petits
        appels réels (un message sans pièce jointe, une image de 32 × 32 pixels, un PDF d’une page) : les cases Vision et PDF suivent la réponse du
        fournisseur et sont enregistrées aussitôt. La fenêtre de contexte est lue dans la liste des modèles du fournisseur (sans coût) quand il la
        publie. Un résultat indéterminé (clé refusée, délai dépassé, fournisseur indisponible) ne change rien. Coût : quelques tokens par modèle.
      </p>

      {list.length === 0 ? (
        <p className="text-sm text-mute">Aucun modèle disponible à vérifier.</p>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-mute">
                <th className="px-3 py-2 font-medium">Modèle</th>
                <th className="px-3 py-2 text-center font-medium">Vision</th>
                <th className="px-3 py-2 text-center font-medium">PDF</th>
                <th className="px-3 py-2 text-right font-medium">Contexte</th>
                <th className="px-3 py-2 font-medium">Résultat</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const r = rows[m.id];
                return (
                  <tr key={m.id} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <span className="font-semibold text-white">{m.displayName}</span>
                      <span className="block text-xs text-mute">{m.providerName}</span>
                    </td>
                    {r?.status === 'done' ? (
                      <>
                        <td className="px-3 py-2 text-center">
                          <Flag label="Vision" before={m.supportsVision} after={r.vision} result={r.check.vision} />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Flag label="PDF" before={m.supportsPdf} after={r.pdf} result={r.check.pdf} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          <ContextCell before={m.contextWindow} after={r.context} />
                        </td>
                        <td className="px-3 py-2 text-xs [overflow-wrap:anywhere]">
                          <span className={r.changed ? 'text-orange-soft' : 'text-mute'}>{r.changed ? 'Mis à jour.' : 'Inchangé.'}</span>
                          {[r.check.vision, r.check.pdf]
                            .filter((c) => c.supported !== true)
                            .map((c) => (
                              <span key={c.message} className={`block ${tone(c)}`}>
                                {c.message}
                              </span>
                            ))}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-center text-mute">{m.supportsVision ? '✓' : '–'}</td>
                        <td className="px-3 py-2 text-center text-mute">{m.supportsPdf ? '✓' : '–'}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-mute">{m.contextWindow === null ? '–' : tokens(m.contextWindow)}</td>
                        <td className="px-3 py-2 text-xs">
                          {r?.status === 'running' ? (
                            <span className="text-ink">Vérification…</span>
                          ) : r?.status === 'failed' ? (
                            <span className="text-bad">Échec : {r.message}</span>
                          ) : r?.status === 'waiting' ? (
                            <span className="text-mute">En attente</span>
                          ) : null}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {phase === 'finished' ? (
        <p role="status" className="mt-3 mb-0 text-sm text-ink">
          {targets.length} vérifié{targets.length > 1 ? 's' : ''} : {updated} mis à jour
          {unknown ? `, ${unknown} en partie indéterminé${unknown > 1 ? 's' : ''}` : ''}
          {failed ? `, ${failed} en échec` : ''}.
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        {phase === 'finished' ? (
          <Button variant="primary" onClick={() => close(false)}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={phase === 'running'} onClick={() => close(false)}>
              Annuler
            </Button>
            <Button variant="primary" disabled={phase === 'running' || list.length === 0} onClick={() => void run()}>
              {phase === 'running' ? 'Vérification en cours…' : 'Lancer la vérification'}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
