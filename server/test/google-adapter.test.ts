import { beforeEach, describe, expect, test } from 'vitest';
import { createGoogleAdapter } from '../src/modules/providers/google.js';
import { ProviderError } from '../src/modules/providers/errors.js';
import { resetTemperatureMemory } from '../src/modules/providers/temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig } from '../src/modules/providers/types.js';
import { fakeFetch, fixtureText, sseResponse, type FakeFetch } from './helpers/fake-fetch.js';

const KEY = 'test-key-0123456789';
const BASE = 'https://g.test/v1beta';
const URL_GEN = `POST ${BASE}/models/gemini-x:streamGenerateContent?alt=sse`;
const sig = new AbortController().signal;

const req: GenerateRequest = {
  model: 'gemini-x',
  system: 'Sois bref',
  prompt: 'Décris',
  attachments: [],
  temperature: 0.2,
  maxTokens: 1000,
};

function make(fetchMock: FakeFetch, over: Partial<ProviderConfig> = {}): ProviderAdapter {
  return createGoogleAdapter({
    id: 'g1',
    type: 'google',
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
const textOf = (events: GenerateEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const usageOf = (events: GenerateEvent[]) => events.find((e) => e.type === 'usage');
const bodyOf = async (r: Request): Promise<any> => JSON.parse(await r.clone().text());

beforeEach(() => resetTemperatureMemory());

describe('generate', () => {
  test('texte, usage puis finish : événements dans l’ordre', async () => {
    const events = await collect(make(fakeFetch({ [URL_GEN]: ok('google/text.sse') })));
    expect(textOf(events)).toBe('Bonjour le monde');
    expect(events.at(-2)).toEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, reasoningTokens: undefined, costUsd: undefined });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  test('URL et en-tête : la clé n’est jamais dans l’URL', async () => {
    const f = fakeFetch({ [URL_GEN]: ok('google/text.sse') });
    await collect(make(f, { baseUrl: `${BASE}/` }));
    const call = { url: f.calls[0]!.url, headers: f.calls[0]!.headers };
    expect(call.url).toBe('https://g.test/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    expect(call.url).not.toMatch(/key=/);
    expect(call.headers.get('x-goog-api-key')).toBe(KEY);
  });

  test('sans clé : pas d’en-tête x-goog-api-key', async () => {
    const f = fakeFetch({ [URL_GEN]: ok('google/text.sse') });
    await collect(make(f, { apiKey: null }));
    expect(f.calls[0]!.headers.get('x-goog-api-key')).toBeNull();
  });

  test('l’identifiant du modèle est encodé dans l’URL', async () => {
    const f = fakeFetch({ [`POST ${BASE}/models/gemini%2Fx%20y:streamGenerateContent?alt=sse`]: ok('google/text.sse') });
    await collect(make(f), { ...req, model: 'gemini/x y' });
    expect(f.calls).toHaveLength(1);
  });

  test('corps : systemInstruction, inline_data, generationConfig', async () => {
    const f = fakeFetch({ [URL_GEN]: ok('google/text.sse') });
    await collect(make(f), {
      ...req,
      attachments: [
        { mime: 'application/pdf', base64: 'JVBER', filename: 'doc.pdf' },
        { mime: 'image/png', base64: 'iVBOR', filename: 'a.png' },
      ],
    });
    expect(await bodyOf(f.calls[0]!)).toMatchObject({
      systemInstruction: { parts: [{ text: 'Sois bref' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/png', data: 'iVBOR' } },
            { inline_data: { mime_type: 'application/pdf', data: 'JVBER' } },
            { text: 'Décris' },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
    });
  });

  test('sans consigne système ni température', async () => {
    const f = fakeFetch({ [URL_GEN]: ok('google/text.sse') });
    await collect(make(f), { ...req, system: undefined, temperature: undefined });
    const body = await bodyOf(f.calls[0]!);
    expect('systemInstruction' in body).toBe(false);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1000 });
  });

  test('parties thought:true → reasoning, usage final avec thoughtsTokenCount', async () => {
    const events = await collect(make(fakeFetch({ [URL_GEN]: ok('google/thoughts.sse') })));
    expect(events.flatMap((e) => (e.type === 'reasoning' ? [e.delta] : [])).join('')).toBe('Je réfléchis.');
    expect(textOf(events)).toBe('Voici la réponse.');
    expect(usageOf(events)).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 20, reasoningTokens: 35, costUsd: undefined });
  });

  test.each([
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['MALFORMED_FUNCTION_CALL', 'other'],
  ])('finishReason %s → %s', async (raw, expected) => {
    const chunk = `data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"${raw}"}],"usageMetadata":{"promptTokenCount":1}}\n\n`;
    const events = await collect(make(fakeFetch({ [URL_GEN]: () => new Response(chunk) })));
    expect(events.at(-2)).toMatchObject({ type: 'usage' });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: expected });
  });

  test('fixtures max-tokens et safety', async () => {
    const length = await collect(make(fakeFetch({ [URL_GEN]: ok('google/max-tokens.sse') })));
    expect(length.at(-1)).toEqual({ type: 'finish', reason: 'length' });
    const safety = await collect(make(fakeFetch({ [URL_GEN]: ok('google/safety.sse') })));
    expect(textOf(safety)).toBe('Début');
    expect(safety.at(-1)).toEqual({ type: 'finish', reason: 'content_filter' });
  });

  test('promptFeedback.blockReason sans candidat → finish content_filter', async () => {
    const events = await collect(make(fakeFetch({ [URL_GEN]: ok('google/prompt-blocked.sse') })));
    expect(textOf(events)).toBe('');
    expect(events.at(-2)).toMatchObject({ type: 'usage', inputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'content_filter' });
  });

  test('flux sans finishReason : se termine sans événement finish', async () => {
    const chunk = 'data: {"candidates":[{"content":{"parts":[{"text":"coupé"}]}}]}\n\n';
    const events = await collect(make(fakeFetch({ [URL_GEN]: () => new Response(chunk) })));
    expect(events.map((e) => e.type)).toEqual(['text']);
  });

  test('erreur au milieu du flux ({"error":…}) → ProviderError après le texte déjà émis', async () => {
    const adapter = make(fakeFetch({ [URL_GEN]: ok('google/error-midstream.sse') }));
    const seen: GenerateEvent[] = [];
    await expect(collect(adapter, req, seen)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(textOf(seen)).toBe('Début de réponse');
  });

  test('paquet "error": null avec du texte : pas une erreur', async () => {
    const sse = 'data: {"error":null,"candidates":[{"content":{"role":"model","parts":[{"text":"Bonjour"}]},"finishReason":"STOP"}]}\n\n';
    const events = await collect(make(fakeFetch({ [URL_GEN]: () => new Response(sse) })));
    expect(textOf(events)).toBe('Bonjour');
  });

  test('ligne data non JSON → invalid_response', async () => {
    const adapter = make(fakeFetch({ [URL_GEN]: ok('google/bad-json.sse') }));
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('400 API_KEY_INVALID → auth_invalid, sans la clé dans le détail', async () => {
    const body = JSON.stringify({
      error: { code: 400, message: `API key not valid (${KEY}). Please pass a valid API key.`, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
    });
    const adapter = make(fakeFetch({ [URL_GEN]: () => new Response(body, { status: 400 }) }));
    const err = await collect(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'auth_invalid', status: 400 });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('exception de fetch → provider_unavailable sans la clé', async () => {
    const f = fakeFetch({
      [URL_GEN]: () => {
        throw new TypeError(`échec réseau avec ${KEY}`);
      },
    });
    const err = await collect(make(f)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'provider_unavailable' });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('400 mentionnant temperature : renvoi unique sans temperature, puis mémorisé', async () => {
    const reject = () =>
      new Response(JSON.stringify({ error: { code: 400, message: 'temperature is not supported for this model' } }), { status: 400 });
    const f = fakeFetch({ [URL_GEN]: [reject, ok('google/text.sse')] });
    const adapter = make(f);
    expect(textOf(await collect(adapter))).toBe('Bonjour le monde');
    expect(f.calls).toHaveLength(2);
    expect((await bodyOf(f.calls[0]!)).generationConfig.temperature).toBe(0.2);
    expect((await bodyOf(f.calls[1]!)).generationConfig.temperature).toBeUndefined();
    await collect(adapter);
    expect(f.calls).toHaveLength(3);
    expect((await bodyOf(f.calls[2]!)).generationConfig.temperature).toBeUndefined();
  });

  test('le renvoi sans temperature n’a lieu qu’une fois', async () => {
    const reject = () => new Response(JSON.stringify({ error: { message: 'temperature is not supported' } }), { status: 400 });
    const f = fakeFetch({ [URL_GEN]: reject });
    await expect(collect(make(f))).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.calls).toHaveLength(2);
  });
});

describe('listModels', () => {
  const P1 = `GET ${BASE}/models?pageSize=1000`;
  const P2 = `GET ${BASE}/models?pageSize=1000&pageToken=page%202%2F%26`;

  test('préfixe models/ retiré, pagination suivie, seuls les modèles generateContent', async () => {
    const f = fakeFetch({
      [P1]: () => new Response(fixtureText('google/models-page1.json')),
      [P2]: () => new Response(fixtureText('google/models-page2.json')),
    });
    const models = await make(f).listModels(sig);
    expect(models.map((m) => m.id)).toEqual(['gemini-a', 'gemini-b']);
    expect(models[0]).toEqual({
      id: 'gemini-a', name: 'Gemini A', contextWindow: 1_048_576, inputPricePerM: null, outputPricePerM: null, supportsVision: null, supportsPdf: null,
    });
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(c.url).not.toMatch(/key=/);
      expect(c.headers.get('x-goog-api-key')).toBe(KEY);
    }
  });

  test('HTTP 401 et réponse illisible', async () => {
    const f401 = fakeFetch({ [P1]: () => new Response('{}', { status: 401 }) });
    await expect(make(f401).listModels(sig)).rejects.toMatchObject({ code: 'auth_invalid' });
    const fBad = fakeFetch({ [P1]: () => new Response('<html>') });
    await expect(make(fBad).listModels(sig)).rejects.toMatchObject({ code: 'invalid_response' });
    const fShape = fakeFetch({ [P1]: () => new Response('{"models":"x"}') });
    await expect(make(fShape).listModels(sig)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
