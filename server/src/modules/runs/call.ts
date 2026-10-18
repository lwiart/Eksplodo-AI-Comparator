// Appel mesuré d'un modèle : délai, mesures (ttft, durée, débit), tokens et coût d'après les règles du moteur (spec §8.2).
import { redact } from '../errors/report.js';
import { thrownError, type ProviderError } from '../providers/errors.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter } from '../providers/types.js';
import type { SnapshotAttachment, TestSnapshot } from './snapshot.js';

export type CallOutcome = {
  status: 'done' | 'error' | 'timeout';
  /** Réponse, tronquée à 200 000 caractères ; gardée en cas d'erreur au milieu du flux. */
  text: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  tokensEstimated: boolean;
  ttftMs: number | null;
  totalMs: number;
  tokensPerS: number | null;
  /** `null` en cas d'erreur : un appel échoué n'est pas facturé. */
  costUsd: number | null;
  costSource: 'computed' | 'provider' | null;
  errorCode: string | null;
  /** Message masqué (`redact`). */
  errorMessage: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
};

export type ModelPrices = { inputPricePerM: number; outputPricePerM: number };

export const CALL_TIMEOUT_MS = 120_000;
export const MAX_RESPONSE_CHARS = 200_000;
/** En deçà, la phase de génération est trop courte pour un débit significatif. */
const MIN_GENERATION_MS = 100;
const CHARS_PER_TOKEN = 4;
// Forfaits de l'estimation, à défaut de `estimatedInputTokens` (le nombre de pages d'un PDF n'est pas dans la requête :
// une page).
const TOKENS_PER_IMAGE = 1500;
const TOKENS_PER_PDF = 800;

const tokensOfChars = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

function estimatedInputTokens(req: GenerateRequest): number {
  let tokens = tokensOfChars((req.system?.length ?? 0) + req.prompt.length);
  for (const a of req.attachments) tokens += a.mime === 'application/pdf' ? TOKENS_PER_PDF : TOKENS_PER_IMAGE;
  return tokens;
}

/** Délai dépassé : raison reconnue par `thrownError` comme un `timeout` du fournisseur. */
const timeoutReason = () => new DOMException('Délai dépassé', 'TimeoutError');

/**
 * Appelle le modèle et mesure le flux. Les erreurs du fournisseur sont renvoyées dans l'issue (jamais levées) ;
 * une annulation par `deps.signal` (arrêt de la tâche) rejette avec la raison du signal. `estimatedInputTokens` : entrée
 * estimée d'après l'instantané du test (`estimateInputTokens`, 800 par page de PDF), utilisée si l'usage manque.
 */
