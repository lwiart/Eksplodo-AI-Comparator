// Essai rapide d'un test enregistré sur un modèle : tâche `quick_try` de la voie rapide, interrogée par l'interface.
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { roundUsd } from '../../lib/money.js';
import { describeError, reportJobFailure } from '../errors/capture.js';
import { enqueue, getJob, type JobHandler } from '../jobs/queue.js';
import type { Registry } from '../providers/registry.js';
import { buildRequest, measureCall, CALL_TIMEOUT_MS, type CallOutcome } from '../runs/call.js';
import { estimateInputTokens, isSupported } from '../runs/estimate.js';
import { candidateModelsOf, snapshotTests } from '../runs/runs.service.js';
import { scoreExpected } from '../scoring/expected.js';
import {
  JUDGE_DISABLED,
  UNREADABLE_REPLY,
  MAX_INVALID_REPLIES,
  judgeInputTokens,
  loadRunJudge,
  measureJudgeCall,
  readJudgeAttachments,
} from '../scoring/judge-items.js';
import { parseJudgeReply } from '../scoring/judge-parse.js';
import { getDefaultJudge } from '../scoring/settings.js';
import { recordUsage } from '../usage/usage.js';
import type { TestSnapshot } from '../runs/snapshot.js';
import type { ExpectedConfig } from './scoring-config.js';
import { readAttachment } from './attachments.js';

export const QUICK_TRY = 'quick_try';

/** Note automatique de l'essai : `score` nul si le juge est indisponible ou illisible (la justification dit pourquoi). */
export type QuickTryScore = {
  method: 'expected' | 'judge';
  score: number | null;
  rationale: string;
  judgeModelName?: string;
  judgeCostUsd?: number;
};
export type QuickTryOutcome = CallOutcome & { modelName: string; score: QuickTryScore | null };
export type QuickTryStatus = { status: 'queued' | 'running' | 'done' | 'failed'; outcome?: QuickTryOutcome; message?: string };

export type QuickTryServiceDeps = { db: Db; clock: Clock; registry: Pick<Registry, 'keyStatus'> };
export type QuickTryHandlerDeps = {
  db: Db;
  registry: Pick<Registry, 'adapterFor'>;
  config: Pick<AppConfig, 'dataDir'>;
};

const NO_DEFAULT_JUDGE = 'Aucun juge par défaut disponible';
const FAILED_MESSAGE = "L'essai n'a pas pu être exécuté. Réessayez.";

/** Création et suivi des essais rapides (le détail d'une tâche en échec reste côté serveur). */
export function createQuickTryService(deps: QuickTryServiceDeps) {
  const { db, clock, registry } = deps;
  return {
    /** Valide le test (enregistré, non archivé) et le modèle (disponible, gère les pièces jointes) puis enfile la tâche. */
    async start(requestedBy: string, input: { testId: string; modelId: string }): Promise<string> {
      const [snapshot] = await snapshotTests(db, [input.testId], false);
      const model = (await candidateModelsOf(db, registry, [input.modelId])).get(input.modelId);
      if (!model?.available) {
        throw new ConflictError('model_unavailable', 'Le modèle demandé est indisponible (inactif, ou fournisseur sans clé utilisable)');
      }
      if (!isSupported(snapshot!, model)) {
        throw new ValidationError('unsupported_attachment', 'Ce modèle ne gère pas une des pièces jointes du test');
      }
      const id = await enqueue(
        db,
        { type: QUICK_TRY, payload: { testId: input.testId, modelId: input.modelId, requestedBy }, maxAttempts: 1 },
        clock(),
      );
      if (id === null) throw new Error('Tâche quick_try non créée'); // sans clé de déduplication : impossible
      return id;
    },

    /** État immédiat depuis la ligne de la tâche ; seule une tâche `quick_try` est lisible. */
    async status(jobId: string): Promise<QuickTryStatus> {
      const job = await getJob(db, jobId);
      if (!job || job.type !== QUICK_TRY) throw new NotFoundError('Essai introuvable');
      if (job.status === 'failed') return { status: 'failed', message: FAILED_MESSAGE };
      if (job.status === 'done') {
        const outcome = (job.progress as { outcome?: QuickTryOutcome } | null)?.outcome;
        return outcome ? { status: 'done', outcome } : { status: 'failed', message: FAILED_MESSAGE };
      }
      return { status: job.status };
    },
  };
}

export type QuickTryService = ReturnType<typeof createQuickTryService>;

