import { expect, test } from 'vitest';
import {
  aggregateRun,
  globalScore,
  logScore,
  rankModels,
  type AggregateInputRow,
  type ModelAggregate,
} from '../src/modules/scoring/aggregate.js';
import { DEFAULT_WEIGHTS } from '../src/modules/runs/runs.service.js';

/** Résultat terminé d'un test à réponse attendue, sans note ni métrique ; chaque test précise ce qui compte. */
const row = (over: Partial<AggregateInputRow>): AggregateInputRow => ({
  modelId: 'm1',
  runTestId: 't1',
  category: 'Culture',
  scoringMethod: 'expected',
  status: 'done',
  overrideScore: null,
  autoScore: null,
  manualAvg: null,
  ttftMs: null,
  tokensPerS: null,
  costUsd: null,
  ...over,
});

const byModel = (aggs: ModelAggregate[]) => new Map(aggs.map((a) => [a.modelId, a]));

const agg = (modelId: string, quality: number | null, speed: number | null, cost: number | null, reliability: number | null): ModelAggregate => ({
  modelId,
  quality,
  speed,
  cost,
  reliability,
  raw: { medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null, done: 0, failed: 0, unsupported: 0, scoredTests: 0 },
  byCategory: {},
});

test('note logarithmique : du simple au double pèse autant à 0,10 $ qu’à 1 $', () => {
  expect(logScore(0.1, 0.1, 0.2, false)).toBe(10);
  expect(logScore(0.2, 0.1, 0.2, false)).toBe(2);
  expect(logScore(1, 1, 2, false)).toBe(10);
  expect(logScore(2, 1, 2, false)).toBe(2);
  // Entre les deux : 2 + 8 × (1 − ln 1,5 / ln 2) = 5,3203 (plus bas = mieux) ; 2 + 8 × ln 1,5 / ln 2 = 6,6797 sinon.
  expect(logScore(0.15, 0.1, 0.2, false)).toBeCloseTo(5.3203, 4);
  expect(logScore(1.5, 1, 2, false)).toBeCloseTo(5.3203, 4);
  expect(logScore(0.15, 0.1, 0.2, true)).toBeCloseTo(6.6797, 4);
  expect(logScore(50, 50, 100, true)).toBe(2);
  expect(logScore(100, 50, 100, true)).toBe(10);
});

test('un seul modèle, ou tous égaux → 10', () => {
  expect(logScore(5, 5, 5, true)).toBe(10);
  expect(logScore(5, 5, 5, false)).toBe(10);

  const single = aggregateRun([row({ ttftMs: 300, tokensPerS: 40, costUsd: 0.02, autoScore: 7 })]);
  expect(single).toHaveLength(1);
  expect(single[0]).toMatchObject({ modelId: 'm1', quality: 7, speed: 10, cost: 10, reliability: 10 });

  const equal = byModel(
    aggregateRun([
      row({ modelId: 'm1', ttftMs: 300, tokensPerS: 40, costUsd: 0.02 }),
      row({ modelId: 'm2', ttftMs: 300, tokensPerS: 40, costUsd: 0.02 }),
    ]),
  );
  expect(equal.get('m1')).toMatchObject({ speed: 10, cost: 10 });
  expect(equal.get('m2')).toMatchObject({ speed: 10, cost: 10 });
});

test('vitesse : médianes du premier token et du débit sur les réponses réussies ; coût moyen par réponse réussie', () => {
  const aggs = byModel(
    aggregateRun([
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.1 }),
      row({ modelId: 'm1', ttftMs: 300, tokensPerS: 60, costUsd: 0.3 }),
      row({ modelId: 'm1', ttftMs: 200, tokensPerS: null, costUsd: null }),
      // Échec : ni ses métriques ni son coût ne comptent.
      row({ modelId: 'm1', status: 'error', ttftMs: 1, tokensPerS: 1000, costUsd: 5 }),
      row({ modelId: 'm2', ttftMs: 400, tokensPerS: 55, costUsd: 0.1 }),
    ]),
  );
  // m1 : médiane du premier token 200 ms (meilleure), débit médian 55 = m2 → 10 et 10 ; coût moyen 0,2 $ (le double de m2).
  expect(aggs.get('m1')).toMatchObject({
    speed: 10,
    cost: 2,
    raw: { medianTtftMs: 200, medianTokensPerS: 55, meanCostUsd: 0.2, done: 3, failed: 1, unsupported: 0 },
  });
  // m2 : premier token 400 ms (le double) → 2, débit 10 → vitesse 6 ; coût 0,1 $ → 10.
  expect(aggs.get('m2')).toMatchObject({ speed: 6, cost: 10, raw: { medianTtftMs: 400, medianTokensPerS: 55, meanCostUsd: 0.1 } });
});

