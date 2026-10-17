import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { shareLinks } from '../../db/schema/sharing.js';
import { NotFoundError } from '../../errors.js';
import { roundUsd } from '../../lib/money.js';
import type { Weights } from '../runs/runs.service.js';
import { aggregateRun, rankModels, type AggregateInputRow } from '../scoring/aggregate.js';
import { finalScore } from '../scoring/override.js';
import { manualAvg, type RankingModel } from '../scoring/results.service.js';
import { getAuditUrl } from './share-links.service.js';
import { hashShareToken } from './token.js';

/** Modèle de la page publique : même forme que le classement, mais désigné par une clé opaque (`m1`, `m2`…). */
export type PublicModel = RankingModel & { modelId: `m${number}`; rank: number | null; global: number | null };

export type PublicShare = {
  title: string;
  intro: string | null;
  auditUrl: string;
  showCosts: boolean;
  run: {
    name: string;
    completedAt: string | null;
    modelCount: number;
    testCount: number;
    repetitions: number;
    judgeName: string | null;
    totalCostUsd: number | null;
  };
  weights: Weights;
  categories: string[];
  models: PublicModel[];
  verdicts: { label: string; text: string; model: { key: string; name: string; color: string } | null }[];
  responses:
    | {
        testName: string;
        category: string;
        userPrompt: string;
        answers: { modelKey: string; repetition: number; text: string | null; finalScore: number | null; judgeRationale: string | null }[];
      }[]
    | null;
};

export const shareNotFound = () => new NotFoundError('Lien introuvable ou désactivé');
const notFound = shareNotFound;

/**
 * Page publique d'un lien : liste blanche construite champ par champ (aucun identifiant interne, aucune note individuelle).
 * Les agrégats couvrent tous les évaluateurs : c'est la publication de l'Admin, sans masquage de l'aveugle.
 * Un jeton inconnu, désactivé ou régénéré renvoie le même 404 ; chaque consultation incrémente `view_count`.
 */