/** Gestionnaire `quick_try` : requête construite d'après le test enregistré, issue gardée dans `jobs.progress`. */
export function createQuickTryHandler(deps: QuickTryHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const { testId, modelId } = job.payload as { testId: string; modelId: string };
    const [snapshot] = await snapshotTests(deps.db, [testId], false);
    const [row] = await deps.db
      .select({ model: models, provider: providers })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(eq(models.id, modelId));
    if (!row) throw new NotFoundError('Modèle introuvable');
    const { model, provider } = row;

    const adapter = deps.registry.adapterFor(provider);
    const req = await buildRequest(snapshot!, model.apiModelId, (a) => readAttachment(deps.config, a));
    const outcome = await measureCall(
      adapter,
      req,
      { inputPricePerM: model.inputPricePerM, outputPricePerM: model.outputPricePerM },
      { now: () => Date.now(), signal: ctx.signal, timeoutMs: CALL_TIMEOUT_MS, estimatedInputTokens: estimateInputTokens(snapshot!) },
    );
    // Un appel échoué n'est pas facturé : aucune ligne `ai_usage`. L'appel a eu lieu : une écriture impossible est
    // journalisée (message masqué), et l'essai garde son issue.
    const recordSafely = async (input: Parameters<typeof recordUsage>[1]) => {
      try {
        await recordUsage(deps.db, input);
      } catch (err) {
        const d = describeError(err);
        await reportJobFailure(deps.db, job, { code: d.name, message: d.message, stack: d.stack, severity: 'normale' }, ctx.now());
      }
    };
    /** Note de la réponse : réponse attendue tout de suite, juge par défaut en deux appels au plus ; jamais d'échec de la tâche. */
    async function scoreOutcome(snap: TestSnapshot, text: string): Promise<QuickTryScore | null> {
      if (snap.scoringMethod === 'expected') {
        return { method: 'expected', ...scoreExpected(snap.scoringConfig as ExpectedConfig, text) };
      }
      if (snap.scoringMethod !== 'judge') return null;
      const { judge } = await loadRunJudge(deps.db, await getDefaultJudge(deps.db));
      if (judge === null) return { method: 'judge', score: null, rationale: NO_DEFAULT_JUDGE };
      const [judgeName] = await deps.db.select({ name: models.displayName }).from(models).where(eq(models.id, judge.id));
      const base = { method: 'judge' as const, judgeModelName: judgeName?.name ?? '' };
      let attachments;
      try {
        attachments = await readJudgeAttachments(snap, judge, (a) => readAttachment(deps.config, a));
      } catch {
        return { ...base, score: null, rationale: 'Pièce jointe illisible : le juge n’a pas pu être appelé' };
      }
      let judgeAdapter;
      try {
        judgeAdapter = deps.registry.adapterFor(judge.provider);
      } catch {
        return { ...base, score: null, rationale: JUDGE_DISABLED };
      }
      const inputTokens = judgeInputTokens(snap, text.length, judge);
      let costUsd = 0;
      for (let attempt = 0; ; attempt++) {
        const o = await measureJudgeCall(judgeAdapter, { snapshot: snap, response: text, judge, attachments, inputTokens }, { now: () => Date.now(), signal: ctx.signal });
        if (o.status !== 'done') {
          return { ...base, score: null, rationale: `Juge indisponible : ${o.errorMessage ?? o.errorCode}`, judgeCostUsd: costUsd };
        }
        const billed = roundUsd(o.costUsd ?? 0);
        costUsd = roundUsd(costUsd + billed);
        await recordSafely({
          origin: 'judge',
          runId: null,
          modelId: judge.id,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          reasoningTokens: o.reasoningTokens ?? 0,
          costUsd: billed,
          now: ctx.now(),
        });
        const reply = parseJudgeReply(o.text);
        if (reply.ok) return { ...base, score: reply.score, rationale: reply.rationale, judgeCostUsd: costUsd };
        if (attempt >= MAX_INVALID_REPLIES) return { ...base, score: null, rationale: UNREADABLE_REPLY, judgeCostUsd: costUsd };
      }
    }

    let score: QuickTryScore | null = null;
    if (outcome.status === 'done') {
      await recordSafely({
        origin: 'quick_try',
        runId: null,
        modelId,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        reasoningTokens: outcome.reasoningTokens ?? 0,
        costUsd: roundUsd(outcome.costUsd ?? 0),
        now: ctx.now(),
      });
      try {
        score = await scoreOutcome(snapshot!, outcome.text);
      } catch (err) {
        // Arrêt de la tâche : on le laisse remonter ; toute autre erreur laisse l'essai sans note, mais avec son issue.
        if (ctx.signal.aborted) throw err;
        const d = describeError(err);
        await reportJobFailure(deps.db, job, { code: d.name, message: d.message, stack: d.stack, severity: 'normale' }, ctx.now());
        score = snapshot!.scoringMethod === 'manual' ? null : { method: snapshot!.scoringMethod as 'expected' | 'judge', score: null, rationale: 'Note indisponible' };
      }
    }
    await ctx.reportProgress({ outcome: { ...outcome, modelName: model.displayName, score } });
  };
}
