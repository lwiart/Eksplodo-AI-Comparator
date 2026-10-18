import { apiFetch } from './client';

// Types miroirs de server/src/modules/runs/ (runs.service.ts, estimate.ts, progress.ts, runs.repo.ts).
export type Weights = { quality: number; speed: number; cost: number; reliability: number };
export const DEFAULT_WEIGHTS: Weights = { quality: 50, speed: 20, cost: 20, reliability: 10 };

export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'interrupted';
export type PauseReason = 'user' | 'budget' | null;
/** `truncated` : réponse vide, la réflexion du modèle a épuisé la limite de tokens. */
export type ResultStatus = 'pending' | 'running' | 'done' | 'error' | 'timeout' | 'unsupported' | 'truncated';

export type RunInput = {
  name: string;
  suiteId?: string;
  testIds: string[];
  modelIds: string[];
  repetitions: number;
  concurrency: number;
  judgeModelId?: string | null;
  budgetUsd?: number | null;
  weights?: Weights;
};

export type RunPatch = { name?: string; budgetUsd?: number | null; weights?: Weights };

export type StatusCounts = {
  pending: number;
  running: number;
  done: number;
  error: number;
  timeout: number;
  unsupported: number;
  truncated: number;
  total: number;
};

export type RunEstimate = {
  /** Toutes les combinaisons test × modèle × répétition, y compris les non supportées. */
  calls: number;
  /** Sous-ensemble de `calls`. */
  unsupported: number;
  modelsMaxCostUsd: number;
  judgeMaxCostUsd: number;
  maxCostUsd: number;
  durationSeconds: number;
  perModel: { modelId: string; calls: number; unsupported: number; maxCostUsd: number }[];
  warnings: string[];
};

export type RunSummary = {
  id: string;
  name: string;
  status: RunStatus;
  pauseReason: PauseReason;
  suiteName: string | null;
  modelCount: number;
  testCount: number;
  repetitions: number;
  judgeModelName: string | null;
  modelsCostUsd: number;
  judgeCostUsd: number;
  budgetUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts: StatusCounts;
};

export type MatrixCell = { modelId: string; pending: number; running: number; done: number; failed: number; unsupported: number; truncated: number };

export type RunProgress = {
  status: RunStatus;
  pauseReason: PauseReason;
  counts: StatusCounts;
  modelsCostUsd: number;
  judgeCostUsd: number;
  budgetUsd: number | null;
  /** Après une pause budget : coût maximal du prochain appel (le moins cher en attente), à ajouter à la dépense pour reprendre. */
  nextCallMaxCostUsd: number | null;
  /** Notes du juge en attente (résultats terminés d'un test noté par le juge). */
  judgePending: number;
  startedAt: string | null;
  elapsedMs: number;
  etaSeconds: number | null;
  running: { modelId: string; testName: string }[];
  activity: {
    resultId: string;
    testName: string;
    modelId: string;
    modelName: string;
    color: string;
    status: ResultStatus;
    /** Nuls quand `hiddenUntilScored` : question manuelle pas encore notée par ce compte. */
    totalMs: number | null;
    costUsd: number | null;
    completedAt: string;
    hiddenUntilScored: boolean;
  }[];
  matrix: { runTestId: string; testName: string; category: string; cells: MatrixCell[] }[];
  models: { id: string; name: string; color: string }[];
};

export type ResultRow = {
  id: string;
  runTestId: string;
  testName: string;
  category: string;
  modelId: string;
  modelName: string;
  color: string;
  repetition: number;
  status: ResultStatus;
  /** Nul, comme le texte et les autres mesures, quand `hiddenUntilScored`. */
  attempts: number | null;
  responseText: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  tokensEstimated: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  tokensPerS: number | null;
  costUsd: number | null;
  costSource: 'computed' | 'provider' | null;
  errorCode: string | null;
  errorMessage: string | null;
  scoreStatus: 'pending' | 'done' | 'awaiting_manual' | 'judge_failed';
  completedAt: string | null;
  /** Test manuel que ce compte n'a pas encore noté : texte et mesures masqués (nuls). */
  hiddenUntilScored: boolean;
};

export const RUNS_KEY = ['runs'] as const;

const enc = encodeURIComponent;

export async function estimateRun(body: RunInput): Promise<RunEstimate> {
  return (await apiFetch<{ estimate: RunEstimate }>('/api/runs/estimate', { method: 'POST', body })).estimate;
}

export async function createRun(body: RunInput): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>('/api/runs', { method: 'POST', body })).run;
}

export async function listRuns(): Promise<RunSummary[]> {
  return (await apiFetch<{ runs: RunSummary[] }>('/api/runs')).runs;
}

export async function getRun(id: string): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}`)).run;
}

export async function getRunProgress(id: string): Promise<RunProgress> {
  return (await apiFetch<{ progress: RunProgress }>(`/api/runs/${enc(id)}/progress`)).progress;
}

export async function getRunResults(id: string): Promise<ResultRow[]> {
  return (await apiFetch<{ results: ResultRow[] }>(`/api/runs/${enc(id)}/results`)).results;
}

export async function pauseRun(id: string): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}/pause`, { method: 'POST' })).run;
}

export async function resumeRun(id: string): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}/resume`, { method: 'POST' })).run;
}

export async function retryRunErrors(id: string): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}/retry-errors`, { method: 'POST' })).run;
}

export async function addRunModels(id: string, modelIds: string[]): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}/models`, { method: 'POST', body: { modelIds } })).run;
}

export async function updateRun(id: string, patch: RunPatch): Promise<RunSummary> {
  return (await apiFetch<{ run: RunSummary }>(`/api/runs/${enc(id)}`, { method: 'PATCH', body: patch })).run;
}

/** Renommage d'une série (Admin) : nom de 1 à 200 caractères, espaces de début et de fin retirés par le serveur. */
export function renameRun(id: string, name: string): Promise<RunSummary> {
  return updateRun(id, { name });
}
