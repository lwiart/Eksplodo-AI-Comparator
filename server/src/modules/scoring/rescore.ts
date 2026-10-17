// Recalcul des notes du juge d'une série (toute la série, un test ou un résultat), éventuellement avec un autre juge :
// les notes repassent en attente et le moteur les rend dans une nouvelle tranche.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runTests, runs } from '../../db/schema/runs.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import { affectedRows, type DbOrTx } from '../jobs/queue.js';
import type { Registry } from '../providers/registry.js';
import { enqueueRunJob, withTxRetry } from '../runs/run-job.js';

export type RescoreInput = {
  scope: 'run' | 'test' | 'result';
  runTestId?: string;
  resultId?: string;
  /** Nouveau juge de la série ; à défaut, le juge actuel. */
  judgeModelId?: string;
};

export type RescoreContext = { registry: Pick<Registry, 'keyStatus'>; now: Date };

const runNotFound = () => new NotFoundError('Série introuvable');
const judgeUnavailable = () =>
  new ConflictError('model_unavailable', 'Le modèle juge est indisponible (inactif, ou fournisseur sans clé utilisable)');
const notRescorable = (what: string) => new ConflictError('not_rescorable', `${what} n'est pas noté par le juge : rien à recalculer`);

/** Juge utilisable : modèle et fournisseur actifs, clé utilisable. */
async function assertJudgeAvailable(conn: DbOrTx, registry: RescoreContext['registry'], judgeModelId: string): Promise<void> {
  const [row] = await conn
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(providers.id, models.providerId))
    .where(eq(models.id, judgeModelId));
  if (!row || !row.model.enabled || !row.provider.enabled || !registry.keyStatus(row.provider).usable) throw judgeUnavailable();
}

/** Tests de la série du périmètre demandé, notés par le juge ; périmètre inconnu → 404, test d'une autre méthode → 409. */
async function scopeOf(conn: DbOrTx, runId: string, input: RescoreInput): Promise<{ runTestIds: string[]; resultId?: string }> {
  const judged = (rows: { id: string; method: string }[]) => rows.filter((r) => r.method === 'judge').map((r) => r.id);
  const method = sql<string>`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod')`;
  if (input.scope === 'result') {
    const [row] = await conn
      .select({ runTestId: results.runTestId, method })
      .from(results)
      .innerJoin(runTests, eq(runTests.id, results.runTestId))
      .where(and(eq(results.id, input.resultId!), eq(results.runId, runId)));
    if (!row) throw new NotFoundError('Résultat introuvable dans cette série');
    if (row.method !== 'judge') throw notRescorable('Ce résultat');
    return { runTestIds: [row.runTestId], resultId: input.resultId! };
  }
  const rows = await conn
    .select({ id: runTests.id, method })
    .from(runTests)
    .where(input.scope === 'test' ? and(eq(runTests.runId, runId), eq(runTests.id, input.runTestId!)) : eq(runTests.runId, runId));
  if (input.scope === 'test') {
    if (rows.length === 0) throw new NotFoundError('Test introuvable dans cette série');
    if (rows[0]!.method !== 'judge') throw notRescorable('Ce test');
  }
  return { runTestIds: judged(rows) };
}

/**
 * Remet en attente les notes du juge du périmètre (résultats `done` des tests notés par le juge : note et justification
 * effacées, prise éventuelle d'une tâche retirée, note imposée conservée), change le juge de la série s'il est fourni, puis
 * relance la série : `completed` → `queued` et sa tâche ; une série en cours garde sa tâche (la tranche suivante prend les
 * notes) ; une série en pause ou interrompue les notera à sa reprise. Les lectures de validation (juge, périmètre) précèdent
 * la transaction : celle-ci, ligne de la série verrouillée, ne fait que des lectures verrouillantes et des écritures, sans
 * image figée qui entrerait en conflit avec les écritures du moteur (`innodb_snapshot_isolation`).
 */
export async function rescore(db: Db, actor: Actor, runId: string, input: RescoreInput, ctx: RescoreContext): Promise<{ queued: number }> {
  if (input.scope === 'test' && !input.runTestId) throw new ValidationError('validation', 'runTestId requis pour recalculer un test');
  if (input.scope === 'result' && !input.resultId) throw new ValidationError('validation', 'resultId requis pour recalculer un résultat');
  const [current] = await db.select({ judgeModelId: runs.judgeModelId }).from(runs).where(eq(runs.id, runId));
  if (!current) throw runNotFound();
  const checkedJudgeId = input.judgeModelId ?? current.judgeModelId;
  if (checkedJudgeId === null) throw new ValidationError('judge_required', 'Aucun modèle juge : choisissez-en un pour recalculer');
  await assertJudgeAvailable(db, ctx.registry, checkedJudgeId);
  const scope = await scopeOf(db, runId, input);

  return withTxRetry(() =>
    db.transaction(async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
      if (!run) throw runNotFound();
      // Sans juge demandé : celui de la série, relu sous verrou (un recalcul simultané a pu le changer, après l'avoir vérifié).
      const judgeModelId = input.judgeModelId ?? run.judgeModelId ?? checkedJudgeId;

      let queued = 0;
      if (scope.runTestIds.length > 0) {
        const res = await tx
          .update(results)
          .set({ scoreStatus: 'pending', autoScore: null, judgeRationale: null, judgeClaimedBy: null })
          .where(
            and(
              eq(results.runId, runId),
              eq(results.status, 'done'),
              inArray(results.runTestId, scope.runTestIds),
              scope.resultId === undefined ? undefined : eq(results.id, scope.resultId),
            ),
          );
        queued = affectedRows(res);
      }
      if (judgeModelId !== run.judgeModelId) await tx.update(runs).set({ judgeModelId }).where(eq(runs.id, runId));
      if (queued > 0) {
        if (run.status === 'completed') {
          await tx.update(runs).set({ status: 'queued', pauseReason: null, completedAt: null }).where(eq(runs.id, runId));
          await enqueueRunJob(tx, runId, ctx.now);
        } else if (run.status === 'queued' || run.status === 'running') {
          await enqueueRunJob(tx, runId, ctx.now);
        }
      }
      await audit(tx, {
        actorUserId: actor.userId,
        action: 'run_rescored',
        targetType: 'run',
        targetId: runId,
        details: { scope: input.scope, runTestId: input.runTestId ?? null, resultId: input.resultId ?? null, judgeModelId, queued },
      });
      return { queued };
    }),
  );
}
