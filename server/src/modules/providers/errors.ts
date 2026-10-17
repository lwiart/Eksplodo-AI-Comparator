import { redact } from '../errors/report.js';

export type ProviderErrorCode =
  | 'auth_invalid'
  | 'model_not_found'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'timeout'
  | 'context_too_long'
  | 'bad_request'
  | 'invalid_response';

const MESSAGES: Record<ProviderErrorCode, string> = {
  auth_invalid: 'Clé invalide ou sans droit sur ce modèle',
  model_not_found: 'Modèle introuvable chez le fournisseur',
  rate_limited: 'Limite de débit atteinte chez le fournisseur',
  provider_unavailable: 'Fournisseur indisponible',
  timeout: 'Délai dépassé',
  context_too_long: 'Contexte trop long pour ce modèle',
  bad_request: 'Requête refusée par le fournisseur',
  invalid_response: 'Réponse du fournisseur illisible',
};

export function providerErrorMessage(code: ProviderErrorCode): string {
  return MESSAGES[code];
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['rate_limited', 'provider_unavailable', 'timeout']);
const DETAIL_MAX = 500;
const MIN_SECRET_LENGTH = 8;

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** Message brut du fournisseur, masqué et tronqué à 500 caractères. */
  readonly detail: string;

  constructor(
    readonly code: ProviderErrorCode,
    opts: { status?: number | null; retryAfterMs?: number | null; detail?: string } = {},
  ) {
    super(providerErrorMessage(code));
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.detail = opts.detail ?? '';
  }
}

/** `redact` puis remplacement de chaque valeur exacte de `secrets` longue d'au moins 8 caractères. */
export function maskSecrets(text: string, secrets: (string | null)[]): string {
  let out = redact(text);
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('[masqué]');
  }
  return out;
}

function safeDetail(text: string, secrets: (string | null)[]): string {
  return maskSecrets(text, secrets).slice(0, DETAIL_MAX);
}

function headerValue(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const CONTEXT_TOO_LONG =
  /context_length_exceeded|maximum context length|prompt is too long|too many tokens|exceeds the context window|input token count/i;
const KEY_INVALID = /API_KEY_INVALID|API key not valid/i;

function classify(status: number, body: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 404) return 'model_not_found';
  if (status === 413) return 'context_too_long';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 400) {
    if (CONTEXT_TOO_LONG.test(body)) return 'context_too_long';
    if (KEY_INVALID.test(body)) return 'auth_invalid';
    return 'bad_request';
  }
  return status >= 400 ? 'bad_request' : 'provider_unavailable';
}

/** Normalise une réponse HTTP en erreur. `secrets` : valeurs à masquer dans le détail (clés API). */
export function httpError(
  status: number,
  body: string,
  headers: Headers | Record<string, string>,
  secrets: (string | null)[],
): ProviderError {
  return new ProviderError(classify(status, body), {
    status,
    retryAfterMs: parseRetryAfter(headerValue(headers, 'retry-after')),
    detail: safeDetail(body, secrets),
  });
}

function isTimeout(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

/**
 * Normalise une exception levée pendant un appel. Un signal annulé par l'appelant (raison autre qu'un
 * délai) relance la raison d'origine : une annulation n'est pas une erreur du fournisseur.
 */
export function thrownError(err: unknown, signal: AbortSignal, secrets: (string | null)[]): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal.aborted) {
    if (isTimeout(signal.reason)) return new ProviderError('timeout');
    throw signal.reason;
  }
  if (isTimeout(err)) return new ProviderError('timeout');
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new ProviderError('provider_unavailable', { detail: safeDetail(text, secrets) });
}
