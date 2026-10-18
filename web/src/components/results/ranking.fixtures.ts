// Données de test partagées par les tests de la vue résultats.
import type { Ranking, RankingModel } from '../../api/results';

export const model = (over: Partial<RankingModel> & Pick<RankingModel, 'modelId' | 'name'>): RankingModel => ({
  color: '#F0631F',
  providerName: 'Fournisseur',
  quality: 80,
  speed: 60,
  cost: 60,
  reliability: 100,
  raw: { medianTtftMs: 500, medianTokensPerS: 60, meanCostUsd: 0.003, done: 4, failed: 0, unsupported: 0, scoredTests: 2 },
  byCategory: { Rédaction: 80, Logique: 70 },
  ...over,
});

/** Trois modèles notés (Alpha devant avec la pondération par défaut, Charlie devant avec tout sur la vitesse) et un modèle sans note. */
export const MODELS: RankingModel[] = [
  model({ modelId: 'a', name: 'Alpha', color: '#F0631F', providerName: 'Anthropic', quality: 90, speed: 20, cost: 60, reliability: 100 }),
  model({ modelId: 'b', name: 'Bravo', color: '#3FA2E0', providerName: 'OpenAI', quality: 70, speed: 60, cost: 60, reliability: 100 }),
  model({ modelId: 'c', name: 'Charlie', color: '#7CC4EF', providerName: 'Mistral', quality: 30, speed: 100, cost: 100, reliability: 100, byCategory: { Rédaction: 30, Logique: null } }),
  model({
    modelId: 'd',
    name: 'Delta',
    color: '#FFB48A',
    providerName: 'Autre',
    quality: null,
    speed: 90,
    cost: 90,
    reliability: 100,
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