export async function measureCall(
  adapter: ProviderAdapter,
  req: GenerateRequest,
  model: ModelPrices,
  deps: { now: () => number; signal?: AbortSignal; timeoutMs?: number; estimatedInputTokens?: number },
): Promise<CallOutcome> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(timeoutReason()), deps.timeoutMs ?? CALL_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([timeout.signal, deps.signal]) : timeout.signal;

  const t0 = deps.now();
  let text = '';
  let outputChars = 0;
  let reasoningChars = 0;
  let ttftMs: number | null = null;
  let finishedAt: number | null = null;
  let finishReason: string | null = null;
  const usage: Omit<Extract<GenerateEvent, { type: 'usage' }>, 'type'> = {};
  let failure: ProviderError | null = null;

  try {
    for await (const ev of adapter.generate(req, signal)) {
      switch (ev.type) {
        case 'text':
          if (ev.delta === '') break;
          if (ttftMs === null) ttftMs = deps.now() - t0;
          outputChars += ev.delta.length;
          if (text.length < MAX_RESPONSE_CHARS) text += ev.delta.slice(0, MAX_RESPONSE_CHARS - text.length);
          break;
        case 'reasoning':
          reasoningChars += ev.delta.length;
          break;
        case 'usage':
          for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'costUsd'] as const) {
            if (ev[key] !== undefined) usage[key] = ev[key];
          }
          break;
        case 'finish':
          finishReason = ev.reason;
          finishedAt = deps.now();
          break;
      }
    }
  } catch (err) {
    failure = thrownError(err, signal, []); // relance la raison d'une annulation par l'appelant
  } finally {
    clearTimeout(timer);
  }

  const totalMs = (finishedAt ?? deps.now()) - t0;
  const tokensEstimated = usage.inputTokens === undefined || usage.outputTokens === undefined;
  const inputTokens = usage.inputTokens ?? deps.estimatedInputTokens ?? estimatedInputTokens(req);
  const outputTokens = usage.outputTokens ?? tokensOfChars(outputChars);
  // Usage complet sans détail du raisonnement : aucun (il peut être compté dans la sortie, comme chez Anthropic).
  const reasoningTokens =
    usage.reasoningTokens ?? (tokensEstimated && reasoningChars > 0 ? tokensOfChars(reasoningChars) : null);

  const base = { text, finishReason, inputTokens, outputTokens, reasoningTokens, tokensEstimated, ttftMs, totalMs };
  if (failure) {
    const detail = failure.detail ? ` : ${failure.detail}` : '';
    return {
      ...base,
      status: failure.code === 'timeout' ? 'timeout' : 'error',
      tokensPerS: null,
      costUsd: null,
      costSource: null,
      errorCode: failure.code,
      errorMessage: redact(`${failure.message}${detail}`),
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
    };
  }

  const generationMs = ttftMs === null ? 0 : totalMs - ttftMs;
  const providerCost = usage.costUsd;
  return {
    ...base,
    status: 'done',
    tokensPerS: generationMs > MIN_GENERATION_MS ? outputTokens / (generationMs / 1000) : null,
    costUsd:
      providerCost ??
      (inputTokens * model.inputPricePerM + (outputTokens + (reasoningTokens ?? 0)) * model.outputPricePerM) / 1_000_000,
    costSource: providerCost === undefined ? 'computed' : 'provider',
    errorCode: null,
    errorMessage: null,
    retryable: false,
    retryAfterMs: null,
  };
}

/**
 * Marge de réflexion ajoutée à la limite de sortie d'un test : les modèles qui réfléchissent comptent cette réflexion dans
 * la même limite et pouvaient l'épuiser sans écrire de réponse. Un modèle qui ne réfléchit pas ne consomme rien de plus.
 */
export const REASONING_MARGIN = 4000;
/** Plafond de la limite envoyée (marge comprise), sauf si le test demande lui-même davantage. */
export const MAX_REQUEST_TOKENS = 16_000;

/** Limite de tokens envoyée au fournisseur : celle du test, plus la marge de réflexion, dans la limite du plafond. */
export function withReasoningMargin(maxTokens: number): number {
  return Math.max(maxTokens, Math.min(maxTokens + REASONING_MARGIN, MAX_REQUEST_TOKENS));
}

/** Réponse coupée par la limite avant tout texte : la réflexion a consommé toute la limite. */
export function isTruncatedEmpty(o: CallOutcome): boolean {
  return o.status === 'done' && o.text.trim() === '' && o.finishReason === 'length';
}

export const truncatedMessage = (maxTokens: number): string =>
  `Aucun texte : la limite de ${maxTokens} tokens a été atteinte pendant la réflexion, avant la réponse.`;

/** Requête d'un test figé pour un modèle ; `readFile` lit le contenu d'une pièce jointe. */
export async function buildRequest(
  snapshot: TestSnapshot,
  apiModelId: string,
  readFile: (a: SnapshotAttachment) => Promise<Buffer>,
): Promise<GenerateRequest> {
  const attachments = await Promise.all(
    snapshot.attachments.map(async (a) => ({ mime: a.mime, base64: (await readFile(a)).toString('base64'), filename: a.originalName })),
  );
  return {
    model: apiModelId,
    ...(snapshot.systemPrompt ? { system: snapshot.systemPrompt } : {}),
    prompt: snapshot.userPrompt,
    attachments,
    temperature: snapshot.temperature,
    maxTokens: withReasoningMargin(snapshot.maxTokens),
  };
}
