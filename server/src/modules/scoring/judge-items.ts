// Notes du juge exécutées par le moteur (spec §9) : notes en attente, coût maximal d'un appel, prise exclusive d'une
// note par la tâche qui l'exécute, et écriture des appels facturés (coût du juge à part, jamais imputé aux modèles).
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runTests, runs } from '../../db/schema/runs.js';
import { affectedRows, type DbOrTx } from '../jobs/queue.js';
import type { GenerateRequest } from '../providers/types.js';
import type { ProviderLike } from '../providers/registry.js';
import type { ModelPrices } from '../runs/call.js';
import { withTxRetry } from '../runs/run-job.js';
import type { SnapshotAttachment, TestSnapshot } from '../runs/snapshot.js';
import { recordUsage } from '../usage/usage.js';
import { buildJudgeRequest } from './judge-prompt.js';

/** Sortie maximale d'un appel du juge (`max_tokens` de la requête). */
export const JUDGE_MAX_OUTPUT_TOKENS = 800;
/** Réponse illisible : un seul nouvel appel du juge. */
export const MAX_INVALID_REPLIES = 1;
export const UNREADABLE_REPLY = 'Réponse du juge illisible';
export const NO_JUDGE = 'Juge indisponible : aucun modèle juge pour cette série';
export const JUDGE_DISABLED = 'Juge indisponible : le modèle juge ou son fournisseur est désactivé';

const TOKENS_PER_IMAGE = 1500;
const TOKENS_PER_PDF_PAGE = 800;

export type JudgeModel = {
  id: string;
  apiModelId: string;
  prices: ModelPrices;
  supportsVision: boolean;
  supportsPdf: boolean;
  provider: ProviderLike & { maxConcurrency: number };
};

/**
 * Note du juge en attente : résultat `done` d'un test noté par le juge, avec l'instantané du test et la longueur de la
 * réponse (le texte, jusqu'à 200 000 caractères, n'est lu qu'au moment de l'appel).
 */
export type PendingJudgement = { resultId: string; snapshot: TestSnapshot; responseChars: number };

const isJudgeTest = sql`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod') = 'judge'`;

/** Notes du juge en attente d'une série (jointure `run_tests` requise). */
const pendingJudgementsOf = (runId: string) =>
  and(eq(results.runId, runId), eq(results.status, 'done'), eq(results.scoreStatus, 'pending'), isJudgeTest);

/** Juge de la série et raison de son indisponibilité (aucun juge, modèle ou fournisseur désactivé). */
export async function loadRunJudge(
  conn: DbOrTx,
  judgeModelId: string | null,
): Promise<{ judge: JudgeModel; unavailable: null } | { judge: null; unavailable: string }> {
  if (judgeModelId === null) return { judge: null, unavailable: NO_JUDGE };
  const [row] = await conn
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(providers.id, models.providerId))
    .where(eq(models.id, judgeModelId));
  if (!row) return { judge: null, unavailable: NO_JUDGE };
  if (!row.model.enabled || !row.provider.enabled) return { judge: null, unavailable: JUDGE_DISABLED };
  return {
    judge: {
      id: row.model.id,
      apiModelId: row.model.apiModelId,
      prices: { inputPricePerM: row.model.inputPricePerM, outputPricePerM: row.model.outputPricePerM },
      supportsVision: row.model.supportsVision,
      supportsPdf: row.model.supportsPdf,
      provider: row.provider,
    },
    unavailable: null,
  };
}

/** Notes du juge en attente et libres (aucune tâche ne les note), dans l'ordre d'exécution des résultats. */
export async function loadPendingJudgements(conn: DbOrTx, runId: string): Promise<PendingJudgement[]> {
  const rows = await conn
    .select({
      resultId: results.id,
      runTestId: results.runTestId,
      responseChars: sql<number>`COALESCE(CHAR_LENGTH(${results.responseText}), 0)`,
    })
    .from(results)
    .innerJoin(runTests, eq(runTests.id, results.runTestId))
    .where(and(pendingJudgementsOf(runId), isNull(results.judgeClaimedBy)))
    .orderBy(asc(results.repetition), asc(runTests.position), asc(results.id));
  if (rows.length === 0) return [];
  // Un instantané par test (et non par résultat).
  const snapshots = await conn
    .select({ id: runTests.id, snapshot: runTests.snapshot })
    .from(runTests)
    .where(inArray(runTests.id, [...new Set(rows.map((r) => r.runTestId))]));
  const snapshotOf = new Map(snapshots.map((s) => [s.id, s.snapshot]));
  return rows.map((r) => ({ resultId: r.resultId, snapshot: snapshotOf.get(r.runTestId)!, responseChars: Number(r.responseChars) }));
}

