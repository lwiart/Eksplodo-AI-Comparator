// Tableau de bord : chiffres clés, dernières séries et évolution de la qualité d'une suite.
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { runModels, runs } from '../../db/schema/runs.js';
import { suites } from '../../db/schema/tests.js';
import { NotFoundError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { roundUsd } from '../../lib/money.js';
import type { Actor } from '../auth/actor.js';
import type { RunSummary } from '../runs/runs.service.js';
import { monthSpend } from '../usage/usage.js';
import { aggregateRun, rankModels, type AggregateInputRow, type ModelAggregate } from '../scoring/aggregate.js';
import { createManualScoringService, type ManualScoringDeps } from '../scoring/manual.service.js';
import { hiddenQuestionsFor, loadAggregateRows, withoutHiddenScores } from '../scoring/results.service.js';
import type { Weights } from '../runs/runs.service.js';

const MONTH_ZONE = 'Europe/Paris';
const RECENT_RUNS = 5;
const EVOLUTION_RUNS = 6;

export type Dashboard = {
  runs: { total: number; thisMonth: number };
  models: { tracked: number; providers: number };
  spend: { monthUsd: number; judgeUsd: number } | null;
  toScore: { questions: number; runName: string | null };
  recentRuns: {
    id: string;
    name: string;
    suiteName: string | null;
    status: RunSummary['status'];
    modelCount: number;
    winner: { name: string; color: string } | null;
    costUsd: number;
    completedAt: string | null;
    createdAt: string;
  }[];
  evolutionSuites: { id: string; name: string }[];
};

export type Evolution = {
  suite: { id: string; name: string };
  runs: { id: string; name: string; completedAt: string; judgeName: string | null }[];
  series: { modelId: string; name: string; color: string; points: (number | null)[] }[];
};

export type DashboardDeps = ManualScoringDeps & { clock: Clock };

/** Lignes d'agrégation regroupées par série. */
function groupByRun<T extends { runId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.runId, [...(out.get(r.runId) ?? []), r]);
  return out;
}

/** Agrégats de chaque série, avec le masquage de l'aveugle appliqué au compte (un seul chargement de résultats). */
async function aggregatesByRun(db: Db, actor: Actor, runIds: string[]): Promise<Map<string, ModelAggregate[]>> {
  const [loaded, hidden] = await Promise.all([loadAggregateRows(db, runIds), hiddenQuestionsFor(db, actor, runIds)]);
  const byRun = groupByRun(withoutHiddenScores(loaded, hidden));
  return new Map(runIds.map((id) => [id, aggregateRun((byRun.get(id) ?? []) as AggregateInputRow[])]));
}

