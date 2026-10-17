import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { shareLinks } from '../../db/schema/sharing.js';
import { NotFoundError } from '../../errors.js';
import { roundUsd } from '../../lib/money.js';
import type { Weights } from '../runs/runs.service.js';
import { aggregateRun, rankModels } from '../scoring/aggregate.js';
import { finalScore } from '../scoring/override.js';
import { loadAggregateRows, manualAvg, type RankingModel } from '../scoring/results.service.js';
import { getAuditUrl } from './share-links.service.js';
import { hashShareToken } from './token.js';

/** Modèle de la page publique : même forme que le classement, mais désigné par une clé opaque (`m1`, `m2`…). */
export type PublicModel = RankingModel & { modelId: `m${number}` };

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

const notFound = () => new NotFoundError('Lien introuvable ou désactivé');

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

  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.id, link.id));

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
    loadAggregateRows(db, [runId]),
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

  // Classement de la série (pondération enregistrée sur la série) ; la clé opaque suit cet ordre.
  const aggs = new Map(aggregateRun(rows).map((a) => [a.modelId, a]));
  const ordered = modelRows.flatMap((m) => {
    const a = aggs.get(m.modelId);
    return a ? [{ ...a, ...m }] : [];
  });
  const position = new Map(rankModels(ordered, run.weights).map((r, i) => [r.modelId, i]));
  ordered.sort((a, b) => position.get(a.modelId)! - position.get(b.modelId)!);
  const keyOf = new Map(ordered.map((m, i) => [m.modelId, `m${i + 1}` as const]));

  const publicModels: PublicModel[] = ordered.map((m) => ({
    modelId: keyOf.get(m.modelId)!,
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
    const answerRows = await db
      .select({
        runTestId: results.runTestId,
        modelId: results.modelId,
        repetition: results.repetition,
        text: results.responseText,
        overrideScore: results.overrideScore,
        autoScore: results.autoScore,
        judgeRationale: results.judgeRationale,
        manualAvg,
      })
      .from(results)
      .innerJoin(runTests, eq(runTests.id, results.runTestId))
      .innerJoin(runModels, and(eq(runModels.runId, results.runId), eq(runModels.modelId, results.modelId)))
      .innerJoin(models, eq(models.id, results.modelId))
      .where(and(eq(results.runId, runId), eq(results.status, 'done')))
      .orderBy(asc(runTests.position), asc(runModels.addedAt), asc(models.displayName), asc(results.repetition), asc(results.id));
    responses = testRows.map((t) => ({
      testName: t.snapshot.name,
      category: t.snapshot.category,
      userPrompt: t.snapshot.userPrompt,
      answers: answerRows
        .filter((a) => a.runTestId === t.id && keyOf.has(a.modelId))
        .map((a) => ({
          modelKey: keyOf.get(a.modelId)!,
          repetition: a.repetition,
          text: a.text,
          finalScore: finalScore({ overrideScore: a.overrideScore, autoScore: a.autoScore, manualAvg: a.manualAvg, method: t.snapshot.scoringMethod }),
          judgeRationale: a.judgeRationale,
        })),
    }));
  }

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
