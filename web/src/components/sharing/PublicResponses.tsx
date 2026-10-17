import { useId, useState } from 'react';
import type { PublicModel, PublicResponse } from '../../api/public-share';
import { Markdown } from '../results/Markdown';
import { DASH, score } from '../results/format';

/** Réponses publiées (option du lien) : un sélecteur de test, puis les réponses de chaque modèle rendues en Markdown. */
export function PublicResponses({ responses, models }: { responses: PublicResponse[]; models: PublicModel[] }) {
  const selectId = useId();
  const [index, setIndex] = useState(0);
  const test = responses[index];
  if (!test) return null;
  const byKey = new Map(models.map((m) => [m.modelId, m]));
  return (
    <section aria-label="Réponses des modèles" className="card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-display text-base font-bold text-white">Les réponses</h2>
        <div className="no-print flex min-w-0 items-center gap-2">
          <label htmlFor={selectId} className="text-xs text-mute">Test</label>
          <select
            id={selectId}
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="min-w-0 max-w-full rounded-full border border-line-strong bg-night-2/70 px-3 py-2 text-[13px] text-white"
          >
            {responses.map((r, i) => (
              <option key={i} value={i}>{r.testName}</option>
            ))}
          </select>
        </div>
      </div>
      <p className="mt-3 mb-0 font-mono text-[11px] text-mute">{test.category}</p>
      <blockquote className="mt-2 mb-0 rounded-xl border border-line bg-night-0/45 px-4 py-3 text-sm whitespace-pre-line text-ink">{test.userPrompt}</blockquote>
      <div className="mt-4 grid gap-3.5 lg:grid-cols-2">
        {test.answers.length === 0 ? <p className="m-0 text-sm text-mute">Aucune réponse réussie pour ce test.</p> : null}
        {test.answers.map((a) => {
          const m = byKey.get(a.modelKey);
          return (
            <article key={`${a.modelKey}-${a.repetition}`} className="min-w-0 rounded-xl border border-line bg-night-0/45 p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 flex items-center gap-2 font-display text-sm font-bold text-white">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m?.color ?? '#7FA3B5' }} />
                  {m?.name ?? a.modelKey}
                </h3>
                <span className="font-mono text-xs text-peach">{a.finalScore === null ? DASH : `${score(a.finalScore)} / 10`}</span>
              </header>
              <div className="mt-2 text-sm break-words">{a.text ? <Markdown text={a.text} relativeLinksAsText /> : <p className="m-0 text-mute">Pas de texte.</p>}</div>
              {a.judgeRationale ? <p className="mt-3 mb-0 border-t border-line pt-2 text-xs text-mute">{a.judgeRationale}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
