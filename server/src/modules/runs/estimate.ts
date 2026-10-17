import type { JudgeConfig } from '../tests/scoring-config.js';
import type { TestSnapshot } from './snapshot.js';

export type ModelForEstimate = {
  id: string;
  name: string;
  inputPricePerM: number;
  outputPricePerM: number;
  supportsVision: boolean;
  supportsPdf: boolean;
  /** Médiane historique de `total_ms` des résultats `done` du modèle ; `null` si inconnue. */
  medianTotalMs: number | null;
};

export type RunEstimate = {
  /** Toutes les combinaisons test × modèle × répétition, y compris les non supportées. */
  calls: number;
  unsupported: number;
  modelsMaxCostUsd: number;
  judgeMaxCostUsd: number;
  maxCostUsd: number;
  durationSeconds: number;
  perModel: { modelId: string; calls: number; unsupported: number; maxCostUsd: number }[];
  warnings: string[];
};

const TOKENS_PER_IMAGE = 1500;
const TOKENS_PER_PDF_PAGE = 800;
const JUDGE_OVERHEAD_TOKENS = 300;
const JUDGE_OUTPUT_TOKENS = 800;
const DEFAULT_CALL_MS = 10_000;

const tokensOfChars = (chars: number) => Math.ceil(chars / 4);

export function estimateInputTokens(s: TestSnapshot): number {
  let tokens = tokensOfChars((s.systemPrompt?.length ?? 0) + s.userPrompt.length);
  for (const a of s.attachments) {
    tokens += a.mime === 'application/pdf' ? (a.pages ?? 1) * TOKENS_PER_PDF_PAGE : TOKENS_PER_IMAGE;
  }
  return tokens;
}

export function isSupported(s: TestSnapshot, m: Pick<ModelForEstimate, 'supportsVision' | 'supportsPdf'>): boolean {
  return s.attachments.every((a) => (a.mime === 'application/pdf' ? m.supportsPdf : m.supportsVision));
}

type Prices = Pick<ModelForEstimate, 'inputPricePerM' | 'outputPricePerM'>;

const costUsd = (inputTokens: number, outputTokens: number, m: Prices) =>
  (inputTokens * m.inputPricePerM + outputTokens * m.outputPricePerM) / 1_000_000;

/** Coût maximal d'un appel : entrée estimée + `max_tokens` de sortie. */
export function maxCallCostUsd(s: TestSnapshot, m: Prices): number {
  return costUsd(estimateInputTokens(s), s.maxTokens, m);
}

function maxJudgeCallCostUsd(s: TestSnapshot, judge: ModelForEstimate): number {
  const cfg = s.scoringConfig as JudgeConfig;
  const chars = (s.systemPrompt?.length ?? 0) + s.userPrompt.length + cfg.criteria.length + (cfg.reference?.length ?? 0);
  return costUsd(tokensOfChars(chars) + s.maxTokens + JUDGE_OVERHEAD_TOKENS, JUDGE_OUTPUT_TOKENS, judge);
}

export function estimateRun(input: {
  tests: TestSnapshot[];
  models: ModelForEstimate[];
  repetitions: number;
  concurrency: number;
  judge: ModelForEstimate | null;
}): RunEstimate {
  const { tests, models, repetitions, concurrency, judge } = input;
  const judged = tests.filter((t) => t.scoringMethod === 'judge');
  const warnings: string[] = [];

  let judgeMaxCostUsd = 0;
  let totalMs = 0;
  const perModel = models.map((m) => {
    let unsupportedTests = 0;
    let costPerRep = 0;
    let judgePerRep = 0;
    for (const t of tests) {
      if (!isSupported(t, m)) {
        unsupportedTests++;
        continue;
      }
      costPerRep += maxCallCostUsd(t, m);
      if (judge && t.scoringMethod === 'judge') judgePerRep += maxJudgeCallCostUsd(t, judge);
    }
    judgeMaxCostUsd += judgePerRep * repetitions;
    // Seuls les appels réellement exécutés comptent dans la durée.
    totalMs += (tests.length - unsupportedTests) * repetitions * (m.medianTotalMs ?? DEFAULT_CALL_MS);
    return {
      modelId: m.id,
      calls: tests.length * repetitions,
      unsupported: unsupportedTests * repetitions,
      maxCostUsd: costPerRep * repetitions,
    };
  });

  if (judge && models.some((m) => m.id === judge.id)) warnings.push('Le modèle juge fait partie des modèles évalués');
  if (judge) {
    const blind = judged.filter((t) => !isSupported(t, judge)).length;
    if (blind > 0) {
      warnings.push(`Le juge ne gère pas les pièces jointes de ${blind} test${blind > 1 ? 's' : ''} noté${blind > 1 ? 's' : ''} par le juge`);
    }
  }

  const modelsMaxCostUsd = perModel.reduce((sum, p) => sum + p.maxCostUsd, 0);
  return {
    calls: perModel.reduce((sum, p) => sum + p.calls, 0),
    unsupported: perModel.reduce((sum, p) => sum + p.unsupported, 0),
    modelsMaxCostUsd,
    judgeMaxCostUsd,
    maxCostUsd: modelsMaxCostUsd + judgeMaxCostUsd,
    durationSeconds: totalMs / 1000 / Math.max(1, concurrency),
    perModel,
    warnings,
  };
}