/** Réponse évaluée, lue au moment de l'appel du juge. */
export async function readResponse(conn: DbOrTx, resultId: string): Promise<string> {
  const [row] = await conn.select({ text: results.responseText }).from(results).where(eq(results.id, resultId));
  return row?.text ?? '';
}

/** Nombre de notes du juge en attente (prises ou non) : la série ne peut pas encore passer `completed`. */
export async function countPendingJudgements(conn: DbOrTx, runId: string): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`COUNT(*)` })
    .from(results)
    .innerJoin(runTests, eq(runTests.id, results.runTestId))
    .where(pendingJudgementsOf(runId));
  return Number(row?.n ?? 0);
}

/** Pièces jointes du test que le juge sait lire (les autres ne lui sont pas envoyées). */
export function judgeAttachmentsOf(snapshot: TestSnapshot, judge: Pick<JudgeModel, 'supportsVision' | 'supportsPdf'>): SnapshotAttachment[] {
  return snapshot.attachments.filter((a) => (a.mime === 'application/pdf' ? judge.supportsPdf : a.mime.startsWith('image/') && judge.supportsVision));
}

/** Contenu des pièces jointes lisibles par le juge ; `readFile` lit une pièce jointe de l'instantané. */
export async function readJudgeAttachments(
  snapshot: TestSnapshot,
  judge: Pick<JudgeModel, 'supportsVision' | 'supportsPdf'>,
  readFile: (a: SnapshotAttachment) => Promise<Buffer>,
): Promise<GenerateRequest['attachments']> {
  return Promise.all(
    judgeAttachmentsOf(snapshot, judge).map(async (a) => ({ mime: a.mime, base64: (await readFile(a)).toString('base64'), filename: a.originalName })),
  );
}

/**
 * Entrée estimée d'un appel du juge : texte de sa requête (4 caractères par token), réponse évaluée comprise d'après sa
 * longueur, et pièces jointes qu'il lit.
 */
export function judgeInputTokens(snapshot: TestSnapshot, responseChars: number, judge: Omit<JudgeModel, 'provider' | 'prices'>): number {
  const req = buildJudgeRequest({
    snapshot,
    response: '',
    judgeApiModelId: judge.apiModelId,
    judgeSupports: { vision: judge.supportsVision, pdf: judge.supportsPdf },
    attachments: [],
  });
  let tokens = Math.ceil(((req.system?.length ?? 0) + req.prompt.length + responseChars) / 4);
  for (const a of judgeAttachmentsOf(snapshot, judge)) {
    tokens += a.mime === 'application/pdf' ? (a.pages ?? 1) * TOKENS_PER_PDF_PAGE : TOKENS_PER_IMAGE;
  }
  return tokens;
}

/** Coût maximal d'un appel du juge, réservé sur le plafond : entrée estimée × prix d'entrée + 800 × prix de sortie. */
export function judgeCallMaxCostUsd(inputTokens: number, prices: ModelPrices): number {
  return (inputTokens * prices.inputPricePerM + JUDGE_MAX_OUTPUT_TOKENS * prices.outputPricePerM) / 1_000_000;
}

/**
 * Prise exclusive d'une note par une tâche : seulement si la note attend encore, n'est prise par aucune tâche et que le
 * juge de la série est toujours celui-ci (un recalcul a pu le changer). Renvoie vrai si la note est prise.
 */
export async function claimJudgement(
  conn: DbOrTx,
  input: { runId: string; resultId: string; judgeModelId: string; jobId: string },
): Promise<boolean> {
  return withTxRetry(async () => {
    const [run] = await conn.select({ judgeModelId: runs.judgeModelId }).from(runs).where(eq(runs.id, input.runId));
    if (run?.judgeModelId !== input.judgeModelId) return false;
    const res = await conn
      .update(results)
      .set({ judgeClaimedBy: input.jobId })
      .where(
        and(
          eq(results.id, input.resultId),
          eq(results.status, 'done'),
          eq(results.scoreStatus, 'pending'),
          isNull(results.judgeClaimedBy),
        ),
      );
    return affectedRows(res) === 1;
  });
}