export function createDashboardService(deps: DashboardDeps) {
  const { db, clock } = deps;
  const manual = createManualScoringService(deps);

  /** Vainqueur (rang 1 selon la pondération de la série) ; nul si aucun modèle n'a de qualité. */
  const winnerOf = (aggs: ModelAggregate[], weights: Weights): string | null => {
    const first = rankModels(aggs, weights)[0];
    return first !== undefined && first.rank === 1 ? first.modelId : null;
  };

  return {
    async overview(actor: Actor): Promise<Dashboard> {
      const now = clock();
      const monthStart = DateTime.fromJSDate(now, { zone: MONTH_ZONE }).startOf('month').toJSDate();
      const [[total], [thisMonth], [tracked], [providerCount], recent, todo, spend, suiteRows] = await Promise.all([
        db.select({ n: count() }).from(runs),
        db.select({ n: count() }).from(runs).where(gte(runs.createdAt, monthStart)),
        db.select({ n: count() }).from(models).where(eq(models.enabled, true)),
        db
          .select({ n: sql<number>`COUNT(DISTINCT ${providers.id})`.mapWith(Number) })
          .from(providers)
          .innerJoin(models, and(eq(models.providerId, providers.id), eq(models.enabled, true)))
          .where(eq(providers.enabled, true)),
        db
          .select({
            id: runs.id,
            name: runs.name,
            status: runs.status,
            weights: runs.weights,
            suiteName: suites.name,
            modelsCostUsd: runs.modelsCostUsd,
            judgeCostUsd: runs.judgeCostUsd,
            completedAt: runs.completedAt,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .leftJoin(suites, eq(suites.id, runs.suiteId))
          .orderBy(desc(runs.createdAt), desc(runs.id))
          .limit(RECENT_RUNS),
        manual.todo(actor),
        actor.role === 'admin' ? monthSpend(db, now) : Promise.resolve(null),
        db
          .select({ id: suites.id, name: suites.name, lastUsed: sql<Date>`MAX(COALESCE(${runs.completedAt}, ${runs.createdAt}))` })
          .from(suites)
          .innerJoin(runs, and(eq(runs.suiteId, suites.id), eq(runs.status, 'completed')))
          .groupBy(suites.id, suites.name)
          .orderBy(desc(sql`MAX(COALESCE(${runs.completedAt}, ${runs.createdAt}))`), asc(suites.name)),
      ]);

      const runIds = recent.map((r) => r.id);
      const [sizes, aggs] = await Promise.all([
        runIds.length === 0
          ? []
          : db
              .select({ runId: runModels.runId, n: count() })
              .from(runModels)
              .where(inArray(runModels.runId, runIds))
              .groupBy(runModels.runId),
        aggregatesByRun(db, actor, runIds),
      ]);
      const winnerIds = new Map(recent.map((r) => [r.id, winnerOf(aggs.get(r.id) ?? [], r.weights)]));
      const wanted = [...new Set([...winnerIds.values()].filter((id): id is string => id !== null))];
      const winners = new Map(
        (wanted.length === 0
          ? []
          : await db.select({ id: models.id, name: models.displayName, color: models.color }).from(models).where(inArray(models.id, wanted))
        ).map((m) => [m.id, { name: m.name, color: m.color }]),
      );
      const modelCounts = new Map(sizes.map((s) => [s.runId, s.n]));

      return {
        runs: { total: total?.n ?? 0, thisMonth: thisMonth?.n ?? 0 },
        models: { tracked: tracked?.n ?? 0, providers: providerCount?.n ?? 0 },
        spend: spend === null ? null : { monthUsd: spend.totalUsd, judgeUsd: spend.judgeUsd },
        // `todo` est trié de la série la plus récente à la plus ancienne.
        toScore: { questions: todo.count, runName: todo.items[0]?.runName ?? null },
        recentRuns: recent.map((r) => {
          const winnerId = winnerIds.get(r.id) ?? null;
          return {
            id: r.id,
            name: r.name,
            suiteName: r.suiteName,
            status: r.status,
            modelCount: modelCounts.get(r.id) ?? 0,
            winner: winnerId === null ? null : (winners.get(winnerId) ?? null),
            costUsd: roundUsd(r.modelsCostUsd + r.judgeCostUsd),
            completedAt: r.completedAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        evolutionSuites: suiteRows.map((s) => ({ id: s.id, name: s.name })),
      };
    },

    /** Qualité de chaque modèle sur les 6 dernières séries terminées de la suite, en ordre chronologique. */
    async evolution(suiteId: string, actor: Actor): Promise<Evolution> {
      const [suite] = await db.select({ id: suites.id, name: suites.name }).from(suites).where(eq(suites.id, suiteId));
      if (!suite) throw new NotFoundError('Suite introuvable');
      const latest = await db
        .select({
          id: runs.id,
          name: runs.name,
          completedAt: runs.completedAt,
          createdAt: runs.createdAt,
          judgeName: models.displayName,
        })
        .from(runs)
        .leftJoin(models, eq(models.id, runs.judgeModelId))
        .where(and(eq(runs.suiteId, suiteId), eq(runs.status, 'completed')))
        .orderBy(desc(runs.completedAt), desc(runs.createdAt), desc(runs.id))
        .limit(EVOLUTION_RUNS);
      const chronological = latest.reverse();
      const runIds = chronological.map((r) => r.id);
      const aggs = await aggregatesByRun(db, actor, runIds);

      const qualityByModel = new Map<string, (number | null)[]>();
      chronological.forEach((run, i) => {
        for (const a of aggs.get(run.id) ?? []) {
          const points = qualityByModel.get(a.modelId) ?? chronological.map(() => null as number | null);
          points[i] = a.quality;
          qualityByModel.set(a.modelId, points);
        }
      });
      const ids = [...qualityByModel.keys()];
      const info = new Map(
        (ids.length === 0
          ? []
          : await db.select({ id: models.id, name: models.displayName, color: models.color }).from(models).where(inArray(models.id, ids))
        ).map((m) => [m.id, m]),
      );
      return {
        suite,
        runs: chronological.map((r) => ({
          id: r.id,
          name: r.name,
          completedAt: (r.completedAt ?? r.createdAt).toISOString(),
          judgeName: r.judgeName,
        })),
        series: ids
          .map((modelId) => ({ modelId, name: info.get(modelId)?.name ?? '', color: info.get(modelId)?.color ?? '#888888', points: qualityByModel.get(modelId)! }))
          .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
