// Notation par réponse attendue (exact, contient, regex) : fonctions pures puis application au résultat.
import { runInNewContext } from 'node:vm';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { results, runTests } from '../../db/schema/runs.js';
import type { DbOrTx } from '../jobs/queue.js';
import { withTxRetry } from '../runs/run-job.js';
import type { ExpectedConfig } from '../tests/scoring-config.js';

/** La regex n'est testée que sur les premiers caractères de la réponse. */
export const REGEX_MAX_INPUT = 50_000;
/** Durée maximale d'une exécution de regex (protection contre le retour sur trace catastrophique). */
export const REGEX_TIMEOUT_MS = 1000;

export type ExpectedScore = { score: number; rationale: string };

/** Espaces de début et de fin retirés, espaces multiples réduits ; casse et accents selon les options. */
function normalize(text: string, ignoreCase: boolean, ignoreAccents: boolean): string {
  let s = text.trim().replace(/\s+/g, ' ');
  if (ignoreAccents) s = s.normalize('NFD').replace(/\p{M}/gu, '');
  if (ignoreCase) s = s.toLowerCase();
  return s;
}

function scoreRegex(pattern: string, flags: string, response: string): ExpectedScore {
  let re: RegExp;
  try {
    // `g` et `y` rendraient `test` dépendant de `lastIndex` : ignorés.
    re = new RegExp(pattern, flags.replace(/[gy]/g, ''));
  } catch {
    // Motif validé à la saisie, mais refusé ici (instantané ancien, moteur différent) : note nulle plutôt qu'une exception.
    return { score: 0, rationale: 'Expression invalide' };
  }
  const s = response.slice(0, REGEX_MAX_INPUT);
  try {
    const found = runInNewContext('re.test(s)', { re, s }, { timeout: REGEX_TIMEOUT_MS }) as boolean;
    return found
      ? { score: 10, rationale: 'Expression trouvée dans la réponse.' }
      : { score: 0, rationale: 'Expression absente de la réponse.' };
  } catch {
    // Seul le dépassement du délai peut survenir ici.
    return { score: 0, rationale: 'Expression trop lente' };
  }
}

/** Note de 0 à 10 d'une réponse par rapport à l'attente configurée, avec une justification française courte. */
export function scoreExpected(config: ExpectedConfig, response: string): ExpectedScore {
  if (config.mode === 'exact') {
    const same =
      normalize(response, config.ignoreCase, config.ignoreAccents) ===
      normalize(config.expected, config.ignoreCase, config.ignoreAccents);
    return same
      ? { score: 10, rationale: 'Réponse identique à la réponse attendue.' }
      : { score: 0, rationale: 'Réponse différente de la réponse attendue.' };
  }
  if (config.mode === 'contains') {
    const haystack = normalize(response, config.ignoreCase, false);
    const found = config.items.filter((item) => haystack.includes(normalize(item, config.ignoreCase, false)));
    const score = Math.round((10 * found.length * 10) / config.items.length) / 10;
    const noun = found.length > 1 ? 'éléments trouvés' : 'élément trouvé';
    return {
      score,
      rationale: `${found.length} ${noun} sur ${config.items.length}${found.length > 0 ? ` : ${found.join(', ')}` : ''}`,
    };
  }
  return scoreRegex(config.pattern, config.flags, response);
}

/**
 * Note le résultat `done` d'un test à réponse attendue ; sans effet pour une autre méthode ou un résultat déjà noté.
 * L'UPDATE est conditionné (note en attente, résultat terminé) : une note manuelle ou imposée n'est jamais écrasée. Lecture
 * puis UPDATE d'une seule ligne, chacun validé aussitôt (aucun verrou gardé pendant le calcul) ; l'ensemble est idempotent,
 * donc réessayé sur interblocage.
 */
export async function applyExpectedScore(db: Db, resultId: string): Promise<void> {
  await withTxRetry(async () => {
    const [row] = await db
      .select({ status: results.status, responseText: results.responseText, snapshot: runTests.snapshot })
      .from(results)
      .innerJoin(runTests, eq(results.runTestId, runTests.id))
      .where(eq(results.id, resultId));
    if (!row || row.status !== 'done' || row.snapshot.scoringMethod !== 'expected') return;
    const { score, rationale } = scoreExpected(row.snapshot.scoringConfig as ExpectedConfig, row.responseText ?? '');
    await db
      .update(results)
      .set({ autoScore: score, judgeRationale: rationale, scoreStatus: 'done' })
      .where(and(eq(results.id, resultId), eq(results.scoreStatus, 'pending'), eq(results.status, 'done')));
  });
}

/**
 * Résultats `done` d'un test à réponse attendue de la série dont la note est restée en attente (arrêt du processus ou
 * erreur entre la fin du résultat et sa notation) : le moteur les reprend au début de chaque tranche.
 */
export async function pendingExpectedScores(conn: DbOrTx, runId: string): Promise<string[]> {
  const rows = await conn
    .select({ id: results.id })
    .from(results)
    .innerJoin(runTests, eq(runTests.id, results.runTestId))
    .where(
      and(
        eq(results.runId, runId),
        eq(results.status, 'done'),
        eq(results.scoreStatus, 'pending'),
        sql`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod') = 'expected'`,
      ),
    );
  return rows.map((r) => r.id);
}
