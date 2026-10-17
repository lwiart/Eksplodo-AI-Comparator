import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PROVIDERS_KEY, updateProvider } from '../../api/catalog';
import { messageForKeyError } from '../../api/messages';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';

/** Champ de clé : masqué par défaut, bouton « Afficher » pour vérifier la saisie. */
export function KeyInput({ value, onChange, label = 'Clé API' }: { value: string; onChange(v: string): void; label?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Field
          label={label}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className="w-full font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <Button variant="ghost" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        {shown ? 'Masquer' : 'Afficher'}
      </Button>
    </div>
  );
}

type Props = {
  providerId: string;
  providerName: string;
  /** Une clé est déjà enregistrée (ou illisible) : propose de la supprimer. */
  hasKey: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
};

/** Saisie ou remplacement de la clé d'un fournisseur ; la clé n'est jamais relue ni conservée après l'envoi. */
export function ApiKeyDialog({ providerId, providerName, hasKey, open, onOpenChange }: Props) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function close() {
    setValue('');
    setError(null);
    setConfirmRemove(false);
    onOpenChange(false);
  }

  const save = useMutation({
    gcTime: 0, // les variables (la clé) ne restent pas dans le cache de TanStack
    mutationFn: (apiKey: string | null) => updateProvider(providerId, { apiKey }),
    onSettled: () => {
      setValue(''); // la valeur saisie est effacée dès la réponse, succès ou échec
      void client.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onSuccess: () => close(),
    onError: (err) => setError(messageForKeyError(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate(value.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={hasKey ? 'Remplacer la clé' : 'Saisir la clé'}
      description={`Fournisseur ${providerName}. La clé est chiffrée à l'enregistrement et ne sera plus jamais affichée.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <KeyInput value={value} onChange={setValue} />
        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {hasKey ? (
            confirmRemove ? (
              <span className="flex items-center gap-2">
                <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(null)}>
                  Confirmer la suppression
                </Button>
                <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Garder la clé
                </Button>
              </span>
            ) : (
              <Button variant="ghost" className="text-bad" onClick={() => setConfirmRemove(true)}>
                Supprimer la clé
              </Button>
            )
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending || value.trim() === ''}>
              Enregistrer
            </Button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}
