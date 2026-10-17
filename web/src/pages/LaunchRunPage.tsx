import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MODELS_KEY, listModels, type PublicModel } from '../api/catalog';
import { messageForError } from '../api/messages';
import { DEFAULT_WEIGHTS, RUNS_KEY, createRun, estimateRun, type RunInput, type Weights } from '../api/runs';
import { SUITES_KEY, TESTS_KEY, listSuites, listTests, type PublicSuite, type PublicTest, type ScoringMethod } from '../api/tests';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Field } from '../components/ui/Field';
import { SelectField } from '../components/ui/SelectField';
import { MAIN_PROVIDERS, MORE_PROVIDERS } from '../three/providers';

type Source = 'suite' | 'custom';
type Step = 1 | 2 | 3 | 4;
const STEPS = ['Tests', 'Modèles', 'Paramètres', 'Récapitulatif'] as const;
const ESTIMATE_DELAY_MS = 400;

const LOGO_ALIASES: Record<string, string> = { anthropic: 'claude', google: 'gemini' };
const LOGOS = new Map<string, string>([...MAIN_PROVIDERS, ...MORE_PROVIDERS].map((p) => [p.name.toLowerCase(), p.icon] as const));
const logoFor = (name: string) => {
  const key = name.trim().toLowerCase();
  return LOGOS.get(key) ?? LOGOS.get(LOGO_ALIASES[key] ?? '');
};

export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
export const usd = (n: number) => `${n.toLocaleString('fr-FR', n > 0 && n < 0.01 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

export function duration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Plafond saisi (virgule ou point) : `null` = sans plafond, `undefined` = saisie invalide. */
export function parseBudget(raw: string): number | null | undefined {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  const fourDecimals = Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6;
  return Number.isFinite(n) && n >= 0.0001 && n <= 999_999 && fourDecimals ? Math.round(n * 10_000) / 10_000 : undefined;
}

type PickedTest = { id: string; name: string; scoringMethod: ScoringMethod };

function StepIndicator({ step, onGo }: { step: Step; onGo(s: Step): void }) {
  return (
    <ol aria-label="Étapes" className="m-0 mb-6 flex list-none flex-wrap gap-2 p-0">
      {STEPS.map((label, i) => {
        const n = (i + 1) as Step;
        const state = n < step ? 'done' : n === step ? 'on' : 'todo';
        return (
          <li key={label} aria-current={state === 'on' ? 'step' : undefined}>
            <button
              type="button"
              disabled={state !== 'done'}
              onClick={() => onGo(n)}
              className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${
                state === 'on'
                  ? 'border-orange/60 bg-orange/10 text-peach'
                  : state === 'done'
                    ? 'cursor-pointer border-good/40 bg-good/10 text-good'
                    : 'border-line bg-transparent text-mute'
              }`}
            >
              <span aria-hidden="true" className="font-mono text-xs">
                {state === 'done' ? '✓' : n}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const ROW = 'flex cursor-pointer items-center gap-3 rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 has-[:checked]:border-orange/60 has-[:checked]:bg-orange/10';

