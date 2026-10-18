// Agrégation et classement des modèles d'une série (fonctions pures) : qualité, vitesse, coût, fiabilité, score global.
import { roundUsd } from '../../lib/money.js';
import type { ResultStatus } from '../runs/runs.repo.js';
import type { Weights } from '../runs/runs.service.js';
import type { ScoringMethod } from '../tests/scoring-config.js';
import { finalScore } from './override.js';

/** Un résultat de la série, réduit à ce que l'agrégation lit (jamais le coût du juge : il n'est pas imputé au modèle). */
export type AggregateInputRow = {
  modelId: string;
  runTestId: string;
  category: string;
  scoringMethod: ScoringMethod;
  status: ResultStatus;
  overrideScore: number | null;
  autoScore: number | null;
  /** Moyenne des évaluateurs (nulle sans note). */
  manualAvg: number | null;
  ttftMs: number | null;
  tokensPerS: number | null;
  costUsd: number | null;
};

export type ModelAggregate = {
  modelId: string;
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
  /** Qualité par catégorie de test (toutes les catégories de la série ; nulle sans test noté). */
  byCategory: Record<string, number | null>;
};

export type RankedModel = { modelId: string; rank: number | null; global: number | null };

const round2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const present = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);

/**
 * Note logarithmique de 20 à 100 entre `lo` et `hi` : du simple au double pèse autant quelle que soit l'échelle.
 * Valeurs toutes égales (ou un seul modèle) : 100.
 */
export function logScore(x: number, lo: number, hi: number, higherIsBetter: boolean): number {
  if (hi <= lo) return 100;
  const ratio = Math.log(x / lo) / Math.log(hi / lo);
  return 20 + 80 * (higherIsBetter ? ratio : 1 - ratio);
}

/**
 * Note logarithmique de chaque valeur parmi celles des modèles de la série ; `lo` et `hi` pris sur les valeurs > 0,
 * une valeur nulle, négative ou absente a une note nulle.
 */
function logScores(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const positive = values.filter((v): v is number => v !== null && v > 0);
  const lo = Math.min(...positive);
  const hi = Math.max(...positive);
  return values.map((v) => (v === null || v <= 0 ? null : logScore(v, lo, hi, higherIsBetter)));
}

/** Qualité : moyenne, sur les tests notés, de la moyenne des répétitions notées. */
function qualityOf(scoresByTest: Map<string, number[]>): number | null {
  const q = mean([...scoresByTest.values()].map((s) => mean(s)!));
  return q === null ? null : round2(q);
}

type ModelAcc = {
  done: AggregateInputRow[];
  failed: number;
  unsupported: number;
  /** Notes finales par test, puis par catégorie et test. */
  scores: Map<string, number[]>;
  byCategory: Map<string, Map<string, number[]>>;
};

/**
 * Agrégats par modèle (ordre de première apparition dans `rows`). Qualité sur les résultats `done` ayant une note finale
 * (note imposée, sinon note de la méthode) ; vitesse et coût sur les résultats `done` ; fiabilité = réussis ÷ (réussis +
 * erreurs + délais dépassés) × 100, les `unsupported` exclus ; notes sur 100 arrondies au centième.
 */
