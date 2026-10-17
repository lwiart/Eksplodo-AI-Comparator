import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AUDIT_URL_MESSAGE, messageForError } from '../../api/messages';
import { SHARING_SETTINGS_KEY, getSharingSettings, saveSharingSettings } from '../../api/sharing';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';

/** Réglage « URL du bouton « Audit gratuit » » (Admin) : adresse ouverte par le bouton de la page publique. */
export function AuditUrlCard() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: SHARING_SETTINGS_KEY, queryFn: getSharingSettings });
  const [choice, setChoice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = settings.data?.auditUrl ?? '';
  const value = choice ?? saved;
  const save = useMutation({
    mutationFn: (url: string) => saveSharingSettings(url),
    onSuccess: async () => {
      setChoice(null);
      await client.invalidateQueries({ queryKey: SHARING_SETTINGS_KEY });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const url = value.trim();
    // Même règle que le serveur, vérifiée avant l'envoi pour répondre sans attendre.
    if (!url.startsWith('https://') || url.length > 300) {
      setProblem(AUDIT_URL_MESSAGE);
      return;
    }
    setProblem(null);
    save.mutate(url);
  }

  const error = problem ?? (settings.isError ? messageForError(settings.error) : save.isError ? messageForError(save.error) : null);

  return (
    <Card className="mb-5 flex flex-col gap-3" role="region" aria-label="Bouton Audit gratuit">
      <h2 className="m-0 font-display text-lg font-bold text-white">URL du bouton « Audit gratuit »</h2>
      <p className="m-0 max-w-prose text-sm text-mute">Adresse ouverte par le bouton « Audit gratuit » de toutes les pages publiques de partage.</p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1">
          <Field
            label="URL de destination"
            inputMode="url"
            autoComplete="off"
            disabled={settings.isPending}
            value={value}
            onChange={(e) => {
              setChoice(e.target.value);
              setProblem(null);
            }}
            error={error}
          />
        </div>
        <Button type="submit" variant="primary" disabled={choice === null || choice === saved || save.isPending}>
          Enregistrer
        </Button>
      </form>
    </Card>
  );
}
