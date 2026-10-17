// Pondération et classement côté client : mêmes règles que server/src/modules/scoring/aggregate.ts (globalScore, rankModels),
// pour que le classement se recalcule instantanément quand on déplace un curseur.
import type { RankingModel } from '../api/results';
import type { Weights } from '../api/runs';

export type CriteriaNotes = Pick<RankingModel, 'modelId' | 'quality' | 'speed' | 'cost' | 'reliability'>;
export type RankedEntry = { modelId: string; rank: number | null; global: number | null };
export type RankedRow = { model: RankingModel; rank: number | null; global: number | null };

export const WEIGHT_KEYS = ['quality', 'speed', 'cost', 'reliability'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Score global : moyenne pondérée des notes présentes, poids renormalisés sur ces seules notes ; nul sans qualité (modèle
 * non classé) ou si les critères notés ont tous un poids nul.
 */
export function weightedGlobal(a: CriteriaNotes, w: Weights): number | null {
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
export function rankClient(aggs: CriteriaNotes[], w: Weights): RankedEntry[] {
  const scored = aggs.map((a) => ({ modelId: a.modelId, global: weightedGlobal(a, w) }));
  const ranked = scored.filter((s) => s.global !== null).sort((a, b) => b.global! - a.global!); // tri stable
  const out: RankedEntry[] = [];
  ranked.forEach((s, i) => {
    const prev = out[i - 1];
    out.push({ modelId: s.modelId, rank: prev !== undefined && prev.global === s.global ? prev.rank : i + 1, global: s.global });
  });
  for (const s of scored) if (s.global === null) out.push({ modelId: s.modelId, rank: null, global: null });
  return out;
}

/** Classement joint aux modèles (même ordre que `rankClient`). */
export function rankedRows(models: RankingModel[], w: Weights): RankedRow[] {
  const byId = new Map(models.map((m) => [m.modelId, m]));
  return rankClient(models, w).map((e) => ({ model: byId.get(e.modelId)!, rank: e.rank, global: e.global }));
}

/**
 * Nouvelle pondération quand le curseur `key` passe à `value` : les trois autres sont ramenées proportionnellement pour que
 * la somme reste 100 (entiers, plus grands restes ; à parts égales si elles valaient toutes 0).
 */
export function rebalance(w: Weights, key: WeightKey, value: number): Weights {
  const v = Math.min(100, Math.max(0, Math.round(value)));
  const others = WEIGHT_KEYS.filter((k) => k !== key);
  const rest = 100 - v;
  const otherSum = others.reduce((s, k) => s + w[k], 0);
  const exact = others.map((k) => (otherSum === 0 ? rest / others.length : (w[k] / otherSum) * rest));
  const floors = exact.map(Math.floor);
  let missing = rest - floors.reduce((s, x) => s + x, 0);
  const byRemainder = exact.map((x, i) => ({ i, r: x - floors[i]! })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (missing === 0) break;
    floors[i]!++;
    missing--;
  }
  const out = { ...w, [key]: v };
  others.forEach((k, i) => {
    out[k] = floors[i]!;
  });
  return out;
}

export const sameWeights = (a: Weights, b: Weights): boolean => WEIGHT_KEYS.every((k) => a[k] === b[k]);
