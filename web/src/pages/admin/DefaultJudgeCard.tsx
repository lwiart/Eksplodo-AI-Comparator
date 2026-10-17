import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MODELS_KEY, listModels } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { SCORING_SETTINGS_KEY, getScoringSettings, setDefaultJudge } from '../../api/scoring';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { SelectField } from '../../components/ui/SelectField';

/** Réglage « Juge par défaut » (Admin) : modèle proposé d'office par l'assistant de lancement pour noter les tests au juge. */
export function DefaultJudgeCard() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: SCORING_SETTINGS_KEY, queryFn: getScoringSettings });
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });
  const [choice, setChoice] = useState<string | null>(null);
  const saved = settings.data?.defaultJudgeModelId ?? '';
  const value = choice ?? saved;
  const save = useMutation({
    mutationFn: () => setDefaultJudge(value === '' ? null : value),
    onSuccess: async () => {
      setChoice(null);
      await client.invalidateQueries({ queryKey: SCORING_SETTINGS_KEY });
    },
  });

  const options = (models.data ?? []).filter((m) => m.available || m.id === saved);
  const error = settings.error ?? models.error ?? (save.isError ? save.error : null);

  return (
    <Card className="mb-5 flex flex-col gap-3" role="region" aria-label="Juge par défaut">
      <h2 className="m-0 font-display text-lg font-bold text-white">Juge par défaut</h2>
      <p className="m-0 max-w-prose text-sm text-mute">Le modèle choisi ici est présélectionné dans l’assistant de lancement quand il est disponible. Vous pouvez en changer pour chaque série.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px]">
          <SelectField
            label="Modèle juge"
            value={value}
            disabled={settings.isPending || models.isPending}
            onChange={(e) => setChoice(e.target.value)}
            options={[{ value: '', label: 'Aucun' }, ...options.map((m) => ({ value: m.id, label: m.displayName }))]}
          />
        </div>
        <Button variant="primary" disabled={choice === null || choice === saved || save.isPending} onClick={() => save.mutate()}>
          Enregistrer
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {messageForError(error)}
        </p>
      ) : null}
    </Card>
  );
}
