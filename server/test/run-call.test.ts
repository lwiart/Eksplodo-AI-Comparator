import { afterEach, expect, test, vi } from 'vitest';
import { ProviderError } from '../src/modules/providers/errors.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter } from '../src/modules/providers/types.js';
import { CALL_TIMEOUT_MS, MAX_RESPONSE_CHARS, buildRequest, isTruncatedEmpty, measureCall, withReasoningMargin } from '../src/modules/runs/call.js';
import { estimateInputTokens } from '../src/modules/runs/estimate.js';
import type { TestSnapshot } from '../src/modules/runs/snapshot.js';

type Step = { at: number; ev?: GenerateEvent; error?: unknown };

/** Adaptateur simulé : chaque événement est émis à l'instant `at` de l'horloge injectée. */
function scripted(steps: Step[], clock: { t: number }): ProviderAdapter {
  return {
    async *generate() {
      for (const s of steps) {
        clock.t = s.at;
        if (s.error !== undefined) throw s.error;
        yield s.ev!;
      }
    },
    listModels: async () => [],
  };
}

const req: GenerateRequest = { model: 'm', system: 'abcd', prompt: 'efghijkl', attachments: [], temperature: 0.2, maxTokens: 1000 };
const prices = { inputPricePerM: 2, outputPricePerM: 8 };

async function measure(steps: Step[], opts: { request?: GenerateRequest; model?: typeof prices } = {}) {
  const clock = { t: 0 };
  return measureCall(scripted(steps, clock), opts.request ?? req, opts.model ?? prices, { now: () => clock.t });
}

const usage = (u: Omit<Extract<GenerateEvent, { type: 'usage' }>, 'type'>): GenerateEvent => ({ type: 'usage', ...u });
const text = (delta: string): GenerateEvent => ({ type: 'text', delta });
const finish: GenerateEvent = { type: 'finish', reason: 'stop' };

afterEach(() => {
  vi.useRealTimers();
});

test('ttft = premier texte non vide, le raisonnement ne compte pas', async () => {
  const out = await measure([
    { at: 100, ev: { type: 'reasoning', delta: 'je réfléchis' } },
    { at: 200, ev: text('') },
    { at: 400, ev: text('Bonjour') },
    { at: 900, ev: text(' à tous') },
    { at: 1000, ev: usage({ inputTokens: 10, outputTokens: 4 }) },
    { at: 1400, ev: finish },
  ]);
  expect(out.status).toBe('done');
  expect(out.text).toBe('Bonjour à tous');
  expect(out.ttftMs).toBe(400);
  expect(out.totalMs).toBe(1400);
  expect(out.finishReason).toBe('stop');
  expect(out.errorCode).toBeNull();
});

test('tokens/s = sortie hors raisonnement ÷ phase de génération ; null si < 100 ms', async () => {
  const out = await measure([
    { at: 400, ev: text('Bonjour') },
    { at: 1300, ev: usage({ inputTokens: 10, outputTokens: 50, reasoningTokens: 10 }) },
    { at: 1400, ev: finish },
  ]);
  expect(out.tokensPerS).toBe(50); // 50 tokens ÷ 1 s
  expect(out.reasoningTokens).toBe(10);

  const quick = await measure([
    { at: 400, ev: text('Bonjour') },
    { at: 450, ev: usage({ inputTokens: 10, outputTokens: 50 }) },
    { at: 450, ev: finish },
  ]);
  expect(quick.tokensPerS).toBeNull();

  const silent = await measure([
    { at: 400, ev: usage({ inputTokens: 10, outputTokens: 0 }) },
    { at: 900, ev: finish },
  ]);
  expect(silent.ttftMs).toBeNull();
  expect(silent.tokensPerS).toBeNull();
});

test('usage absent → estimé (caractères ÷ 4), tokensEstimated vrai', async () => {
  // Flux terminé sans `finish` : la durée totale court jusqu'à la fin du flux.
  const out = await measure([
    { at: 300, ev: { type: 'reasoning', delta: 'abcdef' } },
    { at: 400, ev: text('0123456789') },
  ]);
  expect(out.status).toBe('done');
  expect(out.tokensEstimated).toBe(true);
  expect(out.inputTokens).toBe(3); // 12 caractères (système + prompt) ÷ 4
  expect(out.outputTokens).toBe(3); // 10 caractères ÷ 4, arrondi au supérieur
  expect(out.reasoningTokens).toBe(2); // 6 caractères ÷ 4
  expect(out.finishReason).toBeNull();
  expect(out.totalMs).toBe(400);

  const withUsage = await measure([
    { at: 400, ev: text('0123456789') },
    { at: 500, ev: usage({ inputTokens: 7, outputTokens: 9 }) },
    { at: 500, ev: finish },
  ]);
  expect(withUsage.tokensEstimated).toBe(false);
  expect(withUsage.inputTokens).toBe(7);
  expect(withUsage.outputTokens).toBe(9);
  expect(withUsage.reasoningTokens).toBeNull();
});