/** Rend la note (toujours en attente) si cette tâche la tient encore ; renvoie vrai si elle a été rendue. */
export async function releaseJudgement(conn: DbOrTx, resultId: string, jobId: string): Promise<boolean> {
  return withTxRetry(async () =>
    affectedRows(
      await conn
        .update(results)
        .set({ judgeClaimedBy: null })
        .where(and(eq(results.id, resultId), eq(results.judgeClaimedBy, jobId))),
    ) === 1,
  );
}

/** Prises laissées par une tâche interrompue : libérées au début de la tranche (une seule tâche active par série). */
export async function resetJudgeClaims(conn: DbOrTx, runId: string): Promise<void> {
  await conn
    .update(results)
    .set({ judgeClaimedBy: null })
    .where(and(eq(results.runId, runId), isNotNull(results.judgeClaimedBy)));
}

/** Notes libres mises en échec d'un coup (juge indisponible), avec la justification donnée. */
export async function failJudgements(conn: DbOrTx, resultIds: string[], rationale: string): Promise<void> {
  if (resultIds.length === 0) return;
  await withTxRetry(() =>
    conn
      .update(results)
      .set({ scoreStatus: 'judge_failed', autoScore: null, judgeRationale: rationale })
      .where(
        and(
          inArray(results.id, resultIds),
          eq(results.status, 'done'),
          eq(results.scoreStatus, 'pending'),
          isNull(results.judgeClaimedBy),
        ),
      ),
  );
}

export type JudgeVerdict = { score: number; rationale: string } | { failed: string };

export type JudgeCall = {
  runId: string;
  resultId: string;
  jobId: string;
  judgeModelId: string;
  /** Appel facturé (réponse reçue) : coût arrondi au micro-dollar et tokens ; `null` si l'appel a échoué. */
  billed: { costUsd: number; inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  /** Issue de la note ; `null` : un nouvel appel suit (réponse illisible), seul le coût est écrit. */
  verdict: JudgeVerdict | null;
  now: Date;
};

/**
 * Écrit un appel du juge en une transaction courte : coût ajouté au résultat et à la série (`judge_cost_usd`, jamais
 * `models_cost_usd`) et ligne `ai_usage` d'origine `judge` ; puis la note, seulement si cette tâche tient encore la prise
 * et que le juge de la série n'a pas changé (sinon la note reste en attente pour le nouveau juge). Ligne du résultat
 * verrouillée avant celle de la série, dans le même ordre que l'enregistrement d'une réponse par le moteur.
 */
export async function commitJudgeCall(conn: DbOrTx, call: JudgeCall): Promise<void> {
  if (call.billed === null && call.verdict === null) return;
  await withTxRetry(() =>
    conn.transaction(async (tx) => {
      const [row] = await tx
        .select({ scoreStatus: results.scoreStatus, judgeClaimedBy: results.judgeClaimedBy })
        .from(results)
        .where(eq(results.id, call.resultId))
        .for('update');
      if (!row) return;
      if (call.billed) {
        const { costUsd } = call.billed;
        await tx
          .update(results)
          .set({ judgeCostUsd: sql`COALESCE(${results.judgeCostUsd}, 0) + ${costUsd}` })
          .where(eq(results.id, call.resultId));
        await tx
          .update(runs)
          .set({ judgeCostUsd: sql`${runs.judgeCostUsd} + ${costUsd}` })
          .where(eq(runs.id, call.runId));
        await recordUsage(tx, {
          origin: 'judge',
          runId: call.runId,
          modelId: call.judgeModelId,
          inputTokens: call.billed.inputTokens,
          outputTokens: call.billed.outputTokens,
          reasoningTokens: call.billed.reasoningTokens,
          costUsd,
          now: call.now,
        });
      }
      if (call.verdict === null || row.judgeClaimedBy !== call.jobId || row.scoreStatus !== 'pending') return;
      const [run] = await tx.select({ judgeModelId: runs.judgeModelId }).from(runs).where(eq(runs.id, call.runId)).for('update');
      const { verdict } = call;
      const values =
        run?.judgeModelId !== call.judgeModelId
          ? { judgeClaimedBy: null }
          : 'failed' in verdict
            ? { scoreStatus: 'judge_failed' as const, autoScore: null, judgeRationale: verdict.failed, judgeClaimedBy: null }
            : { scoreStatus: 'done' as const, autoScore: verdict.score, judgeRationale: verdict.rationale, judgeClaimedBy: null };
      await tx.update(results).set(values).where(eq(results.id, call.resultId));
    }),
  );
}
