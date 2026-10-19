import { useEffect, useId, useRef, useState } from 'react';
import type { PublicModel, PublicResponse } from '../../api/public-share';
import { Markdown } from '../results/Markdown';
import { NO_FILTER, type AnswersFilter } from '../results/answers-filter';
import { TestDetailDialog } from '../results/TestDetailDialog';
import { DASH, score } from '../results/format';

const SELECT = 'min-w-0 max-w-full rounded-full border border-line-strong bg-night-2/70 px-3 py-2 text-[13px] text-white';

function Pick({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange(v: string): void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="text-xs text-mute">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Valeur de la liste « Test » qui affiche tous les tests de la sélection, l'un sous l'autre. */
const ALL_TESTS = 'tous';

/** Un test : nom cliquable (détail), catégorie, question, puis les réponses en pleine largeur, comme la question. */
function PublicTestBlock({ test, modelId, byKey }: { test: PublicResponse; modelId: string | null; byKey: Map<string, PublicModel> }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const answers = modelId ? test.answers.filter((a) => a.modelKey === modelId) : test.answers;
  return (
    <section aria-label={test.testName} className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          title="Voir le détail du test : prompts et résultat attendu"
          onClick={() => setDetailOpen(true)}
          className="cursor-pointer border-0 bg-transparent p-0 text-left font-display text-sm font-bold text-peach underline decoration-dotted underline-offset-2 hover:text-white"
        >
          {test.testName}
        </button>
        <span className="font-mono text-[11px] text-mute">{test.category}</span>
      </div>
      <blockquote className="mt-2 mb-0 rounded-xl border border-line bg-night-0/45 px-4 py-3 text-sm whitespace-pre-line text-ink">{test.userPrompt}</blockquote>
      {detailOpen && test.detail ? (
        <TestDetailDialog test={{ name: test.testName, category: test.category, userPrompt: test.userPrompt, ...test.detail }} open={detailOpen} onOpenChange={setDetailOpen} />
      ) : null}
      <div className="mt-3 grid gap-3.5">
        {answers.length === 0 ? <p className="m-0 text-sm text-mute">Aucune réponse réussie pour ce test.</p> : null}
        {answers.map((a) => {
          const m = byKey.get(a.modelKey);
          return (
            <article key={`${a.modelKey}-${a.repetition}`} className="min-w-0 rounded-xl border border-line bg-night-0/45 p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 flex items-center gap-2 font-display text-sm font-bold text-white">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m?.color ?? '#7FA3B5' }} />
                  {m?.name ?? a.modelKey}
                </h3>
                <span className="font-mono text-xs text-peach">{a.finalScore === null ? DASH : `${score(a.finalScore)} / 100`}</span>
              </header>
              <div className="mt-2 text-sm break-words">{a.text ? <Markdown text={a.text} relativeLinksAsText /> : <p className="m-0 text-mute">Pas de texte.</p>}</div>
              {a.judgeRationale ? <p className="mt-3 mb-0 border-t border-line pt-2 text-[13px] leading-relaxed text-ink/80">{a.judgeRationale}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Réponses publiées (option du lien) : filtres Catégorie, Test et Modèle (la matrice pose aussi catégorie et modèle),
 * « Tous les tests » de la sélection l'un sous l'autre (choix d'un clic dans la matrice) ou un seul, détail du test dans
 * une fenêtre, puis les réponses de chaque modèle rendues en Markdown.
 */
export function PublicResponses({
  responses,
  models,
  filter = NO_FILTER,
  onFilterChange,
  focusKey = 0,
}: {
  responses: PublicResponse[];
  models: PublicModel[];
  filter?: AnswersFilter;
  onFilterChange?: (filter: AnswersFilter) => void;
  /** Change à chaque clic dans la matrice : les réponses sont alors amenées à l'écran. */
  focusKey?: number;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [index, setIndex] = useState<number | typeof ALL_TESTS>(0);
  const [ownFilter, setOwnFilter] = useState<AnswersFilter>(NO_FILTER);
  const current = onFilterChange ? filter : ownFilter;
  const setFilter = onFilterChange ?? setOwnFilter;
  // Clic sur une note de la matrice : tous les tests de la catégorie (et du modèle) choisis, puis défilement jusqu'ici.
  useEffect(() => {
    if (focusKey === 0) return;
    setIndex(ALL_TESTS);
    sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [focusKey]);
  const categories = [...new Set(responses.map((r) => r.category))];
  const shown = responses.map((r, i) => ({ r, i })).filter(({ r }) => !current.category || r.category === current.category);
  const selected = shown.find((s) => s.i === index) ?? shown[0];
  if (!selected) return null;
  const allMode = index === ALL_TESTS && shown.length > 1;
  const byKey = new Map<string, PublicModel>(models.map((m) => [m.modelId, m]));
  const filterModel = current.modelId ? byKey.get(current.modelId) : undefined;
  const filtered = current.modelId !== null || current.category !== null;
  return (
    <section ref={sectionRef} aria-label="Réponses des modèles" className="card-surface scroll-mt-4 p-5">
      <h2 className="m-0 font-display text-base font-bold text-white">Réponses</h2>
      <div className="no-print mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {categories.length > 1 ? (
          <Pick
            label="Catégorie"
            value={current.category ?? ''}
            options={[{ value: '', label: 'Toutes' }, ...categories.map((c) => ({ value: c, label: c }))]}
            onChange={(v) => setFilter({ ...current, category: v || null })}
          />
        ) : null}
        <Pick
          label="Test"
          value={allMode ? ALL_TESTS : String(selected.i)}
          options={[
            ...(shown.length > 1 ? [{ value: ALL_TESTS, label: `Tous les tests (${shown.length})` }] : []),
            ...shown.map(({ r, i }) => ({ value: String(i), label: r.testName })),
          ]}
          onChange={(v) => setIndex(v === ALL_TESTS ? ALL_TESTS : Number(v))}
        />
        {models.length > 1 ? (
          <Pick
            label="Modèle"
            value={current.modelId ?? ''}
            options={[{ value: '', label: 'Tous' }, ...models.map((m) => ({ value: m.modelId, label: m.name }))]}
            onChange={(v) => setFilter({ ...current, modelId: v || null })}
          />
        ) : null}
      </div>
      {filtered ? (
        <div role="status" className="no-print mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-orange/50 bg-orange/10 px-3 py-2 text-sm text-white">
          <span>
            Filtre : <b>{filterModel?.name ?? 'tous les modèles'}</b> · {current.category ?? 'toutes les catégories'} ({shown.length} test{shown.length > 1 ? 's' : ''})
          </span>
          <button
            type="button"
            onClick={() => setFilter(NO_FILTER)}
            className="ml-auto cursor-pointer rounded-full border border-line-strong bg-transparent px-3 py-1 text-xs font-semibold text-white hover:bg-night-2"
          >
            Retirer le filtre
          </button>
        </div>
      ) : null}
      {allMode ? (
        <div className="mt-4 flex flex-col gap-6">
          {shown.map(({ r, i }) => (
            <PublicTestBlock key={i} test={r} modelId={current.modelId} byKey={byKey} />
          ))}
        </div>
      ) : (
        <div className="mt-4">
          <PublicTestBlock test={selected.r} modelId={current.modelId} byKey={byKey} />
        </div>
      )}
    </section>
  );
}