test('qualité = moyenne par test de la moyenne des répétitions notées ; awaiting_manual exclu', () => {
  const [a] = aggregateRun([
    // t1 (Culture) : répétitions 8 et 6 → 7.
    row({ runTestId: 't1', autoScore: 8 }),
    row({ runTestId: 't1', autoScore: 6 }),
    // t2 (Écriture, manuel) : moyenne des évaluateurs 4 ; l'autre répétition, sans note (awaiting_manual), est exclue.
    row({ runTestId: 't2', category: 'Écriture', scoringMethod: 'manual', manualAvg: 4 }),
    row({ runTestId: 't2', category: 'Écriture', scoringMethod: 'manual', manualAvg: null }),
    // t3 (Culture, juge en échec) sans note imposée : exclu ; t4 (juge en échec) avec note imposée 9 : compté.
    row({ runTestId: 't3', scoringMethod: 'judge', autoScore: null }),
    row({ runTestId: 't4', scoringMethod: 'judge', autoScore: null, overrideScore: 9 }),
    // La note imposée remplace la note de la méthode.
    row({ runTestId: 't5', category: 'Logique', autoScore: 0, overrideScore: 5 }),
    // Échec et combinaison non supportée : jamais dans la qualité.
    row({ runTestId: 't6', category: 'Logique', status: 'error' }),
    row({ runTestId: 't6', category: 'Logique', status: 'unsupported' }),
    // Note manuelle sur une méthode automatique : ignorée (la note de la méthode est la note auto).
    row({ runTestId: 't7', category: 'Maths', manualAvg: 10 }),
  ]);
  // (7 + 4 + 9 + 5) / 4 = 6,25.
  expect(a!.quality).toBe(6.25);
  expect(a!.raw.scoredTests).toBe(4);
  expect(a!.byCategory).toEqual({ Culture: 8, Écriture: 4, Logique: 5, Maths: null });
});

test('aucun résultat : aucun agrégat', () => {
  expect(aggregateRun([])).toEqual([]);
  expect(rankModels([], DEFAULT_WEIGHTS)).toEqual([]);
});

test('note de coût sur le coût moyen non arrondi ; arrondi au micro-dollar pour l’affichage seulement', () => {
  const aggs = byModel(
    aggregateRun([
      row({ modelId: 'm1', costUsd: 0.000001 }),
      row({ modelId: 'm2', costUsd: 0.000004 }),
      // Moyenne 0,0000015 $ (affichée 0,000002 $) : 2 + 8 × (1 − ln 1,5 / ln 4) = 7,66 (6 avec la moyenne arrondie).
      row({ modelId: 'm3', costUsd: 0.000001 }),
      row({ modelId: 'm3', costUsd: 0.000002 }),
    ]),
  );
  expect(aggs.get('m3')).toMatchObject({ cost: 7.66, raw: { meanCostUsd: 0.000002 } });
  expect(aggs.get('m1')!.cost).toBe(10);
  expect(aggs.get('m2')!.cost).toBe(2);
});

test('qualité arrondie au centième', () => {
  const [a] = aggregateRun([row({ runTestId: 't1', autoScore: 10 }), row({ runTestId: 't2', autoScore: 5 }), row({ runTestId: 't3', autoScore: 5 })]);
  expect(a!.quality).toBe(6.67);
});

