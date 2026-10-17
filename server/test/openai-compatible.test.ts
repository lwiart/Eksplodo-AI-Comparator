import { beforeEach, describe, expect, test } from 'vitest';
import { createOpenAiCompatibleAdapter } from '../src/modules/providers/openai-compatible.js';
import { ProviderError } from '../src/modules/providers/errors.js';
import { resetTemperatureMemory } from '../src/modules/providers/temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig } from '../src/modules/providers/types.js';
import { fakeFetch, fixtureText, sseResponse, type FakeFetch } from './helpers/fake-fetch.js';

const KEY = 'test-key-0123456789';
const BASE = 'https://x.test/v1';
const URL_CHAT = `POST ${BASE}/chat/completions`;
const sig = new AbortController().signal;

const req: GenerateRequest = {
  model: 'gpt-x',
  system: 'Sois bref',
  prompt: 'Bonjour ?',
  attachments: [],
  temperature: 0.2,
  maxTokens: 100,
};

function make(fetchMock: FakeFetch, over: Partial<ProviderConfig> = {}): ProviderAdapter {
  return createOpenAiCompatibleAdapter({
    id: 'p1',
    type: 'openai_compatible',
    baseUrl: BASE,
    apiKey: KEY,
    appBaseUrl: 'https://app.test',
    fetch: fetchMock,
    ...over,
  });
}

async function collect(adapter: ProviderAdapter, r: GenerateRequest = req, seen: GenerateEvent[] = []): Promise<GenerateEvent[]> {
  for await (const e of adapter.generate(r, sig)) seen.push(e);
  return seen;
}

