import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../app/AuthLayout';
import { ApiError } from '../api/client';
import { messageForError } from '../api/messages';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';

type LocationState = { from?: string; notice?: string } | null;

/** Un 401 à la connexion signifie « identifiants refusés » (message volontairement générique), pas « session expirée ». */
function loginError(err: unknown): string {
  if (err instanceof ApiError && (err.status === 401 || err.code === 'invalid_credentials')) {
    return 'Identifiants incorrects. Vérifiez votre e-mail et votre mot de passe.';
  }
  return messageForError(err);
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const state = useLocation().state as LocationState;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={state?.from ?? '/'} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Connexion" intro="Connectez-vous pour voir les derniers classements.">
      {state?.notice ? (
        <p role="status" className="mt-0 mb-4 rounded-xl border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
          {state.notice}
        </p>
      ) : null}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="E-mail" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full py-3">
          Se connecter
        </Button>
      </form>
      <p className="mt-4 mb-0 text-center font-mono text-[10.5px] text-mute">ACCÈS SUR INVITATION UNIQUEMENT</p>
    </AuthLayout>
  );
}
