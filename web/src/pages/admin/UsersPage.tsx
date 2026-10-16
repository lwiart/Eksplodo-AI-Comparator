import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { messageForError } from '../../api/messages';
import {
  USERS_KEY,
  inviteUser,
  issueReset,
  listUsers,
  regenerateInvite,
  updateUser,
  type IssuedLink,
  type MailStatus,
  type ManagedUser,
  type UserRole,
  type UserStatus,
} from '../../api/users';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { CopyLink } from '../../components/ui/CopyLink';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { SelectField } from '../../components/ui/SelectField';

const STATUS: Record<UserStatus, { label: string; tone: 'live' | 'good' | 'default' }> = {
  invited: { label: 'Invité', tone: 'live' },
  active: { label: 'Actif', tone: 'good' },
  disabled: { label: 'Désactivé', tone: 'default' },
};
const ROLE_LABEL: Record<UserRole, string> = { admin: 'Admin', user: 'Utilisateur' };
const ROLE_OPTIONS = [
  { value: 'user', label: 'Utilisateur' },
  { value: 'admin', label: 'Admin' },
];

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });

const MAIL_TEXT: Record<MailStatus, string> = {
  sent: 'Un e-mail contenant ce lien a été envoyé.',
  failed: "L'envoi de l'e-mail a échoué : transmettez le lien vous-même.",
  not_configured: 'E-mail non envoyé : SMTP non configuré. Transmettez le lien vous-même.',
};

type Shown = { kind: 'invite' | 'reset'; name: string; issued: IssuedLink };

const ROW_BUTTON = 'px-3 py-1 text-xs';

/** Gestion des comptes (Admin) : invitation, rôle, activation et liens à transmettre. */
export function UsersPage() {
  const client = useQueryClient();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: listUsers });
  const [inviting, setInviting] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: USERS_KEY });

  const patch = useMutation({
    mutationFn: (v: { id: string; patch: Parameters<typeof updateUser>[1] }) => updateUser(v.id, v.patch),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(messageForError(err)),
    onSettled: refresh,
  });
  // gcTime 0 : le résultat (qui contient le lien à usage unique) ne reste pas dans le cache après `reset()`.
  const link = useMutation({
    gcTime: 0,
    mutationFn: (v: { user: ManagedUser; kind: 'invite' | 'reset' }) =>
      v.kind === 'invite' ? regenerateInvite(v.user.id) : issueReset(v.user.id),
    onMutate: () => setActionError(null),
    onSuccess: (issued, v) => setShown({ kind: v.kind, name: v.user.name, issued }),
    onError: (err) => setActionError(messageForError(err)),
    onSettled: refresh,
  });
  const busy = patch.isPending || link.isPending;
  const { reset: resetLink } = link;
  // Le lien n'est montré qu'une fois : il ne survit pas à sa fenêtre (état local et résultat de la mutation).
  const closeShown = () => {
    setShown(null);
    resetLink();
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Utilisateurs</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
            Les comptes se créent sur invitation : le lien est à transmettre à la personne, il n&apos;est affiché qu&apos;une fois.
          </p>
        </div>
        <Button variant="primary" onClick={() => setInviting(true)}>
          Inviter
        </Button>
      </header>

      {actionError ? (
        <p role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {actionError}
        </p>
      ) : null}

      <Card className="overflow-x-auto p-0">
        {users.isError ? (
          <p role="alert" className="m-4 text-sm text-bad">
            {messageForError(users.error)}
          </p>
        ) : users.isPending ? (
          <p className="m-4 text-sm text-mute">Chargement des comptes…</p>
        ) : (
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <caption className="sr-only">Comptes utilisateurs</caption>
            <thead>
              <tr className="border-b border-line text-[12px] text-mute">
                <th scope="col" className="px-4 py-3 font-medium">Nom</th>
                <th scope="col" className="px-4 py-3 font-medium">E-mail</th>
                <th scope="col" className="px-4 py-3 font-medium">Rôle</th>
                <th scope="col" className="px-4 py-3 font-medium">Statut</th>
                <th scope="col" className="px-4 py-3 font-medium">Dernière connexion</th>
                <th scope="col" className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left font-semibold text-white">{u.name}</th>
                  <td className="px-4 py-3 text-ink">{u.email}</td>
                  <td className="px-4 py-3 text-ink">{ROLE_LABEL[u.role]}</td>
                  <td className="px-4 py-3">
                    <Chip tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Chip>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-mute">
                    {u.lastLoginAt ? dateFormat.format(new Date(u.lastLoginAt)) : 'Jamais'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        className={ROW_BUTTON}
                        disabled={busy}
                        onClick={() => patch.mutate({ id: u.id, patch: { role: u.role === 'admin' ? 'user' : 'admin' } })}
                      >
                        {u.role === 'admin' ? 'Passer Utilisateur' : 'Passer Admin'}
                        <span className="sr-only"> : {u.name}</span>
                      </Button>
                      {u.status === 'active' ? (
                        <Button variant="danger" className={ROW_BUTTON} disabled={busy} onClick={() => patch.mutate({ id: u.id, patch: { status: 'disabled' } })}>
                          Désactiver<span className="sr-only"> : {u.name}</span>
                        </Button>
                      ) : null}
                      {u.status === 'disabled' ? (
                        <Button className={ROW_BUTTON} disabled={busy} onClick={() => patch.mutate({ id: u.id, patch: { status: 'active' } })}>
                          Réactiver<span className="sr-only"> : {u.name}</span>
                        </Button>
                      ) : null}
                      {u.status === 'invited' ? (
                        <Button className={ROW_BUTTON} disabled={busy} onClick={() => link.mutate({ user: u, kind: 'invite' })}>
                          Régénérer le lien<span className="sr-only"> : {u.name}</span>
                        </Button>
                      ) : null}
                      {u.status === 'active' ? (
                        <Button className={ROW_BUTTON} disabled={busy} onClick={() => link.mutate({ user: u, kind: 'reset' })}>
                          Lien de réinitialisation<span className="sr-only"> : {u.name}</span>
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onIssued={(name, issued) => {
          setInviting(false);
          setShown({ kind: 'invite', name, issued });
          void refresh();
        }}
      />
      <Dialog
        open={shown !== null}
        onOpenChange={(open) => !open && closeShown()}
        title={shown?.kind === 'reset' ? 'Lien de réinitialisation' : "Lien d'invitation"}
        description={shown ? `Pour ${shown.name}.` : undefined}
      >
        {shown ? (
          <div className="flex flex-col gap-3">
            <CopyLink url={shown.issued.link} />
            <p className="m-0 text-sm font-semibold text-peach">Ce lien ne sera plus affiché : copiez-le maintenant.</p>
            <p className="m-0 text-xs text-mute">
              {MAIL_TEXT[shown.issued.mail]} Valable jusqu&apos;au {dateFormat.format(new Date(shown.issued.expiresAt))}, à usage unique.
            </p>
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

function InviteDialog({ open, onClose, onIssued }: { open: boolean; onClose(): void; onIssued(name: string, issued: IssuedLink): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setError(null);
    setName('');
    setEmail('');
    setRole('user');
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await inviteUser({ email: email.trim(), name: name.trim(), role });
      setName('');
      setEmail('');
      setRole('user');
      onIssued(res.user.name, res);
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Inviter un compte" description="La personne choisira son mot de passe en ouvrant le lien.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Nom" autoComplete="off" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="E-mail" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <SelectField label="Rôle" value={role} options={ROLE_OPTIONS} onChange={(e) => setRole(e.target.value as UserRole)} />
        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Annuler
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Envoyer l’invitation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
