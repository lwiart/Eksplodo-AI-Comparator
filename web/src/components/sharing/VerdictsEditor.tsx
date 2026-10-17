import { useId } from 'react';
import type { Ranking, RankingModel } from '../../api/results';
import type { ShareVerdict } from '../../api/sharing';
import { rankedRows } from '../../lib/ranking';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { SelectField } from '../ui/SelectField';
import { TextArea } from '../ui/TextArea';

export const MAX_VERDICTS = 6;

/** Verdict en cours d'édition : `key` donne une identité stable aux lignes quand on en retire une. */
export type DraftVerdict = ShareVerdict & { key: string };

let counter = 0;
export const newKey = (): string => `v${++counter}`;
export const toDraft = (v: ShareVerdict): DraftVerdict => ({ ...v, key: newKey() });
export const fromDraft = ({ label, modelId, text }: DraftVerdict): ShareVerdict => ({ label: label.trim(), modelId, text });

const score = (x: number) => x.toFixed(1).replace('.', ',');

/**
 * Trois propositions calculées sur le classement à la pondération de la série : meilleur score global, meilleure qualité
 * et plus petit coût moyen (absente quand aucun modèle n'a de coût).
 */
export function proposeVerdicts(ranking: Ranking): ShareVerdict[] {
  const rows = rankedRows(ranking.models, ranking.weights).filter((r) => r.global !== null);
  const out: ShareVerdict[] = [];
  const top = rows[0];
  if (top) {
    out.push({
      label: 'Meilleur compromis',
      modelId: top.model.modelId,
      text: `${top.model.name} a le meilleur score global (${score(top.global!)} sur 10).`,
    });
  }
  const best = (pick: (m: RankingModel) => number | null, better: (a: number, b: number) => boolean) => {
    let found: RankingModel | null = null;
    let value = 0;
    for (const { model } of rows) {
      const v = pick(model);
      if (v === null) continue;
      if (found === null || better(v, value)) {
        found = model;
        value = v;
      }
    }
    return found ? { model: found, value } : null;
  };
  const quality = best((m) => m.quality, (a, b) => a > b);
  if (quality) {
    out.push({
      label: 'Meilleure qualité',
      modelId: quality.model.modelId,
      text: `${quality.model.name} obtient la meilleure qualité (${score(quality.value)} sur 10).`,
    });
  }
  const cheap = best((m) => m.raw.meanCostUsd, (a, b) => a < b);
  if (cheap) out.push({ label: 'Le moins cher', modelId: cheap.model.modelId, text: `${cheap.model.name} est le moins cher par réponse.` });
  return out;
}

type Props = {
  verdicts: DraftVerdict[];
  models: { modelId: string; name: string }[];
  onChange(next: DraftVerdict[]): void;
};

/** Verdicts de la page publique : jusqu'à six, chacun avec un titre, un modèle éventuel et une phrase. */
export function VerdictsEditor({ verdicts, models, onChange }: Props) {
  const heading = useId();
  const options = [{ value: '', label: 'Aucun modèle' }, ...models.map((m) => ({ value: m.modelId, label: m.name }))];
  const patch = (key: string, change: Partial<ShareVerdict>) => onChange(verdicts.map((v) => (v.key === key ? { ...v, ...change } : v)));
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={heading} className="m-0 font-display text-sm font-bold text-white">
          Verdicts
        </h3>
        <span className="font-mono text-xs text-mute">
          {verdicts.length} / {MAX_VERDICTS}
        </span>
      </div>
      {verdicts.length === 0 ? <p className="m-0 text-sm text-mute">Aucun verdict : la page publique n’affichera que le classement.</p> : null}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {verdicts.map((v, i) => (
          <li key={v.key} role="group" aria-label={`Verdict ${i + 1}`} className="flex flex-col gap-3 rounded-xl border border-line bg-night-0/40 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Titre du verdict" maxLength={60} value={v.label} onChange={(e) => patch(v.key, { label: e.target.value })} />
              <SelectField
                label="Modèle"
                value={v.modelId ?? ''}
                options={options}
                onChange={(e) => patch(v.key, { modelId: e.target.value === '' ? null : e.target.value })}
              />
            </div>
            <TextArea label="Phrase" rows={2} maxLength={500} value={v.text} onChange={(e) => patch(v.key, { text: e.target.value })} />
            <div className="flex justify-end">
              <Button variant="ghost" className="px-3 py-1 text-xs" onClick={() => onChange(verdicts.filter((x) => x.key !== v.key))}>
                Supprimer le verdict {i + 1}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button disabled={verdicts.length >= MAX_VERDICTS} onClick={() => onChange([...verdicts, { key: newKey(), label: '', modelId: null, text: '' }])}>
          <span aria-hidden="true">+</span>
          Ajouter un verdict
        </Button>
      </div>
    </section>
  );
}
