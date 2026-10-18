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
  expect(logScore(0.1, 0.1, 0.2, false)).toBe(100);
  expect(logScore(0.2, 0.1, 0.2, false)).toBe(20);
  expect(logScore(1, 1, 2, false)).toBe(100);
  expect(logScore(2, 1, 2, false)).toBe(20);
  // Entre les deux : 20 + 80 × (1 − ln 1,5 / ln 2) = 53,203 (plus bas = mieux) ; 20 + 80 × ln 1,5 / ln 2 = 66,797 sinon.
  expect(logScore(0.15, 0.1, 0.2, false)).toBeCloseTo(53.203, 3);
  expect(logScore(1.5, 1, 2, false)).toBeCloseTo(53.203, 3);
  expect(logScore(0.15, 0.1, 0.2, true)).toBeCloseTo(66.797, 3);
  expect(logScore(50, 50, 100, true)).toBe(20);
  expect(logScore(100, 50, 100, true)).toBe(100);
});

test('un seul modèle, ou tous égaux → 100', () => {
  expect(logScore(5, 5, 5, true)).toBe(100);
  expect(logScore(5, 5, 5, false)).toBe(100);

  const single = aggregateRun([row({ ttftMs: 300, tokensPerS: 40, costUsd: 0.02, autoScore: 70 })]);
  expect(single).toHaveLength(1);
  expect(single[0]).toMatchObject({ modelId: 'm1', quality: 70, speed: 100, cost: 100, reliability: 100 });

  const equal = byModel(
    aggregateRun([
      row({ modelId: 'm1', ttftMs: 300, tokensPerS: 40, costUsd: 0.02 }),
      row({ modelId: 'm2', ttftMs: 300, tokensPerS: 40, costUsd: 0.02 }),
    ]),
  );
  expect(equal.get('m1')).toMatchObject({ speed: 100, cost: 100 });
  expect(equal.get('m2')).toMatchObject({ speed: 100, cost: 100 });
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
  // m1 : médiane du premier token 200 ms (meilleure), débit médian 55 = m2 → 100 et 100 ; coût moyen 0,2 $ (le double de m2).
  expect(aggs.get('m1')).toMatchObject({
    speed: 100,
    cost: 20,
    raw: { medianTtftMs: 200, medianTokensPerS: 55, meanCostUsd: 0.2, done: 3, failed: 1, unsupported: 0 },
  });
  // m2 : premier token 400 ms (le double) → 2, débit 100 → vitesse 60 ; coût 0,1 $ → 100.
  expect(aggs.get('m2')).toMatchObject({ speed: 60, cost: 100, raw: { medianTtftMs: 400, medianTokensPerS: 55, meanCostUsd: 0.1 } });
});

test('qualité = moyenne par test de la moyenne des répétitions notées ; awaiting_manual exclu', () => {
  const [a] = aggregateRun([
    // t1 (Culture) : répétitions 80 et 60 → 70.
    row({ runTestId: 't1', autoScore: 80 }),
    row({ runTestId: 't1', autoScore: 60 }),
    // t2 (Écriture, manuel) : moyenne des évaluateurs 40 ; l'autre répétition, sans note (awaiting_manual), est exclue.
    row({ runTestId: 't2', category: 'Écriture', scoringMethod: 'manual', manualAvg: 40 }),
    row({ runTestId: 't2', category: 'Écriture', scoringMethod: 'manual', manualAvg: null }),
    // t3 (Culture, juge en échec) sans note imposée : exclu ; t4 (juge en échec) avec note imposée 90 : compté.
    row({ runTestId: 't3', scoringMethod: 'judge', autoScore: null }),
    row({ runTestId: 't4', scoringMethod: 'judge', autoScore: null, overrideScore: 90 }),
    // La note imposée remplace la note de la méthode.
    row({ runTestId: 't5', category: 'Logique', autoScore: 0, overrideScore: 50 }),
    // Échec et combinaison non supportée : jamais dans la qualité.
    row({ runTestId: 't6', category: 'Logique', status: 'error' }),
    row({ runTestId: 't6', category: 'Logique', status: 'unsupported' }),
    // Note manuelle sur une méthode automatique : ignorée (la note de la méthode est la note auto).
    row({ runTestId: 't7', category: 'Maths', manualAvg: 100 }),
  ]);
  // (70 + 40 + 90 + 50) / 4 = 62,5.
  expect(a!.quality).toBe(62.5);
  expect(a!.raw.scoredTests).toBe(4);
  expect(a!.byCategory).toEqual({ Culture: 80, Écriture: 40, Logique: 50, Maths: null });
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
      // Moyenne 0,0000015 $ (affichée 0,000002 $) : 20 + 80 × (1 − ln 1,5 / ln 4) = 76,6 (60 avec la moyenne arrondie).
      row({ modelId: 'm3', costUsd: 0.000001 }),
      row({ modelId: 'm3', costUsd: 0.000002 }),
    ]),
  );
  expect(aggs.get('m3')).toMatchObject({ cost: 76.6, raw: { meanCostUsd: 0.000002 } });
  expect(aggs.get('m1')!.cost).toBe(100);
  expect(aggs.get('m2')!.cost).toBe(20);
});

