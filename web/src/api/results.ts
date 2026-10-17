import { apiFetch } from './client';
import type { ResultStatus, Weights } from './runs';

// Types miroirs de server/src/modules/scoring/results.service.ts et aggregate.ts.
export type ModelAggregate = {
  modelId: string;
  /** Notes de critère sur 10, nulles quand elles ne sont pas calculables (ou masquées pour un Utilisateur). */
  quality: number | null;
  speed: number | null;
  cost: number | null;
  reliability: number | null;
  raw: {
    medianTtftMs: number | null;
    medianTokensPerS: number | null;
    meanCostUsd: number | null;
    done: number;
    /** Erreurs et délais dépassés. */
    failed: number;
    unsupported: number;
    /** Tests ayant au moins une répétition notée. */
    scoredTests: number;
  };
  /** Qualité par catégorie de test (nulle sans test noté). */
  byCategory: Record<string, number | null>;
};

export type RankingModel = ModelAggregate & { name: string; color: string; providerName: string };

/** Notes de critère indépendantes de la pondération : le client pondère et classe. */
export type Ranking = {
  weights: Weights;
  models: RankingModel[];
  categories: string[];
  judge: { modelName: string } | null;
};

export type Answer = {
  resultId: string;
  modelName: string;
  color: string;
  repetition: number;
  status: ResultStatus;
  responseText: string | null;
  hiddenUntilScored: boolean;
  finalScore: number | null;
  autoScore: number | null;
  manualAvg: number | null;
  overrideScore: number | null;
  judgeRationale: string | null;
  ttftMs: number | null;
  tokensPerS: number | null;
  costUsd: number | null;
  errorMessage: string | null;
};

export type Answers = { test: { name: string; category: string; userPrompt: string }; answers: Answer[] };

/** Corps de `POST /api/runs/:id/rescore` (miroir de `rescoreBody`). */
export type RescoreBody = {
  scope: 'run' | 'test' | 'result';
  runTestId?: string;
  resultId?: string;
  judgeModelId?: string;
};

export type OverrideResult = { id: string; overrideScore: number | null; overrideBy: string | null };

export const rankingKey = (runId: string) => ['runs', runId, 'ranking'] as const;
export const answersKey = (runId: string, runTestId: string) => ['runs', runId, 'answers', runTestId] as const;
/** Préfixe des réponses de tous les tests d'une série. */
export const answersPrefix = (runId: string) => ['runs', runId, 'answers'] as const;

const enc = encodeURIComponent;

export function getRanking(runId: string): Promise<Ranking> {
  return apiFetch<Ranking>(`/api/runs/${enc(runId)}/ranking`);
}

export function getAnswers(runId: string, runTestId: string): Promise<Answers> {
  return apiFetch<Answers>(`/api/runs/${enc(runId)}/answers/${enc(runTestId)}`);
}

/** Adresse du CSV (téléchargement par lien : la session passe par le cookie). */
export const exportCsvUrl = (runId: string): string => `/api/runs/${enc(runId)}/export.csv`;

export function rescoreRun(runId: string, body: RescoreBody): Promise<{ queued: number }> {
  return apiFetch<{ queued: number }>(`/api/runs/${enc(runId)}/rescore`, { method: 'POST', body });
}

/** Note imposée par un Admin ; `null` retire l'imposition. */
export async function overrideScore(resultId: string, score: number | null): Promise<OverrideResult> {
  return (await apiFetch<{ result: OverrideResult }>(`/api/scoring/results/${enc(resultId)}/override`, { method: 'PUT', body: { score } })).result;
}
