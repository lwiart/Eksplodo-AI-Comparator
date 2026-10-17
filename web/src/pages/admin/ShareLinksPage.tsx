import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { messageForError } from '../../api/messages';
import {
  SHARE_LINKS_KEY,
  deleteShareLink,
  listShareLinks,
  regenerateShareLink,
  shareUrl,
  updateShareLink,
  type ShareLink,
} from '../../api/sharing';
import { ShareDialog } from '../../components/sharing/ShareDialog';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { CopyLink } from '../../components/ui/CopyLink';
import { Dialog } from '../../components/ui/Dialog';
import { AuditUrlCard } from './AuditUrlCard';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
const ROW_BUTTON = 'px-3 py-1 text-xs';

type Confirm = { kind: 'regenerate' | 'delete'; link: ShareLink };
type Shown = { link: ShareLink; token: string };

/** Gestion des liens de partage (Admin) : état, vues, désactivation, nouveau jeton, suppression et URL « Audit gratuit ». */
export function ShareLinksPage() {
  const client = useQueryClient();
  const links = useQuery({ queryKey: SHARE_LINKS_KEY, queryFn: () => listShareLinks() });
  const [editing, setEditing] = useState<ShareLink | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: SHARE_LINKS_KEY });

  const toggle = useMutation({
    mutationFn: (l: ShareLink) =>
      updateShareLink(l.id, {
        title: l.title,
        intro: l.intro,
        verdicts: l.verdicts,
        showCosts: l.showCosts,
        showResponses: l.showResponses,
        active: !l.active,
      }),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(messageForError(err)),
    onSettled: refresh,
  });
  // gcTime 0 : le jeton en clair ne reste pas dans le cache après sa fenêtre.
  const regenerate = useMutation({
    gcTime: 0,
    mutationFn: (l: ShareLink) => regenerateShareLink(l.id),
    onMutate: () => setActionError(null),
    onSuccess: (issued) => setShown(issued),
    onError: (err) => setActionError(messageForError(err)),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (l: ShareLink) => deleteShareLink(l.id),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(messageForError(err)),
    onSettled: refresh,
  });
  const busy = toggle.isPending || regenerate.isPending || remove.isPending;
  const { reset: resetRegenerate } = regenerate;

  const closeShown = () => {
    setShown(null);
    resetRegenerate();
  };
  const confirmed = () => {
    if (!confirm) return;
    (confirm.kind === 'regenerate' ? regenerate : remove).mutate(confirm.link);
    setConfirm(null);
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5">
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Liens de partage</h1>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
          Chaque lien ouvre une page publique en lecture seule. Pour en créer un, ouvrez une série et choisissez « Partager ».
        </p>
      </header>

      <AuditUrlCard />

      {actionError ? (
        <p role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {actionError}
        </p>
      ) : null}

      <Card className="overflow-x-auto p-0">
        {links.isError ? (
          <p role="alert" className="m-4 text-sm text-bad">
            {messageForError(links.error)}
          </p>
        ) : links.isPending ? (
          <p className="m-4 text-sm text-mute">Chargement des liens…</p>
        ) : links.data.length === 0 ? (
          <p className="m-4 text-sm text-mute">
            Aucun lien pour le moment. Ouvrez une <Link to="/series" className="text-peach">série</Link> terminée et choisissez « Partager ».
          </p>
        ) : (
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <caption className="sr-only">Liens de partage</caption>
            <thead>
              <tr className="border-b border-line text-[12px] text-mute">
                <th scope="col" className="px-4 py-3 font-medium">Série</th>
                <th scope="col" className="px-4 py-3 font-medium">Titre</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Vues</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
                <th scope="col" className="px-4 py-3 font-medium">Créé le</th>
                <th scope="col" className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {links.data.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left font-semibold text-white">
                    <Link to={`/series/${l.runId}`} className="text-white no-underline hover:underline">
                      {l.runName}
                    </Link>
                  </th>
                  <td className="px-4 py-3 text-ink">{l.title}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-ink">{l.viewCount}</td>
                  <td className="px-4 py-3">
                    <Chip tone={l.active ? 'good' : 'default'}>{l.active ? 'Actif' : 'Désactivé'}</Chip>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-mute">{dateFormat.format(new Date(l.createdAt))}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button className={ROW_BUTTON} disabled={busy} onClick={() => setEditing(l)}>
                        Modifier<span className="sr-only"> : {l.title}</span>
                      </Button>
                      <Button className={ROW_BUTTON} disabled={busy} onClick={() => toggle.mutate(l)}>
                        {l.active ? 'Désactiver' : 'Réactiver'}
                        <span className="sr-only"> : {l.title}</span>
                      </Button>
                      <Button className={ROW_BUTTON} disabled={busy} onClick={() => setConfirm({ kind: 'regenerate', link: l })}>
                        Régénérer le lien<span className="sr-only"> : {l.title}</span>
                      </Button>
                      <Button variant="danger" className={ROW_BUTTON} disabled={busy} onClick={() => setConfirm({ kind: 'delete', link: l })}>
                        Supprimer<span className="sr-only"> : {l.title}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing ? <ShareDialog open runId={editing.runId} runName={editing.runName} link={editing} onClose={() => setEditing(null)} /> : null}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.kind === 'delete' ? 'Supprimer ce lien ?' : 'Régénérer ce lien ?'}
        description={confirm ? `« ${confirm.link.title} », série ${confirm.link.runName}.` : undefined}
      >
        {confirm ? (
          <div className="flex flex-col gap-4">
            <p className="m-0 text-sm text-ink">
              {confirm.kind === 'delete'
                ? 'La page publique cessera de répondre et le lien ne pourra pas être rétabli.'
                : 'L’ancien lien cessera aussitôt de fonctionner. Le nouveau ne sera affiché qu’une fois.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Annuler
              </Button>
              <Button variant={confirm.kind === 'delete' ? 'danger' : 'primary'} onClick={confirmed}>
                {confirm.kind === 'delete' ? 'Supprimer le lien' : 'Régénérer le lien'}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={shown !== null}
        onOpenChange={(open) => !open && closeShown()}
        title="Nouveau lien de partage"
        description={shown ? `« ${shown.link.title} » : l’ancien lien ne fonctionne plus.` : undefined}
      >
        {shown ? (
          <div className="flex flex-col gap-3">
            <CopyLink url={shareUrl(shown.token)} label="Lien de la page publique" />
            <p className="m-0 text-sm font-semibold text-peach">Ce lien ne sera plus affiché : copiez-le maintenant.</p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={closeShown}>
                Fermer
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