test('qualité arrondie au centième', () => {
  const [a] = aggregateRun([row({ runTestId: 't1', autoScore: 100 }), row({ runTestId: 't2', autoScore: 50 }), row({ runTestId: 't3', autoScore: 50 })]);
  expect(a!.quality).toBe(66.67);
});

test('fiabilité exclut unsupported ; modèle sans réponse réussie : vitesse et coût nuls, fiabilité 0', () => {
  const aggs = byModel(
    aggregateRun([
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 60 }),
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 60 }),
      row({ modelId: 'm1', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 60 }),
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
  expect(aggs.get('m1')).toMatchObject({ reliability: 60, raw: { done: 3, failed: 2, unsupported: 2 } });
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
      row({ modelId: 'gratuit', ttftMs: 100, tokensPerS: 50, costUsd: 0, autoScore: 80 }),
      row({ modelId: 'payant', ttftMs: 100, tokensPerS: 50, costUsd: 0.01, autoScore: 80 }),
      row({ modelId: 'autre', ttftMs: 100, tokensPerS: 50, costUsd: 0.04, autoScore: 80 }),
    ]),
  );
  const free = aggs.get('gratuit')!;
  expect(free.cost).toBeNull();
  expect(free.raw.meanCostUsd).toBe(0);
  // `lo` et `hi` pris sur les valeurs > 0 : 0,01 $ → 100, 0,04 $ → 20.
  expect(aggs.get('payant')!.cost).toBe(100);
  expect(aggs.get('autre')!.cost).toBe(20);
  // Qualité 80, vitesse 100, fiabilité 100, coût retiré : (50 × 80 + 20 × 100 + 10 × 100) / 80 = 87,5.
  expect(globalScore(free, DEFAULT_WEIGHTS)).toBe(87.5);
  for (const a of aggs.values()) {
    for (const v of [a.quality, a.speed, a.cost, a.reliability, globalScore(a, DEFAULT_WEIGHTS)]) expect(Number.isNaN(v)).toBe(false);
  }
  // Premier token nul : exclu aussi (note nulle), la vitesse ne garde que la note du débit.
  const [zero] = aggregateRun([row({ ttftMs: 0, tokensPerS: 30 })]);
  expect(zero).toMatchObject({ speed: 100, raw: { medianTtftMs: 0 } });
  const [none] = aggregateRun([row({ ttftMs: 0, tokensPerS: 0 })]);
  expect(none!.speed).toBeNull();
});

test('score global pondéré et renormalisé ; modèle sans test noté hors podium', () => {
  // (50 × 80 + 20 × 60 + 20 × 40 + 10 × 100) / 100 = 70.
  expect(globalScore(agg('a', 80, 60, 40, 100), DEFAULT_WEIGHTS)).toBe(70);
  expect(globalScore(agg('a', 80, 60, 40, 100), { quality: 100, speed: 0, cost: 0, reliability: 0 })).toBe(80);
  // Vitesse sans note : (50 × 80 + 20 × 40 + 10 × 100) / 80 = 72,5.
  expect(globalScore(agg('a', 80, null, 40, 100), DEFAULT_WEIGHTS)).toBe(72.5);
  // Arrondi au centième : (50 × 70 + 20 × 30) / 70 = 58,571…
  expect(globalScore(agg('a', 70, 30, null, null), DEFAULT_WEIGHTS)).toBe(58.57);
  // Sans qualité : pas de score global, même avec les autres critères.
  expect(globalScore(agg('a', null, 100, 100, 100), DEFAULT_WEIGHTS)).toBeNull();

  const ranking = rankModels(
    [agg('sans-note', null, 100, 100, 100), agg('second', 60, 60, 60, 60), agg('premier', 80, 60, 40, 100), agg('ex-aequo', 60, 60, 60, 60)],
    DEFAULT_WEIGHTS,
  );
  expect(ranking).toEqual([
    { modelId: 'premier', rank: 1, global: 70 },
    { modelId: 'second', rank: 2, global: 60 },
    { modelId: 'ex-aequo', rank: 2, global: 60 },
    { modelId: 'sans-note', rank: null, global: null },
  ]);
});
