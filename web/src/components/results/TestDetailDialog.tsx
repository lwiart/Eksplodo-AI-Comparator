import type { ReactNode } from 'react';
import type { AnswersTest } from '../../api/results';
import type { ExpectedConfig, JudgeConfig } from '../../api/tests';
import { METHOD_LABEL } from '../../lib/format';
import { Dialog } from '../ui/Dialog';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-mute uppercase">{title}</h3>
      {children}
    </section>
  );
}

const TEXT = 'm-0 max-h-60 overflow-y-auto rounded-xl border border-line bg-night-0/45 px-3.5 py-2.5 text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]';

/** Résultat attendu selon la méthode de notation : réponse exacte, éléments à trouver, motif, critères du juge. */
function Expected({ test }: { test: AnswersTest }) {
  if (test.scoringMethod === 'manual') return <p className="m-0 text-sm text-ink">Pas de réponse de référence : les réponses sont notées à la main par les évaluateurs.</p>;
  if (test.scoringMethod === 'judge') {
    const c = test.scoringConfig as JudgeConfig;
    return (
      <>
        <p className="m-0 text-xs text-mute">Critères donnés au juge</p>
        <p className={TEXT}>{c.criteria}</p>
        {c.reference ? (
          <>
            <p className="m-0 text-xs text-mute">Réponse de référence</p>
            <p className={TEXT}>{c.reference}</p>
          </>
        ) : null}
      </>
    );
  }
  const c = test.scoringConfig as ExpectedConfig;
  if (c.mode === 'exact') {
    const options = [c.ignoreCase ? 'majuscules ignorées' : 'majuscules comptées', c.ignoreAccents ? 'accents ignorés' : 'accents comptés'];
    return (
      <>
        <p className="m-0 text-xs text-mute">Réponse exacte attendue ({options.join(', ')})</p>
        <p className={TEXT}>{c.expected}</p>
      </>
    );
  }
  if (c.mode === 'contains') {
    return (
      <>
        <p className="m-0 text-xs text-mute">La réponse doit contenir ({c.ignoreCase ? 'majuscules ignorées' : 'majuscules comptées'})</p>
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm text-ink">
          {c.items.map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <>
      <p className="m-0 text-xs text-mute">La réponse doit correspondre à l’expression régulière</p>
      <p className={`${TEXT} font-mono`}>
        /{c.pattern}/{c.flags}
      </p>
    </>
  );
}

/** Détail d'un test tel qu'il a été figé au lancement de la série : consignes envoyées aux modèles et résultat attendu. */
export function TestDetailDialog({ test, open, onOpenChange }: { test: AnswersTest; open: boolean; onOpenChange(open: boolean): void }) {
  // Champs absents des séries très anciennes : la ligne est omise plutôt que d'afficher « undefined ».
  const facts = [
    ['Catégorie', test.category],
    ['Notation', METHOD_LABEL[test.scoringMethod]],
    ['Température', test.temperature?.toLocaleString('fr-FR')],
    ['Limite de sortie', test.maxTokens ? `${test.maxTokens.toLocaleString('fr-FR')} tokens` : undefined],
  ].filter((f): f is [string, string] => f[1] !== undefined);
  const tags = test.tags ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={test.name} description="Test tel qu’il a été envoyé aux modèles dans cette série." size="wide">
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-mute">{label}</dt>
              <dd className="m-0 text-sm text-white">{value}</dd>
            </div>
          ))}
          {tags.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-mute">Étiquettes</dt>
              <dd className="m-0 text-sm text-white">{tags.join(', ')}</dd>
            </div>
          ) : null}
        </dl>
        {test.systemPrompt ? (
          <Block title="Consigne système">
            <p className={TEXT}>{test.systemPrompt}</p>
          </Block>
        ) : null}
        <Block title="Prompt utilisateur">
          <p className={TEXT}>{test.userPrompt}</p>
        </Block>
        {test.attachments.length > 0 ? (
          <Block title="Pièces jointes">
            <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm text-ink">
              {test.attachments.map((a) => (
                <li key={a.index}>{a.originalName}</li>
              ))}
            </ul>
          </Block>
        ) : null}
        <Block title="Résultat attendu">
          <Expected test={test} />
        </Block>
      </div>
    </Dialog>
  );
}
