// Consommation des modèles (`ai_usage`) : une ligne par appel facturé, source de la « dépense du mois ».
import { randomUUID } from 'node:crypto';
import { and, gte, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { aiUsage } from '../../db/schema/runs.js';
import type { DbOrTx } from '../jobs/queue.js';

export type UsageOrigin = (typeof aiUsage.$inferSelect)['origin'];

export type UsageInput = {
  origin: UsageOrigin;
  runId: string | null;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  now: Date;
};

const MONTH_ZONE = 'Europe/Paris';

export async function recordUsage(db: DbOrTx, u: UsageInput): Promise<void> {
  await db.insert(aiUsage).values({
    id: randomUUID(),
    origin: u.origin,
    runId: u.runId,
    modelId: u.modelId,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    reasoningTokens: u.reasoningTokens,
    costUsd: u.costUsd,
    createdAt: u.now,
  });
}

/** Dépense du mois civil en cours (fuseau Europe/Paris), totale et part du juge. */
export async function monthSpend(db: DbOrTx, now: Date): Promise<{ totalUsd: number; judgeUsd: number }> {
  const start = DateTime.fromJSDate(now, { zone: MONTH_ZONE }).startOf('month');
  const end = start.plus({ months: 1 });
  const [row] = await db
    .select({
      total: sql<string | null>`SUM(${aiUsage.costUsd})`,
      judge: sql<string | null>`SUM(CASE WHEN ${aiUsage.origin} = 'judge' THEN ${aiUsage.costUsd} ELSE 0 END)`,
    })
    .from(aiUsage)
    .where(and(gte(aiUsage.createdAt, start.toJSDate()), lt(aiUsage.createdAt, end.toJSDate())));
  return { totalUsd: Number(row?.total ?? 0), judgeUsd: Number(row?.judge ?? 0) };
}
