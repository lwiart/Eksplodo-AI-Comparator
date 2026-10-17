import { expect, test } from 'vitest';
import type { Weights } from '../api/runs';
import { rankClient, rebalance, sameWeights, weightedGlobal, type CriteriaNotes } from './ranking';

const DEFAULTS: Weights = { quality: 50, speed: 20, cost: 20, reliability: 10 };
const agg = (modelId: string, quality: number | null, speed: number | null, cost: number | null, reliability: number | null): CriteriaNotes => ({
  modelId,
  quality,
  speed,
  cost,
  reliability,
});

// Mêmes cas que server/test/aggregate.test.ts (globalScore, rankModels) : le client doit donner les mêmes résultats.
test('weightedGlobal : moyenne pondérée, arrondie au centième', () => {
  expect(weightedGlobal(agg('a', 8, 6, 4, 10), DEFAULTS)).toBe(7);
  expect(weightedGlobal(agg('a', 8, 6, 4, 10), { quality: 100, speed: 0, cost: 0, reliability: 0 })).toBe(8);
  expect(weightedGlobal(agg('a', 7, 3, null, null), DEFAULTS)).toBe(5.86);
});

test('weightedGlobal : un critère nul est retiré et les poids restants renormalisés', () => {
  // Vitesse sans note : (50 × 8 + 20 × 4 + 10 × 10) / 80 = 7,25.
  expect(weightedGlobal(agg('a', 8, null, 4, 10), DEFAULTS)).toBe(7.25);
  // Coût retiré : (50 × 8 + 20 × 10 + 10 × 10) / 80 = 8,75.
  expect(weightedGlobal(agg('a', 8, 10, null, 10), DEFAULTS)).toBe(8.75);
  // Critères restants tous à poids nul : pas de score.
  expect(weightedGlobal(agg('a', 8, 6, null, null), { quality: 0, speed: 0, cost: 50, reliability: 50 })).toBeNull();
});

test('weightedGlobal : sans qualité, pas de score global même avec les autres critères', () => {
  expect(weightedGlobal(agg('a', null, 10, 10, 10), DEFAULTS)).toBeNull();
});

test('rankClient : ex æquo au même rang, modèle sans qualité en fin de liste sans rang', () => {
  const ranking = rankClient(
    [agg('sans-note', null, 10, 10, 10), agg('second', 6, 6, 6, 6), agg('premier', 8, 6, 4, 10), agg('ex-aequo', 6, 6, 6, 6)],
    DEFAULTS,
  );
  expect(ranking).toEqual([
    { modelId: 'premier', rank: 1, global: 7 },
    { modelId: 'second', rank: 2, global: 6 },
    { modelId: 'ex-aequo', rank: 2, global: 6 },
    { modelId: 'sans-note', rank: null, global: null },
  ]);
});

test('rankClient : changer la pondération réordonne ; aucun modèle : liste vide', () => {
  const models = [agg('qualite', 9, 2, 2, 10), agg('rapide', 6, 10, 10, 10)];
  expect(rankClient(models, DEFAULTS).map((r) => r.modelId)).toEqual(['rapide', 'qualite']);
  expect(rankClient(models, { quality: 100, speed: 0, cost: 0, reliability: 0 }).map((r) => r.modelId)).toEqual(['qualite', 'rapide']);
  expect(rankClient([], DEFAULTS)).toEqual([]);
});

test('rebalance : les autres curseurs sont ramenés proportionnellement, somme 100 en entiers', () => {
  expect(rebalance(DEFAULTS, 'quality', 70)).toEqual({ quality: 70, speed: 12, cost: 12, reliability: 6 });
  expect(rebalance(DEFAULTS, 'quality', 100)).toEqual({ quality: 100, speed: 0, cost: 0, reliability: 0 });
  // Les autres valaient 0 : répartition égale du reste.
  expect(rebalance({ quality: 100, speed: 0, cost: 0, reliability: 0 }, 'quality', 70)).toEqual({ quality: 70, speed: 10, cost: 10, reliability: 10 });
  for (let v = 0; v <= 100; v++) {
    for (const key of ['quality', 'speed', 'cost', 'reliability'] as const) {
      const w = rebalance({ quality: 33, speed: 27, cost: 22, reliability: 18 }, key, v);
      expect(w.quality + w.speed + w.cost + w.reliability).toBe(100);
      expect(w[key]).toBe(v);
      expect(Object.values(w).every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  }
});

test('sameWeights compare les quatre poids', () => {
  expect(sameWeights(DEFAULTS, { ...DEFAULTS })).toBe(true);
  expect(sameWeights(DEFAULTS, { ...DEFAULTS, speed: 21 })).toBe(false);
});
