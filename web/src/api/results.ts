import { apiFetch } from './client';
import type { ResultStatus, Weights } from './runs';
import type { ScoringConfig } from './tests';

// Types miroirs de server/src/modules/scoring/results.service.ts et aggregate.ts.
export type ModelAggregate = {
  modelId: string;
  /** Notes de critère sur 100, nulles quand elles ne sont pas calculables (ou masquées pour un Utilisateur). */
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
  modelId: string;
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
  /** Entrée, sortie visible et réflexion (à part si le fournisseur la détaille, sinon comprise dans la sortie). */
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  tokensEstimated: boolean;
  costUsd: number | null;
  errorMessage: string | null;
};

export type ScoringMethod = 'expected' | 'judge' | 'manual';

/** Détail du test figé au lancement de la série : consignes envoyées et résultat attendu. */
export type AnswersTest = {
  name: string;
  category: string;
  tags: string[];
  systemPrompt: string | null;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  scoringMethod: ScoringMethod;
  scoringConfig: ScoringConfig;
  attachments: AnswerAttachment[];
};

/** `scoringMethod` : la relance du juge n'est proposée que sur un test noté par le juge. */
/** Pièce jointe de l'instantané du test, repérée par sa position. */
export type AnswerAttachment = { index: number; originalName: string; mime: string; pages: number | null };
export type Answers = {
  test: AnswersTest;
  answers: Answer[];
};

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

/** Pièce jointe d'un test de la série ; `inline` pour l'afficher dans la visionneuse. */
export function answerAttachmentUrl(runId: string, runTestId: string, index: number, inline = false): string {
  return `/api/runs/${enc(runId)}/answers/${enc(runTestId)}/attachments/${index}${inline ? '?inline=1' : ''}`;
}

export function getAnswers(runId: string, runTestId: string): Promise<Answers> {
  return apiFetch<Answers>(`/api/runs/${enc(runId)}/answers/${enc(runTestId)}`);
}

/** Adresse du CSV (téléchargement par lien : la session passe par le cookie). */
export const exportCsvUrl = (runId: string): string => `/api/runs/${enc(runId)}/export.csv`;

/** Classeur Excel de la série : classement, résultats détaillés et définitions des critères. */
export const exportXlsxUrl = (runId: string): string => `/api/runs/${enc(runId)}/export.xlsx`;

export function rescoreRun(runId: string, body: RescoreBody): Promise<{ queued: number }> {
  return apiFetch<{ queued: number }>(`/api/runs/${enc(runId)}/rescore`, { method: 'POST', body });
}

/** Note imposée par un Admin ; `null` retire l'imposition. */
export async function overrideScore(resultId: string, score: number | null): Promise<OverrideResult> {
  return (await apiFetch<{ result: OverrideResult }>(`/api/scoring/results/${enc(resultId)}/override`, { method: 'PUT', body: { score } })).result;
}
