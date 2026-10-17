import { ApiError, CSRF_HEADER, apiFetch, csrfToken, errorFromResponse } from './client';

// Types miroirs de server/src/modules/tests/ (tests.service.ts, scoring-config.ts, quick-try.ts, runs/call.ts).
export type ScoringMethod = 'judge' | 'expected' | 'manual';

export type ExpectedConfig =
  | { mode: 'exact'; expected: string; ignoreCase: boolean; ignoreAccents: boolean }
  | { mode: 'contains'; items: string[]; ignoreCase: boolean }
  | { mode: 'regex'; pattern: string; flags: string };
export type JudgeConfig = { criteria: string; reference?: string };
export type ScoringConfig = ExpectedConfig | JudgeConfig | Record<string, never>;

export type PublicAttachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  pages: number | null;
  sha256: string;
};

export type TestInput = {
  name: string;
  category: string;
  tags: string[];
  systemPrompt: string | null;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  scoringMethod: ScoringMethod;
  scoringConfig: ScoringConfig;
};

export type PublicTest = TestInput & {
  id: string;
  archivedAt: string | null;
  attachments: PublicAttachment[];
  usedInRuns: number;
  createdAt: string;
  updatedAt: string;
};

export type TestFilters = { archived?: boolean; category?: string; tag?: string; q?: string };
export type TestsMeta = { categories: string[]; tags: string[] };

export type QuickTryOutcome = {
  status: 'done' | 'error' | 'timeout';
  text: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  tokensEstimated: boolean;
  ttftMs: number | null;
  totalMs: number;
  tokensPerS: number | null;
  costUsd: number | null;
  costSource: 'computed' | 'provider' | null;
  errorCode: string | null;
  errorMessage: string | null;
  modelName: string;
};
export type QuickTryStatus = {
  status: 'queued' | 'running' | 'done' | 'failed';
  outcome?: QuickTryOutcome;
  message?: string;
};

export const TESTS_KEY = ['tests'] as const;
export const TESTS_META_KEY = ['tests', 'meta'] as const;

const enc = encodeURIComponent;

export async function listTests(filters: TestFilters = {}): Promise<PublicTest[]> {
  const params = new URLSearchParams();
  if (filters.archived) params.set('archived', 'true');
  if (filters.category) params.set('category', filters.category);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  const query = params.toString();
  return (await apiFetch<{ tests: PublicTest[] }>(`/api/tests${query ? `?${query}` : ''}`)).tests;
}

export async function getTest(id: string): Promise<PublicTest> {
  return (await apiFetch<{ test: PublicTest }>(`/api/tests/${enc(id)}`)).test;
}

export function testsMeta(): Promise<TestsMeta> {
  return apiFetch('/api/tests/meta');
}

export async function createTest(body: TestInput): Promise<PublicTest> {
  return (await apiFetch<{ test: PublicTest }>('/api/tests', { method: 'POST', body })).test;
}

export async function updateTest(id: string, body: TestInput): Promise<PublicTest> {
  return (await apiFetch<{ test: PublicTest }>(`/api/tests/${enc(id)}`, { method: 'PUT', body })).test;
}

/** `archived` : le test est utilisé par une série, il est archivé au lieu d'être supprimé. */
export async function deleteTest(id: string): Promise<'deleted' | 'archived'> {
  return (await apiFetch<{ outcome: 'deleted' | 'archived' }>(`/api/tests/${enc(id)}`, { method: 'DELETE' })).outcome;
}

export async function restoreTest(id: string): Promise<PublicTest> {
  return (await apiFetch<{ test: PublicTest }>(`/api/tests/${enc(id)}/restore`, { method: 'POST' })).test;
}

/** Dépôt d'une pièce jointe en XMLHttpRequest (seul moyen d'obtenir la progression de l'envoi). */
export async function uploadAttachment(
  testId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<PublicAttachment> {
  const csrf = await csrfToken();
  return new Promise<PublicAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tests/${enc(testId)}/attachments`);
    xhr.setRequestHeader('accept', 'application/json');
    if (csrf !== undefined) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    const fail = () => reject(new ApiError('network', 0, 'Serveur injoignable'));
    xhr.onerror = fail;
    xhr.onabort = fail;
    xhr.ontimeout = fail;
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const attachment = (data as { attachment?: PublicAttachment } | null)?.attachment;
        if (!attachment) {
          reject(new ApiError('http_error', xhr.status, 'Réponse inattendue du serveur'));
          return;
        }
        onProgress?.(1);
        resolve(attachment);
      } else if (xhr.status === 413 && !(data as { error?: unknown } | null)?.error) {
        // Le proxy inverse refuse avant le serveur : corps non JSON.
        reject(new ApiError('file_too_large', 413, 'Fichier trop volumineux (10 Mo au plus)'));
      } else {
        reject(errorFromResponse(xhr.status, data));
      }
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/** `detached` : la pièce jointe est référencée par une série, elle est seulement retirée du test. */
export async function deleteAttachment(testId: string, id: string): Promise<'deleted' | 'detached'> {
  return (
    await apiFetch<{ outcome: 'deleted' | 'detached' }>(`/api/tests/${enc(testId)}/attachments/${enc(id)}`, { method: 'DELETE' })
  ).outcome;
}

export function attachmentDownloadUrl(testId: string, id: string): string {
  return `/api/tests/${enc(testId)}/attachments/${enc(id)}/download`;
}

export async function startQuickTry(testId: string, modelId: string): Promise<string> {
  return (await apiFetch<{ jobId: string }>('/api/tests/try', { method: 'POST', body: { testId, modelId } })).jobId;
}

export function getQuickTry(jobId: string): Promise<QuickTryStatus> {
  return apiFetch(`/api/tests/try/${enc(jobId)}`);
}