test('fiabilité exclut unsupported ; modèle sans réponse réussie : vitesse et coût nuls, fiabilité 0', () => {
  const aggs = byModel(
    aggregateRun([
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 6 }),
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 6 }),
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 6 }),
      row({ modelId: 'm1', status: 'error' }),
      row({ modelId: 'm1', status: 'timeout' }),
      row({ modelId: 'm1', status: 'unsupported' }),
      row({ modelId: 'm1', status: 'unsupported' }),
      // En attente ou en cours : pas encore comptés.
      row({ modelId: 'm1', status: 'pending' }),
      row({ modelId: 'm1', status: 'running' }),
      row({ modelId: 'm2', status: 'error' }),
      row({ modelId: 'm2', status: 'timeout' }),
      row({ modelId: 'm3', status: 'unsupported' }),
    ]),
  );
  expect(aggs.get('m1')).toMatchObject({ reliability: 6, raw: { done: 3, failed: 2, unsupported: 2 } });
  expect(aggs.get('m2')).toMatchObject({
    quality: null,
    speed: null,
    cost: null,
    reliability: 0,
    raw: { medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null, done: 0, failed: 2, unsupported: 0, scoredTests: 0 },
  });
  // Rien de terminé hors combinaisons non supportées : fiabilité sans objet.
  expect(aggs.get('m3')).toMatchObject({ reliability: null, raw: { unsupported: 1 } });
});

test('modèle gratuit (coût 0) : pas de NaN, note de coût nulle et poids renormalisés', () => {
  const aggs = byModel(
    aggregateRun([
      row({ modelId: 'gratuit', ttftMs: 100, tokensPerS: 50, costUsd: 0, autoScore: 8 }),
      row({ modelId: 'payant', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 8 }),
      row({ modelId: 'autre', ttftMs: 100, tokensPerS: 50, costUsd: 0.04, autoScore: 8 }),
    ]),
  );
  const free = aggs.get('gratuit')!;
  expect(free.cost).toBeNull();
  expect(free.raw.meanCostUsd).toBe(0);
  // `lo` et `hi` pris sur les valeurs > 0 : 0,01 $ → 10, 0,04 $ → 2.
  expect(aggs.get('payant')!.cost).toBe(10);
  expect(aggs.get('autre')!.cost).toBe(2);
  // Qualité 8, vitesse 10, fiabilité 10, coût retiré : (50 × 8 + 20 × 10 + 10 × 10) / 80 = 8,75.
  expect(globalScore(free, DEFAULT_WEIGHTS)).toBe(8.75);
  for (const a of aggs.values()) {
    for (const v of [a.quality, a.speed, a.cost, a.reliability, globalScore(a, DEFAULT_WEIGHTS)]) expect(Number.isNaN(v)).toBe(false);
  }
  // Premier token nul : exclu aussi (note nulle), la vitesse ne garde que la note du débit.
  const [zero] = aggregateRun([row({ ttftMs: 0, tokensPerS: 30 })]);
  expect(zero).toMatchObject({ speed: 10, raw: { medianTtftMs: 0 } });
  const [none] = aggregateRun([row({ ttftMs: 0, tokensPerS: 0 })]);
  expect(none!.speed).toBeNull();
});

test('score global pondéré et renormalisé ; modèle sans test noté hors podium', () => {
  // (50 × 8 + 20 × 6 + 20 × 4 + 10 × 10) / 100 = 7.
  expect(globalScore(agg('a', 8, 6, 4, 10), DEFAULT_WEIGHTS)).toBe(7);
  expect(globalScore(agg('a', 8, 6, 4, 10), { quality: 100, speed: 0, cost: 0, reliability: 0 })).toBe(8);
  // Vitesse sans note : (50 × 8 + 20 × 4 + 10 × 10) / 80 = 7,25.
  expect(globalScore(agg('a', 8, null, 4, 10), DEFAULT_WEIGHTS)).toBe(7.25);
  // Arrondi au centième : (50 × 7 + 20 × 3) / 70 = 5,857…
  expect(globalScore(agg('a', 7, 3, null, null), DEFAULT_WEIGHTS)).toBe(5.86);
  // Sans qualité : pas de score global, même avec les autres critères.
  expect(globalScore(agg('a', null, 10, 10, 10), DEFAULT_WEIGHTS)).toBeNull();

  const ranking = rankModels(
    [agg('sans-note', null, 10, 10, 10), agg('second', 6, 6, 6, 6), agg('premier', 8, 6, 4, 10), agg('ex-aequo', 6, 6, 6, 6)],
    DEFAULT_WEIGHTS,
  );
  expect(ranking).toEqual([
    { modelId: 'premier', rank: 1, global: 7 },
    { modelId: 'second', rank: 2, global: 6 },
    { modelId: 'ex-aequo', rank: 2, global: 6 },
    { modelId: 'sans-note', rank: null, global: null },
  ]);
});
