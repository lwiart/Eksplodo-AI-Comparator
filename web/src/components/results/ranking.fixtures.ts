// Données de test partagées par les tests de la vue résultats.
import type { Ranking, RankingModel } from '../../api/results';

export const model = (over: Partial<RankingModel> & Pick<RankingModel, 'modelId' | 'name'>): RankingModel => ({
  color: '#F0631F',
  providerName: 'Fournisseur',
  quality: 8,
  speed: 6,
  cost: 6,
  reliability: 10,
  raw: { medianTtftMs: 500, medianTokensPerS: 60, meanCostUsd: 0.003, done: 4, failed: 0, unsupported: 0, scoredTests: 2 },
  byCategory: { Rédaction: 8, Logique: 7 },
  ...over,
});

/** Trois modèles notés (Alpha devant avec la pondération par défaut, Charlie devant avec tout sur la vitesse) et un modèle sans note. */
export const MODELS: RankingModel[] = [
  model({ modelId: 'a', name: 'Alpha', color: '#F0631F', providerName: 'Anthropic', quality: 9, speed: 2, cost: 6, reliability: 10 }),
  model({ modelId: 'b', name: 'Bravo', color: '#3FA2E0', providerName: 'OpenAI', quality: 7, speed: 6, cost: 6, reliability: 10 }),
  model({ modelId: 'c', name: 'Charlie', color: '#7CC4EF', providerName: 'Mistral', quality: 3, speed: 10, cost: 10, reliability: 10, byCategory: { Rédaction: 3, Logique: null } }),
  model({
    modelId: 'd',
    name: 'Delta',
    color: '#FFB48A',
    providerName: 'Autre',
    quality: null,
    speed: 9,
    cost: 9,
    reliability: 10,
    raw: { medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null, done: 0, failed: 0, unsupported: 0, scoredTests: 0 },
    byCategory: { Rédaction: null, Logique: null },
  }),
];

export const RANKING: Ranking = {
  weights: { quality: 50, speed: 20, cost: 20, reliability: 10 },
  models: MODELS,
  categories: ['Rédaction', 'Logique'],
  judge: { modelName: 'Claude Juge' },
};
