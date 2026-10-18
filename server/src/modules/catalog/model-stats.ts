// Chiffres de la fiche d'un modèle : qualité, vitesse, fiabilité, radar par catégorie et historique des séries terminées.
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { runModels, runs } from '../../db/schema/runs.js';
import type { Actor } from '../auth/actor.js';
import { aggregateRun, rankModels, type AggregateInputRow } from '../scoring/aggregate.js';
import { hiddenQuestionsFor, loadAggregateRows, withoutHiddenScores } from '../scoring/results.service.js';

/** Au plus les 50 séries terminées les plus récentes où figure le modèle. */
const MAX_RUNS = 50;

export type Rank = { rank: number; of: number };

export type ModelStats = {
  quality: number | null;
  medianTtftMs: number | null;
  ttftRank: Rank | null;
  medianTokensPerS: number | null;
  tpsRank: Rank | null;
  reliability: number | null;
  radar: { category: string; model: number | null; average: number | null }[];
  history: {
    runId: string;
    runName: string;
    completedAt: string;
    rank: number | null;
    of: number;
    quality: number | null;
    global: number | null;
  }[];
};

const EMPTY: ModelStats = {
  quality: null,
  medianTtftMs: null,
  ttftRank: null,
  medianTokensPerS: null,
  tpsRank: null,
  reliability: null,
  radar: [],
  history: [],
};

const round2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((s, x) => s + x, 0) / v.length;
};
const roundedMean = (xs: (number | null)[]): number | null => {
  const m = mean(xs);
  return m === null ? null : round2(m);
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Rang (ex æquo : même rang) de `modelId` parmi les modèles ayant une valeur. */
function rankOf(values: Map<string, number>, modelId: string, lowerIsBetter: boolean): Rank | null {
  const mine = values.get(modelId);
  if (mine === undefined) return null;
  const better = [...values.values()].filter((v) => (lowerIsBetter ? v < mine : v > mine)).length;
  return { rank: better + 1, of: values.size };
}

/** Médiane par modèle, pour les seuls modèles ayant au moins une valeur. */
function medianByModel(samples: Map<string, number[]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, xs] of samples) {
    const m = median(xs);
    if (m !== null) out.set(id, m);
  }
  return out;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);

/**
 * Chiffres du modèle sur ses séries `completed` (50 au plus, les plus récentes) : qualité = moyenne de sa qualité par série,
 * médianes sur toutes ses réponses réussies, rangs parmi les modèles ayant au moins une réponse réussie dans ces séries.
 * Un seul chargement de résultats pour l'ensemble des séries. Pour un Utilisateur, comme sur le classement d'une série, les
 * notes des questions manuelles qu'il n'a pas complétées sont retirées, série par série.
 */
export async function computeModelStats(db: Db, modelId: string, actor: Actor): Promise<ModelStats> {
  const runRows = await db
    .select({ id: runs.id, name: runs.name, weights: runs.weights, completedAt: runs.completedAt, createdAt: runs.createdAt })
    .from(runs)
    .innerJoin(runModels, and(eq(runModels.runId, runs.id), eq(runModels.modelId, modelId)))
    .where(eq(runs.status, 'completed'))
    .orderBy(desc(runs.completedAt), desc(runs.createdAt), desc(runs.id))
    .limit(MAX_RUNS);
  if (runRows.length === 0) return EMPTY;

  const runIds = runRows.map((r) => r.id);
  const [loaded, hidden] = await Promise.all([loadAggregateRows(db, runIds), hiddenQuestionsFor(db, actor, runIds)]);
  const rows = withoutHiddenScores(loaded, hidden);
  const byRun = new Map<string, AggregateInputRow[]>();
  for (const r of rows) push(byRun, r.runId, r);

  const history: ModelStats['history'] = [];
  const modelQuality: (number | null)[] = [];
  const categories: string[] = [];
  /** Par catégorie puis par modèle : sa qualité dans chaque série où il figure. */
  const perCategory = new Map<string, Map<string, (number | null)[]>>();
  for (const run of runRows) {
    const aggs = aggregateRun(byRun.get(run.id) ?? []);
    const ranked = rankModels(aggs, run.weights).find((r) => r.modelId === modelId);
    const mine = aggs.find((a) => a.modelId === modelId);
    history.push({
      runId: run.id,
      runName: run.name,
      completedAt: (run.completedAt ?? run.createdAt).toISOString(),
      rank: ranked?.rank ?? null,
      of: aggs.length,
      quality: mine?.quality ?? null,
      global: ranked?.global ?? null,
    });
    if (mine) modelQuality.push(mine.quality);
    for (const a of aggs) {
      for (const [category, q] of Object.entries(a.byCategory)) {
        if (!categories.includes(category)) categories.push(category);
        const models = perCategory.get(category) ?? new Map<string, (number | null)[]>();
        push(models, a.modelId, q);
        perCategory.set(category, models);
      }
    }
  }

  const ttfts = new Map<string, number[]>();
  const speeds = new Map<string, number[]>();
  const counts = new Map<string, { done: number; failed: number }>();
  for (const r of rows) {
    const c = counts.get(r.modelId) ?? { done: 0, failed: 0 };
    if (r.status === 'done') {
      c.done++;
      if (r.ttftMs !== null) push(ttfts, r.modelId, r.ttftMs);
      if (r.tokensPerS !== null) push(speeds, r.modelId, r.tokensPerS);
    } else if (r.status === 'error' || r.status === 'timeout') c.failed++;
    counts.set(r.modelId, c);
  }
  const withDone = new Set([...counts].filter(([, c]) => c.done > 0).map(([id]) => id));
  const ttftMedians = medianByModel(ttfts);
  const speedMedians = medianByModel(speeds);
  const mySpeed = speedMedians.get(modelId) ?? null;
  const mine = counts.get(modelId);
  const finished = mine ? mine.done + mine.failed : 0;

  const radar = categories.map((category) => {
    const models = perCategory.get(category)!;
    return {
      category,
      model: roundedMean(models.get(modelId) ?? []),
      average: roundedMean([...models].filter(([id]) => withDone.has(id)).map(([, qs]) => mean(qs))),
    };
  });

  return {
    quality: roundedMean(modelQuality),
    medianTtftMs: ttftMedians.get(modelId) ?? null,
    ttftRank: rankOf(ttftMedians, modelId, true),
    medianTokensPerS: mySpeed === null ? null : round2(mySpeed),
    tpsRank: rankOf(speedMedians, modelId, false),
    reliability: finished === 0 ? null : round2((mine!.done / finished) * 100),
    radar,
    history,
  };
}
