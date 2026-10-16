export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Référence E-XXXXX d'une erreur journalisée, à transmettre à l'administrateur. */
  reference?: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export type ApiInit = { method?: string; body?: unknown };

const CSRF_COOKIE = 'aic_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

let onUnauthorized: (() => void) | null = null;

/** Appelé quand une requête renvoie 401 (session expirée ou révoquée) ; l'AuthProvider s'y abonne. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** En-tête attendu par le serveur sur toute requête modifiante. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Jeton CSRF à envoyer dans l'en-tête `x-csrf-token`. Le cookie est posé par le serveur à la première requête ;
 * on le récupère s'il manque encore.
 */
export async function csrfToken(): Promise<string | undefined> {
  if (readCookie(CSRF_COOKIE) === undefined) await send('/api/auth/me', { credentials: 'same-origin' });
  return readCookie(CSRF_COOKIE);
}

/**
 * Erreur d'une réponse non 2xx (corps JSON déjà lu, ou null) : code et message du serveur s'il les fournit.
 * Un 401 prévient l'AuthProvider (session expirée). Partagé avec les envois en XMLHttpRequest (dépôt de documents).
 */
export function errorFromResponse(status: number, data: unknown): ApiError {
  const err = (data as { error?: { code?: unknown; message?: unknown; reference?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : 'http_error';
  const message = typeof err?.message === 'string' ? err.message : `Erreur HTTP ${status}`;
  if (status === 401) onUnauthorized?.();
  const error = new ApiError(code, status, message);
  if (typeof err?.reference === 'string') error.reference = err.reference;
  return error;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError('network', 0, 'Serveur injoignable');
  }
}

export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  if (!SAFE_METHODS.has(method)) {
    const csrf = await csrfToken();
    if (csrf !== undefined) headers[CSRF_HEADER] = csrf;
  }

  const res = await send(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) throw errorFromResponse(res.status, data);
  return data as T;
}
