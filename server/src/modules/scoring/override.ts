import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { results } from '../../db/schema/runs.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { Actor } from '../auth/actor.js';
import { audit } from '../audit/audit.js';
import { withTxRetry } from '../runs/run-job.js';
import type { ScoringMethod } from '../tests/scoring-config.js';

export type OverrideResult = { id: string; overrideScore: number | null; overrideBy: string | null };

/** Note finale d'un résultat : note imposée, sinon note de la méthode (moyenne des évaluateurs en manuel). */
export function finalScore(r: {
  overrideScore: number | null;
  autoScore: number | null;
  manualAvg: number | null;
  method: ScoringMethod;
}): number | null {
  if (r.overrideScore !== null) return r.overrideScore;
  return r.method === 'manual' ? r.manualAvg : r.autoScore;
}

/** 0 à 10, une décimale au plus. */
function assertValidScore(score: number): void {
  const tenths = score * 10;
  if (!Number.isFinite(score) || score < 0 || score > 10 || Math.abs(tenths - Math.round(tenths)) > 1e-6) {
    throw new ValidationError('invalid_score', 'La note doit être comprise entre 0 et 10, avec une décimale au plus');
  }
}

/** Impose (ou retire avec `null`) la note d'un résultat terminé ; ligne verrouillée le temps de l'écriture. */
export async function setOverride(db: Db, actor: Actor, resultId: string, score: number | null): Promise<OverrideResult> {
  if (score !== null) assertValidScore(score);
  return withTxRetry(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: results.status, previous: results.overrideScore })
        .from(results)
        .where(eq(results.id, resultId))
        .for('update');
      if (!row) throw new NotFoundError('Résultat introuvable');
      if (row.status !== 'done') throw new ConflictError('result_not_scorable', 'Seul un résultat terminé peut recevoir une note imposée');
      const overrideBy = score === null ? null : actor.userId;
      await tx.update(results).set({ overrideScore: score, overrideBy }).where(eq(results.id, resultId));
      await audit(tx, {
        actorUserId: actor.userId,
        action: 'score_overridden',
        targetType: 'result',
        targetId: resultId,
        details: { from: row.previous, to: score },
      });
      return { id: resultId, overrideScore: score, overrideBy };
    }),
  );
}