const ok = (fixture: string) => () => sseResponse(fixture);
const textOf = (events: GenerateEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const kinds = (events: GenerateEvent[]) => events.map((e) => e.type);
const bodyOf = async (r: Request): Promise<any> => JSON.parse(await r.clone().text());

beforeEach(() => resetTemperatureMemory());

describe('generate', () => {
  test('texte, usage puis finish : événements dans l’ordre', async () => {
    const events = await collect(make(fakeFetch({ [URL_CHAT]: ok('openai/text.sse') })));
    expect(textOf(events)).toBe('Bonjour le monde');
    expect(events.at(-2)).toEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, reasoningTokens: undefined, costUsd: undefined });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  test('corps de la requête et authentification', async () => {
    const f = fakeFetch({ [URL_CHAT]: ok('openai/text.sse') });
    await collect(make(f, { baseUrl: `${BASE}/` }));
    const body = await bodyOf(f.calls[0]!);
    expect(body).toMatchObject({ model: 'gpt-x', stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 100 });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Sois bref' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Bonjour ?' });
    expect(body.usage).toBeUndefined();
    expect(f.calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(f.calls[0]!.headers.get('x-title')).toBeNull();
  });

  test('sans clé : pas d’en-tête authorization', async () => {
    const f = fakeFetch({ [URL_CHAT]: ok('openai/text.sse') });
    await collect(make(f, { apiKey: null }));
    expect(f.calls[0]!.headers.get('authorization')).toBeNull();
  });

  test('api.openai.com : max_completion_tokens ; autres hôtes : max_tokens', async () => {
    const f1 = fakeFetch({ 'POST https://api.openai.com/v1/chat/completions': ok('openai/text.sse') });
    await collect(make(f1, { baseUrl: 'https://api.openai.com/v1' }));
    const b1 = await bodyOf(f1.calls[0]!);
    expect(b1.max_completion_tokens).toBe(100);
    expect(b1.max_tokens).toBeUndefined();
    const f2 = fakeFetch({ [URL_CHAT]: ok('openai/text.sse') });
    await collect(make(f2));
    const b2 = await bodyOf(f2.calls[0]!);
    expect(b2.max_tokens).toBe(100);
    expect(b2.max_completion_tokens).toBeUndefined();
  });

  test('image en image_url data:, PDF en partie file', async () => {
    const f = fakeFetch({ [URL_CHAT]: ok('openai/text.sse') });
    await collect(make(f), {
      ...req,
      prompt: 'Décris',
      attachments: [
        { mime: 'application/pdf', base64: 'JVBER', filename: 'doc.pdf' },
        { mime: 'image/png', base64: 'iVBOR', filename: 'a.png' },
      ],
    });
    const userParts = (await bodyOf(f.calls[0]!)).messages[1].content;
    expect(userParts).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
      { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBER' } },
      { type: 'text', text: 'Décris' },
    ]);
  });

  test('sans consigne système ni température', async () => {
    const f = fakeFetch({ [URL_CHAT]: ok('openai/text.sse') });
    await collect(make(f), { ...req, system: undefined, temperature: undefined });
    const body = await bodyOf(f.calls[0]!);
    expect(body.messages).toEqual([{ role: 'user', content: 'Bonjour ?' }]);
    expect('temperature' in body).toBe(false);
  });

  test('raisonnement DeepSeek (reasoning_content) → événements reasoning', async () => {
    const events = await collect(make(fakeFetch({ [URL_CHAT]: ok('openai/reasoning-deepseek.sse') })));
    expect(kinds(events)).toContain('reasoning');
    const reasoning = events.flatMap((e) => (e.type === 'reasoning' ? [e.delta] : [])).join('');
    expect(reasoning).toBe('Je réfléchis à la question.');
    expect(textOf(events)).toBe('Voici la réponse.');
    // completion_tokens (30) inclut le raisonnement (18) : la sortie l'exclut.
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 20, outputTokens: 12, reasoningTokens: 18 });
  });

  test('usage : raisonnement supérieur à completion_tokens → sortie 0, jamais négative', async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"Oui"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"completion_tokens_details":{"reasoning_tokens":9}}}\n\ndata: [DONE]\n\n';
    const events = await collect(make(fakeFetch({ [URL_CHAT]: () => new Response(sse) })));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 5, outputTokens: 0, reasoningTokens: 9 });
  });

  test('OpenRouter : usage.include demandé, coût réel lu dans usage.cost', async () => {
    const url = 'https://openrouter.ai/api/v1';
    const f = fakeFetch({ [`POST ${url}/chat/completions`]: ok('openrouter/stream-with-cost.sse') });
    const events = await collect(make(f, { baseUrl: url }));
    const body = await bodyOf(f.calls[0]!);
    expect(body.usage).toEqual({ include: true });
    const usage = events.find((e) => e.type === 'usage') as Extract<GenerateEvent, { type: 'usage' }>;
    expect(usage.costUsd).toBeCloseTo(0.000123, 9);
    expect(usage).toMatchObject({ inputTokens: 14, outputTokens: 3 });
    expect(f.calls[0]!.headers.get('x-title')).toBe('Eksplodo Comparateur IA');
    expect(f.calls[0]!.headers.get('http-referer')).toBe('https://app.test');
    expect(textOf(events)).toBe('Bonjour !');
  });

  test('refus OpenAI (delta.refusal) → texte conservé, finish refusal', async () => {
    const events = await collect(make(fakeFetch({ [URL_CHAT]: ok('openai/refusal.sse') })));
    expect(textOf(events)).toBe('Je ne peux pas aider avec cela.');
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'refusal' });
  });

  test('finish_reason length et content_filter', async () => {
    const events = await collect(make(fakeFetch({ [URL_CHAT]: ok('openai/length.sse') })));
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' });
    const chunk = (reason: string) =>
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}]}\n\ndata: [DONE]\n\n`;
    for (const [raw, expected] of [['content_filter', 'content_filter'], ['tool_calls', 'other']] as const) {
      const f = fakeFetch({ [URL_CHAT]: () => new Response(chunk(raw)) });
      expect((await collect(make(f))).at(-1)).toEqual({ type: 'finish', reason: expected });
    }
  });

  test('erreur au milieu du flux ({"error":…}) → ProviderError après le texte déjà émis', async () => {
    const adapter = make(fakeFetch({ [URL_CHAT]: ok('openai/error-midstream.sse') }));
    const seen: GenerateEvent[] = [];
    await expect(collect(adapter, req, seen)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(textOf(seen)).toBe('Début de réponse');
  });

  test('paquet "error": null avec du texte : pas une erreur', async () => {
    const sse = 'data: {"error":null,"choices":[{"index":0,"delta":{"content":"Bonjour"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const events = await collect(make(fakeFetch({ [URL_CHAT]: () => new Response(sse) })));
    expect(textOf(events)).toBe('Bonjour');
  });

  test('flux coupé sans [DONE] ni finish_reason : se termine sans événement finish', async () => {
    const events = await collect(make(fakeFetch({ [URL_CHAT]: ok('openai/cut.sse') })));
    expect(textOf(events)).toBe('Réponse coupée');
    expect(kinds(events)).not.toContain('finish');
  });

  test('ligne data non JSON → invalid_response', async () => {
    const adapter = make(fakeFetch({ [URL_CHAT]: ok('openai/bad-json.sse') }));
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('HTTP 401 → auth_invalid, sans la clé dans le détail', async () => {
    const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } });
    const adapter = make(fakeFetch({ [URL_CHAT]: () => new Response(body, { status: 401 }) }));
    const err = await collect(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'auth_invalid', status: 401 });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('exception de fetch → provider_unavailable sans la clé', async () => {
    const f = fakeFetch({
      [URL_CHAT]: () => {
        throw new TypeError(`échec réseau avec ${KEY}`);
      },
    });
    const err = await collect(make(f)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'provider_unavailable' });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('400 mentionnant temperature : renvoi unique sans temperature, puis mémorisé', async () => {
    const reject = () =>
      new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'" } }), { status: 400 });
    const f = fakeFetch({ [URL_CHAT]: [reject, ok('openai/text.sse')] });
    const adapter = make(f);
    expect(textOf(await collect(adapter))).toBe('Bonjour le monde');
    expect(f.calls).toHaveLength(2);
    expect((await bodyOf(f.calls[0]!)).temperature).toBe(0.2);
    expect((await bodyOf(f.calls[1]!)).temperature).toBeUndefined();
    await collect(adapter);
    expect(f.calls).toHaveLength(3);
    expect((await bodyOf(f.calls[2]!)).temperature).toBeUndefined();
  });

  test('le renvoi sans temperature n’a lieu qu’une fois', async () => {
    const reject = () =>
      new Response(JSON.stringify({ error: { message: 'temperature is not supported' } }), { status: 400 });
    const f = fakeFetch({ [URL_CHAT]: reject });
    await expect(collect(make(f))).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.calls).toHaveLength(2);
  });
});

describe('listModels', () => {
  test('GET {base}/models, identifiants triés', async () => {
    const f = fakeFetch({ [`GET ${BASE}/models`]: () => new Response(fixtureText('openai/models.json')) });
    const models = await make(f).listModels(sig);
    expect(models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(models[0]).toEqual({
      id: 'gpt-a', name: 'gpt-a', contextWindow: null, inputPricePerM: null, outputPricePerM: null, supportsVision: null, supportsPdf: null,
    });
    expect(f.calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test('listModels sur OpenRouter : prix et capacités renseignés', async () => {
    const url = 'https://openrouter.ai/api/v1';
    const f = fakeFetch({ [`GET ${url}/models`]: () => new Response(fixtureText('openrouter/models.json')) });
    const models = await make(f, { baseUrl: url }).listModels(sig);
    expect(models.find((m) => m.id === 'anthropic/claude-sonnet-5.5')).toMatchObject({
      inputPricePerM: 2, outputPricePerM: 10, supportsVision: true, supportsPdf: true,
    });
  });

  test('listModels sur OpenRouter sans tableau data → invalid_response', async () => {
    const url = 'https://openrouter.ai/api/v1';
    const f = fakeFetch({ [`GET ${url}/models`]: () => new Response('{"models":[]}') });
    await expect(make(f, { baseUrl: url }).listModels(sig)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('HTTP 401 et réponse illisible', async () => {
    const f401 = fakeFetch({ [`GET ${BASE}/models`]: () => new Response('{}', { status: 401 }) });
    await expect(make(f401).listModels(sig)).rejects.toMatchObject({ code: 'auth_invalid' });
    const fBad = fakeFetch({ [`GET ${BASE}/models`]: () => new Response('<html>') });
    await expect(make(fBad).listModels(sig)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