export async function loadPublicShare(db: Db, token: string): Promise<PublicShare> {
  const [link] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tokenHash, hashShareToken(token)), eq(shareLinks.active, true)));
  if (!link) throw notFound();

  const runId = link.runId;
  const [[run], rows, modelRows, testRows, auditUrl] = await Promise.all([
    db
      .select({
        name: runs.name,
        weights: runs.weights,
        repetitions: runs.repetitions,
        completedAt: runs.completedAt,
        modelsCostUsd: runs.modelsCostUsd,
        judgeCostUsd: runs.judgeCostUsd,
        judgeName: models.displayName,
      })
      .from(runs)
      .leftJoin(models, eq(models.id, runs.judgeModelId))
      .where(eq(runs.id, runId)),
    db
      .select({
        runTestId: results.runTestId,
        modelId: results.modelId,
        repetition: results.repetition,
        status: results.status,
        scoreStatus: results.scoreStatus,
        overrideScore: results.overrideScore,
        autoScore: results.autoScore,
        manualAvg,
        ttftMs: results.ttftMs,
        tokensPerS: results.tokensPerS,
        costUsd: results.costUsd,
        // Les textes ne sont lus que si le lien publie les réponses.
        text: link.showResponses ? results.responseText : sql<string | null>`NULL`,
        judgeRationale: link.showResponses ? results.judgeRationale : sql<string | null>`NULL`,
      })
      .from(results)
      .where(eq(results.runId, runId)),
    db
      .select({ modelId: runModels.modelId, name: models.displayName, color: models.color, providerName: providers.name })
      .from(runModels)
      .innerJoin(models, eq(models.id, runModels.modelId))
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(eq(runModels.runId, runId))
      .orderBy(asc(runModels.addedAt), asc(models.displayName)),
    db.select({ id: runTests.id, snapshot: runTests.snapshot }).from(runTests).where(eq(runTests.runId, runId)).orderBy(asc(runTests.position)),
    getAuditUrl(db),
  ]);
  if (!run) throw notFound();

  const showCosts = link.showCosts;
  const categories = [...new Set(testRows.map((t) => t.snapshot.category))];

  // Une seule lecture des résultats : agrégats et réponses en sont tirés ; la note finale n'est calculée qu'une fois.
  const snapshotOf = new Map(testRows.map((t) => [t.id, t.snapshot]));
  const scored = rows.map((r) => {
    const snap = snapshotOf.get(r.runTestId)!;
    const score = finalScore({ overrideScore: r.overrideScore, autoScore: r.autoScore, manualAvg: r.manualAvg, method: snap.scoringMethod });
    return { row: r, score };
  });
  const aggRows: AggregateInputRow[] = scored.map(({ row: r }) => ({
    modelId: r.modelId,
    runTestId: r.runTestId,
    category: snapshotOf.get(r.runTestId)!.category,
    scoringMethod: snapshotOf.get(r.runTestId)!.scoringMethod,
    status: r.status,
    overrideScore: r.overrideScore,
    autoScore: r.autoScore,
    manualAvg: r.manualAvg,
    ttftMs: r.ttftMs,
    tokensPerS: r.tokensPerS,
    costUsd: r.costUsd,
  }));

  // Classement de la série (pondération enregistrée sur la série) ; la clé opaque suit cet ordre.
  const aggs = new Map(aggregateRun(aggRows).map((a) => [a.modelId, a]));
  const ordered = modelRows.flatMap((m) => {
    const a = aggs.get(m.modelId);
    return a ? [{ ...a, ...m }] : [];
  });
  // Rang et score global avec la pondération complète de la série (coût compris, même masqué).
  const ranked = rankModels(ordered, run.weights);
  const position = new Map(ranked.map((r, i) => [r.modelId, i]));
  const rankOf = new Map(ranked.map((r) => [r.modelId, r]));
  ordered.sort((a, b) => position.get(a.modelId)! - position.get(b.modelId)!);
  const keyOf = new Map(ordered.map((m, i) => [m.modelId, `m${i + 1}` as const]));

  const publicModels: PublicModel[] = ordered.map((m) => ({
    modelId: keyOf.get(m.modelId)!,
    rank: rankOf.get(m.modelId)!.rank,
    global: rankOf.get(m.modelId)!.global,
    quality: m.quality,
    speed: m.speed,
    cost: showCosts ? m.cost : null,
    reliability: m.reliability,
    raw: {
      medianTtftMs: m.raw.medianTtftMs,
      medianTokensPerS: m.raw.medianTokensPerS,
      meanCostUsd: showCosts ? m.raw.meanCostUsd : null,
      done: m.raw.done,
      failed: m.raw.failed,
      unsupported: m.raw.unsupported,
      scoredTests: m.raw.scoredTests,
    },
    byCategory: { ...m.byCategory },
    name: m.name,
    color: m.color,
    providerName: m.providerName,
  }));

  const byModel = new Map(ordered.map((m) => [m.modelId, m]));
  const verdicts = link.verdicts.map((v) => {
    const model = v.modelId === null ? undefined : byModel.get(v.modelId);
    return {
      label: v.label,
      text: v.text,
      model: model ? { key: keyOf.get(model.modelId)!, name: model.name, color: model.color } : null,
    };
  });

  let responses: PublicShare['responses'] = null;
  if (link.showResponses) {
    type PublicAnswer = NonNullable<PublicShare['responses']>[number]['answers'][number] & { order: number };
    const byTest = new Map<string, PublicAnswer[]>();
    for (const { row: r, score } of scored) {
      const key = keyOf.get(r.modelId);
      if (r.status !== 'done' || key === undefined) continue;
      const list = byTest.get(r.runTestId) ?? [];
      list.push({
        order: Number(key.slice(1)),
        modelKey: key,
        repetition: r.repetition,
        text: r.text,
        finalScore: score,
        // Hors note réussie, ce champ peut contenir le message d'échec du juge : jamais publié.
        judgeRationale: r.scoreStatus === 'done' ? r.judgeRationale : null,
      });
      byTest.set(r.runTestId, list);
    }
    responses = testRows.map((t) => ({
      testName: t.snapshot.name,
      category: t.snapshot.category,
      userPrompt: t.snapshot.userPrompt,
      answers: (byTest.get(t.id) ?? [])
        .sort((a, b) => a.order - b.order || a.repetition - b.repetition)
        .map((a) => ({ modelKey: a.modelKey, repetition: a.repetition, text: a.text, finalScore: a.finalScore, judgeRationale: a.judgeRationale })),
    }));
  }

  // Vue comptée seulement une fois la page construite.
  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.id, link.id));

  return {
    title: link.title,
    intro: link.intro,
    auditUrl,
    showCosts,
    run: {
      name: run.name,
      completedAt: run.completedAt?.toISOString() ?? null,
      modelCount: publicModels.length,
      testCount: testRows.length,
      repetitions: run.repetitions,
      judgeName: run.judgeName,
      totalCostUsd: showCosts ? roundUsd(run.modelsCostUsd + run.judgeCostUsd) : null,
    },
    weights: { quality: run.weights.quality, speed: run.weights.speed, cost: run.weights.cost, reliability: run.weights.reliability },
    categories,
    models: publicModels,
    verdicts,
    responses,
  };
}