test('coût du fournisseur prioritaire (provider), sinon calculé (computed) avec raisonnement au prix de sortie', async () => {
  const provider = await measure([
    { at: 400, ev: text('ok') },
    { at: 500, ev: usage({ inputTokens: 1000, outputTokens: 500, costUsd: 0.0123 }) },
    { at: 500, ev: finish },
  ]);
  expect(provider.costUsd).toBe(0.0123);
  expect(provider.costSource).toBe('provider');

  const computed = await measure([
    { at: 400, ev: text('ok') },
    { at: 500, ev: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 200 }) },
    { at: 500, ev: finish },
  ]);
  // (1 000 × 2 + (500 + 200) × 8) ÷ 1 000 000
  expect(computed.costUsd).toBeCloseTo(0.0076, 12);
  expect(computed.costSource).toBe('computed');
});

test('modèle à raisonnement : coût = (sortie + raisonnement) × prix de sortie sans double compte, débit sur la sortie seule', async () => {
  const out = await measure([
    { at: 100, ev: { type: 'reasoning', delta: 'je réfléchis longuement' } },
    { at: 400, ev: text('Réponse') },
    { at: 1400, ev: usage({ inputTokens: 100, outputTokens: 50, reasoningTokens: 200 }) },
    { at: 1400, ev: finish },
  ]);
  expect(out).toMatchObject({ outputTokens: 50, reasoningTokens: 200, tokensEstimated: false, costSource: 'computed' });
  // (100 × 2 + (50 + 200) × 8) ÷ 1 000 000
  expect(out.costUsd).toBeCloseTo(0.0022, 12);
  expect(out.tokensPerS).toBe(50); // 50 tokens de sortie ÷ 1 s, raisonnement exclu
});

test('usage absent : entrée estimée d’après l’instantané, 800 tokens par page de PDF', async () => {
  const snapshot: TestSnapshot = {
    testId: 't',
    name: 'Test',
    category: 'Cat',
    tags: [],
    systemPrompt: null,
    userPrompt: 'Résume ce document',
    temperature: 0.2,
    maxTokens: 100,
    scoringMethod: 'manual',
    scoringConfig: {},
    attachments: [
      { id: 'a', originalName: 'doc.pdf', mime: 'application/pdf', size: 3, sha256: 'x'.repeat(64), pages: 3, storagePath: 'attachments/t/a' },
    ],
  };
  const request = await buildRequest(snapshot, 'm', async () => Buffer.from('%PDF'));
  const clock = { t: 0 };
  const out = await measureCall(scripted([{ at: 400, ev: text('Résumé') }], clock), request, prices, {
    now: () => clock.t,
    estimatedInputTokens: estimateInputTokens(snapshot),
  });
  expect(out.tokensEstimated).toBe(true);
  expect(out.inputTokens).toBe(5 + 3 * 800); // 18 caractères ÷ 4 + 3 pages
});

test('réponse tronquée à 200 000 caractères', async () => {
  expect(MAX_RESPONSE_CHARS).toBe(200_000);
  const chunk = 'x'.repeat(50_000);
  const out = await measure([
    ...Array.from({ length: 5 }, (_, i) => ({ at: 100 + i, ev: text(chunk) })),
    { at: 200, ev: usage({ inputTokens: 1, outputTokens: 62_500 }) },
    { at: 200, ev: finish },
  ]);
  expect(out.text.length).toBe(200_000);
});

test('10 minutes sans fin → timeout réessayable', async () => {
  expect(CALL_TIMEOUT_MS).toBe(600_000);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = { t: 0 };
  const hanging: ProviderAdapter = {
    async *generate(_req, signal) {
      yield text('Début');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
    },
    listModels: async () => [],
  };
  const pending = measureCall(hanging, req, prices, { now: () => clock.t });
  let settled = false;
  void pending.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(599_999);
  expect(settled).toBe(false);
  clock.t = 600_000;
  await vi.advanceTimersByTimeAsync(1);
  const out = await pending;
  expect(out.status).toBe('timeout');
  expect(out.errorCode).toBe('timeout');
  expect(out.retryable).toBe(true);
  expect(out.text).toBe('Début');
  expect(out.costUsd).toBeNull();
  expect(out.totalMs).toBe(600_000);
});