export function aggregateRun(rows: AggregateInputRow[]): ModelAggregate[] {
  const categories: string[] = [];
  const accs = new Map<string, ModelAcc>();
  for (const r of rows) {
    if (!categories.includes(r.category)) categories.push(r.category);
    let acc = accs.get(r.modelId);
    if (!acc) {
      acc = { done: [], failed: 0, unsupported: 0, scores: new Map(), byCategory: new Map() };
      accs.set(r.modelId, acc);
    }
    if (r.status === 'error' || r.status === 'timeout') acc.failed++;
    if (r.status === 'unsupported') acc.unsupported++;
    if (r.status !== 'done') continue;
    acc.done.push(r);
    const score = finalScore({ overrideScore: r.overrideScore, autoScore: r.autoScore, manualAvg: r.manualAvg, method: r.scoringMethod });
    if (score === null) continue;
    acc.scores.set(r.runTestId, [...(acc.scores.get(r.runTestId) ?? []), score]);
    const inCategory = acc.byCategory.get(r.category) ?? new Map<string, number[]>();
    inCategory.set(r.runTestId, [...(inCategory.get(r.runTestId) ?? []), score]);
    acc.byCategory.set(r.category, inCategory);
  }

  const models = [...accs.entries()].map(([modelId, acc]) => ({
    modelId,
    acc,
    medianTtftMs: median(present(acc.done.map((r) => r.ttftMs))),
    medianTokensPerS: median(present(acc.done.map((r) => r.tokensPerS))),
    /** Non arrondi : la note de coût ne dépend pas de l'arrondi d'affichage. */
    meanCostUsd: mean(present(acc.done.map((r) => r.costUsd))),
  }));
  const ttftScores = logScores(models.map((m) => m.medianTtftMs), false);
  const tpsScores = logScores(models.map((m) => m.medianTokensPerS), true);
  const costScores = logScores(models.map((m) => m.meanCostUsd), false);

  return models.map(({ modelId, acc, medianTtftMs, medianTokensPerS, meanCostUsd }, i) => {
    const speed = mean(present([ttftScores[i]!, tpsScores[i]!]));
    const cost = costScores[i]!;
    const finished = acc.done.length + acc.failed;
    return {
      modelId,
      quality: qualityOf(acc.scores),
      speed: speed === null ? null : round2(speed),
      cost: cost === null ? null : round2(cost),
      reliability: finished === 0 ? null : round2((acc.done.length / finished) * 100),
      raw: {
        medianTtftMs,
        medianTokensPerS: medianTokensPerS === null ? null : round2(medianTokensPerS),
        meanCostUsd: meanCostUsd === null ? null : roundUsd(meanCostUsd),
        done: acc.done.length,
        failed: acc.failed,
        unsupported: acc.unsupported,
        scoredTests: acc.scores.size,
      },
      byCategory: Object.fromEntries(categories.map((c) => [c, qualityOf(acc.byCategory.get(c) ?? new Map())])),
    };
  });
}

/**
 * Score global : moyenne pondérée des notes présentes, poids renormalisés sur ces seules notes ; nul sans qualité (modèle
 * non classé) ou si les critères notés ont tous un poids nul.
 */
export function globalScore(a: ModelAggregate, w: Weights): number | null {
  if (a.quality === null) return null;
  const parts = [
    [a.quality, w.quality],
    [a.speed, w.speed],
    [a.cost, w.cost],
    [a.reliability, w.reliability],
  ] as const;
  let sum = 0;
  let weight = 0;
  for (const [note, wt] of parts) {
    if (note === null) continue;
    sum += note * wt;
    weight += wt;
  }
  return weight === 0 ? null : round2(sum / weight);
}

/**
 * Classement par score global décroissant (ex æquo : même rang, ordre d'entrée conservé) ; les modèles sans score global
 * n'ont pas de rang (hors podium) et viennent en fin de liste.
 */
export function rankModels(aggs: ModelAggregate[], w: Weights): RankedModel[] {
  const scored = aggs.map((a) => ({ modelId: a.modelId, global: globalScore(a, w) }));
  const ranked = scored.filter((s) => s.global !== null).sort((a, b) => b.global! - a.global!); // tri stable
  const out: RankedModel[] = [];
  ranked.forEach((s, i) => {
    const prev = out[i - 1];
    out.push({ modelId: s.modelId, rank: prev !== undefined && prev.global === s.global ? prev.rank : i + 1, global: s.global });
  });
  for (const s of scored) if (s.global === null) out.push({ modelId: s.modelId, rank: null, global: null });
  return out;
}