function SourceStep({
  source,
  setSource,
  suites,
  suiteId,
  setSuiteId,
  tests,
  customIds,
  setCustomIds,
}: {
  source: Source;
  setSource(s: Source): void;
  suites: PublicSuite[];
  suiteId: string | null;
  setSuiteId(id: string): void;
  tests: PublicTest[];
  customIds: string[];
  setCustomIds(ids: string[]): void;
}) {
  const tab = (value: Source, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={source === value}
      onClick={() => setSource(value)}
      className={`cursor-pointer rounded-full border px-4 py-1.5 text-[13px] font-semibold ${
        source === value ? 'border-orange/60 bg-orange/10 text-peach' : 'border-line-strong bg-transparent text-ink'
      }`}
    >
      {label}
    </button>
  );
  const toggle = (id: string) => setCustomIds(customIds.includes(id) ? customIds.filter((x) => x !== id) : [...customIds, id]);

  return (
    <Card className="flex flex-col gap-4">
      <div role="tablist" aria-label="Origine des tests" className="flex gap-2">
        {tab('suite', 'Une suite')}
        {tab('custom', 'Tests à la carte')}
      </div>
      {source === 'suite' ? (
        suites.length === 0 ? (
          <p className="m-0 text-sm text-mute">Aucune suite pour l’instant. Créez-en une dans « Suites » ou choisissez des tests à la carte.</p>
        ) : (
          <div role="radiogroup" aria-label="Suite" className="flex flex-col gap-2">
            {suites.map((s) => {
              const active = s.tests.filter((t) => !t.archived).length;
              return (
                <label key={s.id} className={ROW}>
                  <input type="radio" name="suite" className="accent-orange" checked={suiteId === s.id} onChange={() => setSuiteId(s.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-white">{s.name}</span>
                    <span className="block text-xs text-mute">
                      {plural(active, 'test actif', 'tests actifs')}
                      {active < s.tests.length ? ` (${s.tests.length - active} archivé${s.tests.length - active > 1 ? 's' : ''}, ignoré${s.tests.length - active > 1 ? 's' : ''})` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )
      ) : tests.length === 0 ? (
        <p className="m-0 text-sm text-mute">Aucun test actif. Créez-en dans « Tests ».</p>
      ) : (
        <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
          {tests.map((t) => (
            <label key={t.id} className={ROW}>
              <input type="checkbox" className="accent-orange" checked={customIds.includes(t.id)} onChange={() => toggle(t.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{t.name}</span>
                <span className="block text-xs text-mute">{t.category}</span>
              </span>
              {t.attachments.length > 0 ? <Chip>{plural(t.attachments.length, 'pièce jointe', 'pièces jointes')}</Chip> : null}
            </label>
          ))}
        </div>
      )}
    </Card>
  );
}

function ModelsStep({
  models,
  selected,
  setSelected,
  visionTests,
}: {
  models: PublicModel[];
  selected: string[];
  setSelected(ids: string[]): void;
  visionTests: number;
}) {
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <Card>
      <h2 className="m-0 mb-3 font-display text-base font-bold text-white">
        Modèles{' '}
        <small className="font-sans text-xs font-normal text-mute">
          {plural(selected.length, 'sélectionné', 'sélectionnés')}
          {visionTests > 0 ? ` · ${plural(visionTests, 'test demande', 'tests demandent')} la vision` : ''}
        </small>
      </h2>
      {models.length === 0 ? (
        <p className="m-0 text-sm text-mute">Aucun modèle dans le catalogue. Ajoutez-en depuis « Fournisseurs ».</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {models.map((m) => {
            const logo = logoFor(m.providerName);
            return (
              <label
                key={m.id}
                className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${
                  m.available
                    ? 'cursor-pointer border-line-strong bg-night-0/60 has-[:checked]:border-orange/60 has-[:checked]:bg-orange/10'
                    : 'cursor-not-allowed border-line bg-night-0/30 opacity-50'
                }`}
              >
                <input type="checkbox" className="mt-1 accent-orange" disabled={!m.available} checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
                <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-night-0/60">
                  {logo ? <img src={logo} alt="" className="h-5 w-5 object-contain" /> : <span className="text-xs font-bold text-sky">{m.providerName.slice(0, 1)}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.color }} />
                    <span className="truncate">{m.displayName}</span>
                  </span>
                  <span className="block text-xs text-mute">{m.providerName}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.supportsVision ? <Chip>Vision</Chip> : null}
                    {m.supportsPdf ? <Chip>PDF</Chip> : null}
                    {!m.available ? <Chip tone="bad">Indisponible</Chip> : null}
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-mute">
                    {m.inputPricePerM} / {m.outputPricePerM} $ par million
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const WEIGHT_FIELDS: { key: keyof Weights; label: string }[] = [
  { key: 'quality', label: 'Qualité' },
  { key: 'speed', label: 'Vitesse' },
  { key: 'cost', label: 'Coût' },
  { key: 'reliability', label: 'Fiabilité' },
];

/** Assistant « Lancer une série » (Admin) : tests, modèles, paramètres, puis récapitulatif chiffré avant le lancement. */
export function LaunchRunPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<Source>('suite');
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [repetitions, setRepetitions] = useState(1);
  const [concurrency, setConcurrency] = useState(4);
  const [judgeId, setJudgeId] = useState('');
  const [budget, setBudget] = useState('');
  const [weights, setWeights] = useState<Record<keyof Weights, string>>({
    quality: String(DEFAULT_WEIGHTS.quality),
    speed: String(DEFAULT_WEIGHTS.speed),
    cost: String(DEFAULT_WEIGHTS.cost),
    reliability: String(DEFAULT_WEIGHTS.reliability),
  });

  const suites = useQuery({ queryKey: SUITES_KEY, queryFn: listSuites });
  const tests = useQuery({ queryKey: [...TESTS_KEY, 'list', 'launch'], queryFn: () => listTests() });
  const models = useQuery({ queryKey: MODELS_KEY, queryFn: listModels });

  const activeTests = useMemo(() => (tests.data ?? []).filter((t) => t.archivedAt === null), [tests.data]);
  const suite = suites.data?.find((s) => s.id === suiteId) ?? null;

  const picked: PickedTest[] = useMemo(() => {
    if (source === 'suite') return (suite?.tests ?? []).filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name, scoringMethod: t.scoringMethod }));
    return customIds.flatMap((id) => activeTests.filter((t) => t.id === id)).map((t) => ({ id: t.id, name: t.name, scoringMethod: t.scoringMethod }));
  }, [source, suite, customIds, activeTests]);

  const visionTests = useMemo(() => {
    const ids = new Set(picked.map((t) => t.id));
    return activeTests.filter((t) => ids.has(t.id) && t.attachments.length > 0).length;
  }, [picked, activeTests]);

  const judgeRequired = picked.some((t) => t.scoringMethod === 'judge');
  const budgetValue = parseBudget(budget);
  const weightNumber = (raw: string) => (raw.trim() === '' ? NaN : Number(raw));
  const weightNumbers = {
    quality: weightNumber(weights.quality),
    speed: weightNumber(weights.speed),
    cost: weightNumber(weights.cost),
    reliability: weightNumber(weights.reliability),
  };
  const weightsValid = Object.values(weightNumbers).every((n) => Number.isInteger(n) && n >= 0 && n <= 100);
  const weightsTotal = Object.values(weightNumbers).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const weightsOk = weightsValid && weightsTotal === 100;
  const judgeEvaluated = judgeId !== '' && modelIds.includes(judgeId);

  const defaultName = source === 'suite' && suite ? suite.name : `Série du ${new Date().toLocaleDateString('fr-FR')}`;
  const body: RunInput = {
    name: name.trim() || defaultName,
    ...(source === 'suite' && suiteId ? { suiteId } : {}),
    testIds: picked.map((t) => t.id),
    modelIds,
    repetitions,
    concurrency,
    judgeModelId: judgeId === '' ? null : judgeId,
    budgetUsd: budgetValue ?? null,
    weights: weightNumbers,
  };

  // Estimation recalculée 400 ms après le dernier changement de sélection ou de paramètre.
  const bodyKey = JSON.stringify(body);
  const [debouncedKey, setDebouncedKey] = useState(bodyKey);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKey(bodyKey), ESTIMATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [bodyKey]);
  const estimate = useQuery({
    queryKey: [...RUNS_KEY, 'estimate', debouncedKey],
    queryFn: () => estimateRun(JSON.parse(debouncedKey) as RunInput),
    enabled: step === 4 && debouncedKey === bodyKey,
    retry: false,
    staleTime: 60_000,
  });
  const estimating = step === 4 && (debouncedKey !== bodyKey || estimate.isFetching);

  const launch = useMutation({
    mutationFn: () => createRun(body),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: RUNS_KEY });
      navigate(`/series/${run.id}`);
    },
  });

  const canContinue: Record<Step, boolean> = {
    1: picked.length > 0,
    2: modelIds.length > 0,
    3: weightsOk && budgetValue !== undefined && (!judgeRequired || judgeId !== ''),
    4: false,
  };
  const availableModels = (models.data ?? []).filter((m) => m.available);
  const loadError = suites.error ?? tests.error ?? models.error;
  const est = estimate.data;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-1 font-mono text-xs text-mute">Séries / Nouvelle</div>
      <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Lancer une série</h1>
      <p className="mt-2 mb-5 max-w-prose text-sm text-mute">Choisissez des tests, des modèles et le juge. Le coût maximal est estimé avant le lancement.</p>

      <StepIndicator step={step} onGo={setStep} />

      {loadError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(loadError)}
        </p>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[1fr_340px]">
        <div>
          {step === 1 ? (
            <SourceStep
              source={source}
              setSource={setSource}
              suites={suites.data ?? []}
              suiteId={suiteId}
              setSuiteId={setSuiteId}
              tests={activeTests}
              customIds={customIds}
              setCustomIds={setCustomIds}
            />
          ) : null}

          {step === 2 ? <ModelsStep models={models.data ?? []} selected={modelIds} setSelected={setModelIds} visionTests={visionTests} /> : null}

          {step === 3 ? (
            <Card className="flex flex-col gap-4">
              <Field label="Nom de la série" value={name} maxLength={200} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label="Répétitions"
                  value={String(repetitions)}
                  onChange={(e) => setRepetitions(Number(e.target.value))}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
                />
                <SelectField
                  label="Concurrence"
                  value={String(concurrency)}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <SelectField
                  label="Modèle juge"
                  value={judgeId}
                  onChange={(e) => setJudgeId(e.target.value)}
                  options={[{ value: '', label: 'Aucun' }, ...availableModels.map((m) => ({ value: m.id, label: m.displayName }))]}
                />
                {judgeRequired && judgeId === '' ? (
                  <p role="alert" className="m-0 text-xs text-bad">
                    Un des tests choisis est noté par le juge : sélectionnez un modèle juge.
                  </p>
                ) : null}
                {judgeEvaluated ? (
                  <p className="m-0 text-xs text-peach">Le juge est aussi un modèle évalué : ses notes risquent de le favoriser.</p>
                ) : null}
              </div>
              <Field
                label="Plafond en $ (facultatif)"
                inputMode="decimal"
                value={budget}
                placeholder="Sans plafond"
                error={budgetValue === undefined ? 'Saisissez un montant supérieur à 0 (4 décimales au plus).' : null}
                hint="La série se met en pause quand ce montant est atteint."
                onChange={(e) => setBudget(e.target.value)}
              />
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-[13px] font-medium text-ink">Pondération du score global</legend>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {WEIGHT_FIELDS.map((w) => (
                    <Field
                      key={w.key}
                      label={w.label}
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={weights[w.key]}
                      onChange={(e) => setWeights({ ...weights, [w.key]: e.target.value })}
                    />
                  ))}
                </div>
                <p role="status" className={`m-0 font-mono text-xs ${weightsOk ? 'text-good' : 'text-bad'}`}>
                  Total : {weightsTotal}
                  {weightsOk ? '' : ' (doit valoir 100)'}
                </p>
              </fieldset>
            </Card>
          ) : null}

          {step === 4 ? (
            <Card className="flex flex-col gap-3">
              <h2 className="m-0 font-display text-base font-bold text-white">{body.name}</h2>
              {estimate.isError ? (
                <p role="alert" className="m-0 text-sm text-bad">
                  {messageForError(estimate.error)}
                </p>
              ) : !est ? (
                <p className="m-0 text-sm text-mute">Estimation en cours…</p>
              ) : (
                <>
                  <div className="font-mono text-[11px] text-mute">Coût maximal estimé</div>
                  <div className={`font-mono text-[28px] font-semibold text-peach ${estimating ? 'opacity-50' : ''}`}>≤ {usd(est.maxCostUsd)}</div>
                  <p className="m-0 font-mono text-xs text-mute">
                    dont modèles {usd(est.modelsMaxCostUsd)}, juge {usd(est.judgeMaxCostUsd)}
                  </p>
                  <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-mute">Appels</dt>
                    <dd className="m-0 text-right font-mono text-white">
                      {est.unsupported > 0 ? `${plural(est.calls, 'appel', 'appels')} dont ${plural(est.unsupported, 'non supporté', 'non supportés')}` : plural(est.calls, 'appel', 'appels')}
                    </dd>
                    <dt className="text-mute">Durée estimée</dt>
                    <dd className="m-0 text-right font-mono text-white">≈ {duration(est.durationSeconds)}</dd>
                    <dt className="text-mute">Plafond</dt>
                    <dd className="m-0 text-right font-mono text-white">{budgetValue ? usd(budgetValue) : 'Aucun'}</dd>
                  </dl>
                  {est.warnings.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Avertissements">
                      {est.warnings.map((w) => (
                        <li key={w} className="rounded-xl border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-peach">
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </Card>
          ) : null}
        </div>

        <Card className="flex flex-col gap-3 lg:sticky lg:top-4">
          <h2 className="m-0 font-display text-base font-bold text-white">Votre série</h2>
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-mute">Tests</dt>
            <dd className="m-0 text-right font-mono text-white">{picked.length > 0 ? plural(picked.length, 'test sélectionné', 'tests sélectionnés') : '—'}</dd>
            <dt className="text-mute">Modèles</dt>
            <dd className="m-0 text-right font-mono text-white">{modelIds.length || '—'}</dd>
            <dt className="text-mute">Répétitions</dt>
            <dd className="m-0 text-right font-mono text-white">{repetitions}</dd>
          </dl>
          {launch.isError ? (
            <p role="alert" className="m-0 text-sm text-bad">
              {messageForError(launch.error)}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {step > 1 ? (
              <Button variant="ghost" onClick={() => setStep((step - 1) as Step)}>
                Retour
              </Button>
            ) : null}
            {step < 4 ? (
              <Button variant="primary" disabled={!canContinue[step]} onClick={() => setStep((step + 1) as Step)}>
                Continuer →
              </Button>
            ) : (
              <Button variant="primary" disabled={estimating || estimate.isError || !est || launch.isPending} onClick={() => launch.mutate()}>
                Lancer la série
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
