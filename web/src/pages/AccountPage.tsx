import * as Switch from '@radix-ui/react-switch';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api/client';
import { messageForError } from '../api/messages';
import { applyAnimationsPreference, getAnimationsPreference, setAnimationsPreference } from '../app/preferences';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { validateNewPassword } from './password-rules';

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    const problem = validateNewPassword(next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/api/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex max-w-sm flex-col gap-4">
      <Field label="Mot de passe actuel" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      <Field
        label="Nouveau mot de passe"
        type="password"
        autoComplete="new-password"
        hint="12 caractères minimum."
        required
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <Field
        label="Confirmer le nouveau mot de passe"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={error}
      />
      {done ? (
        <p role="status" className="m-0 text-sm text-good">
          Mot de passe modifié.
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy} className="self-start">
        Changer le mot de passe
      </Button>
    </form>
  );
}

function AnimationsSetting() {
  const [on, setOn] = useState(getAnimationsPreference);
  function change(value: boolean) {
    setOn(value);
    setAnimationsPreference(value);
    applyAnimationsPreference(value);
  }
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <label htmlFor="animations-switch" className="text-sm font-medium text-white">
          Animations
        </label>
        <p className="m-0 mt-0.5 text-xs text-mute">Gerbe de la page de connexion et transitions. Désactivez-les si elles vous gênent.</p>
      </div>
      <Switch.Root
        id="animations-switch"
        checked={on}
        onCheckedChange={change}
        className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full border border-line-strong bg-night-2 data-[state=checked]:border-orange data-[state=checked]:bg-orange"
      >
        <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
    </div>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Mon compte</h1>
        {user ? (
          <p className="mt-2 mb-0 text-sm text-mute">
            {user.name} · {user.email}
          </p>
        ) : null}
      </div>
      <Card className="p-6">
        <h2 className="mt-0 mb-4 font-display text-lg font-bold text-white">Mot de passe</h2>
        <PasswordForm />
      </Card>
      <Card className="p-6">
        <h2 className="mt-0 mb-4 font-display text-lg font-bold text-white">Affichage</h2>
        <AnimationsSetting />
      </Card>
    </div>
  );
}
