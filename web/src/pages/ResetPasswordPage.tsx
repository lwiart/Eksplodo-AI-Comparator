import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AuthLayout } from '../app/AuthLayout';
import { ApiError, apiFetch } from '../api/client';
import { messageForError } from '../api/messages';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { validateNewPassword } from './password-rules';

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
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
      await apiFetch('/api/auth/password/reset', { method: 'POST', body: { token, password } });
      navigate('/connexion', { replace: true, state: { notice: 'Mot de passe modifié. Vous pouvez vous connecter.' } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invitation_invalid') setExpired(true);
      else setError(messageForError(err));
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <AuthLayout title="Ce lien n’est plus valable" intro="Le lien a expiré ou a déjà été utilisé. Demandez-en un nouveau à un administrateur.">
        <Link to="/connexion" className="text-sm font-semibold text-sky">
          Retour à la connexion
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Nouveau mot de passe" intro="Choisissez un nouveau mot de passe pour votre compte.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
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
          Changer le mot de passe
        </Button>
      </form>
    </AuthLayout>
  );
}