test('erreur au milieu du flux : texte gardé, erreur renvoyée masquée', async () => {
  const out = await measure([
    { at: 400, ev: text('Début de réponse') },
    { at: 600, error: new ProviderError('provider_unavailable', { detail: 'coupure avec la clé sk-abcdefghijklmnop' }) },
  ]);
  expect(out.status).toBe('error');
  expect(out.text).toBe('Début de réponse');
  expect(out.errorCode).toBe('provider_unavailable');
  expect(out.retryable).toBe(true);
  expect(out.errorMessage).toContain('Fournisseur indisponible');
  expect(out.errorMessage).not.toContain('sk-abcdefghijklmnop');
  expect(out.costUsd).toBeNull();
  expect(out.costSource).toBeNull();

  const raw = await measure([{ at: 100, error: new Error('socket fermé, Bearer abc.def.ghi') }]);
  expect(raw.errorCode).toBe('provider_unavailable');
  expect(raw.errorMessage).not.toContain('abc.def.ghi');

  const definitive = await measure([{ at: 100, error: new ProviderError('auth_invalid', { status: 401, retryAfterMs: null }) }]);
  expect(definitive).toMatchObject({ status: 'error', errorCode: 'auth_invalid', retryable: false, retryAfterMs: null });

  const limited = await measure([{ at: 100, error: new ProviderError('rate_limited', { status: 429, retryAfterMs: 5000 }) }]);
  expect(limited).toMatchObject({ errorCode: 'rate_limited', retryable: true, retryAfterMs: 5000 });
});

test('annulation par la tâche (arrêt) : rejette avec la raison, ce n’est pas une erreur du fournisseur', async () => {
  const controller = new AbortController();
  const hanging: ProviderAdapter = {
    async *generate(_req, signal) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
    },
    listModels: async () => [],
  };
  const reason = new Error('arrêt');
  const pending = measureCall(hanging, req, prices, { now: () => 0, signal: controller.signal });
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test('buildRequest : prompts, paramètres et pièces jointes en base64', async () => {
  const snapshot: TestSnapshot = {
    testId: 't',
    name: 'Test',
    category: 'Cat',
    tags: [],
    systemPrompt: null,
    userPrompt: 'Décris cette image',
    temperature: 0.7,
    maxTokens: 300,
    scoringMethod: 'manual',
    scoringConfig: {},
    attachments: [
      { id: 'a', originalName: 'photo.png', mime: 'image/png', size: 3, sha256: 'x'.repeat(64), pages: null, storagePath: 'attachments/t/a' },
    ],
  };
  const read: string[] = [];
  const out = await buildRequest(snapshot, 'gpt-x', async (a) => {
    read.push(a.storagePath);
    return Buffer.from('abc');
  });
  expect(read).toEqual(['attachments/t/a']);
  expect(out).toEqual({
    model: 'gpt-x',
    prompt: 'Décris cette image',
    attachments: [{ mime: 'image/png', base64: Buffer.from('abc').toString('base64'), filename: 'photo.png' }],
    temperature: 0.7,
    maxTokens: 4300, // limite du test (300) + marge de réflexion (4000)
  });
  const withSystem = await buildRequest({ ...snapshot, systemPrompt: 'Sois bref', attachments: [] }, 'gpt-x', async () => Buffer.alloc(0));
  expect(withSystem.system).toBe('Sois bref');
});

test('marge de réflexion : limite du test + 4000, plafonnée à 32 000 sauf demande supérieure du test', () => {
  expect(withReasoningMargin(300)).toBe(4300);
  expect(withReasoningMargin(1500)).toBe(5500);
  expect(withReasoningMargin(16_000)).toBe(20_000);
  expect(withReasoningMargin(30_000)).toBe(32_000);
  expect(withReasoningMargin(32_000)).toBe(32_000);
});

test('isTruncatedEmpty : réussie, sans texte, arrêtée par la limite', () => {
  const base = { status: 'done', text: '', finishReason: 'length' } as Parameters<typeof isTruncatedEmpty>[0];
  expect(isTruncatedEmpty(base)).toBe(true);
  expect(isTruncatedEmpty({ ...base, text: ' \t ' })).toBe(true);
  expect(isTruncatedEmpty({ ...base, text: 'Début de réponse' })).toBe(false);
  expect(isTruncatedEmpty({ ...base, finishReason: 'stop' })).toBe(false);
  expect(isTruncatedEmpty({ ...base, status: 'error' })).toBe(false);
});
