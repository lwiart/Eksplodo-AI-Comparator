import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AuthLayout } from '../app/AuthLayout';
import { ApiError, apiFetch } from '../api/client';
import { messageForError } from '../api/messages';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { validateNewPassword } from './password-rules';

export function InvitationPage() {
  const { token = '' } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validateNewPassword(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/api/auth/invitations/accept', {
        method: 'POST',
        body: { token, password, ...(name.trim() ? { name: name.trim() } : {}) },
      });
      await refresh(); // la session est ouverte par l'acceptation : on charge l'utilisateur avant d'entrer
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invitation_invalid') setExpired(true);
      else setError(messageForError(err));
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <AuthLayout title="Ce lien n’est plus valable" intro="L’invitation a expiré ou a déjà été utilisée. Demandez-en une nouvelle à un administrateur.">
        <Link to="/connexion" className="text-sm font-semibold text-sky">
          Retour à la connexion
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Activer mon compte" intro="Choisissez votre nom et un mot de passe pour rejoindre Eksplodo.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Nom" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          hint="12 caractères minimum."
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="Confirmer le mot de passe"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={error}
        />
        <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full py-3">
          Activer mon compte
        </Button>
      </form>
    </AuthLayout>
  );
}
