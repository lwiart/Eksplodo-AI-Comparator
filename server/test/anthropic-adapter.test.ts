import { beforeEach, describe, expect, test } from 'vitest';
import { createAnthropicAdapter } from '../src/modules/providers/anthropic.js';
import { ProviderError } from '../src/modules/providers/errors.js';
import { resetTemperatureMemory } from '../src/modules/providers/temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig } from '../src/modules/providers/types.js';
import { fakeFetch, fixtureText, sseResponse, type FakeFetch } from './helpers/fake-fetch.js';

const KEY = 'test-key-0123456789';
const BASE = 'https://anthropic.test';
const URL_MSG = `POST ${BASE}/v1/messages`;
const URL_MODELS = `GET ${BASE}/v1/models`;
const sig = new AbortController().signal;

const req: GenerateRequest = {
  model: 'claude-opus-5-5',
  system: 'Sois bref',
  prompt: 'Décris',
  attachments: [],
  temperature: 0.2,
  maxTokens: 1000,
};

function make(fetchMock: FakeFetch, over: Partial<ProviderConfig> = {}): ProviderAdapter {
  return createAnthropicAdapter({
    id: 'a1',
    type: 'anthropic',
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
const reasoningOf = (events: GenerateEvent[]) => events.flatMap((e) => (e.type === 'reasoning' ? [e.delta] : []));
const usageOf = (events: GenerateEvent[]) => events.find((e) => e.type === 'usage');
const bodyOf = async (r: Request): Promise<any> => JSON.parse(await r.clone().text());

beforeEach(() => resetTemperatureMemory());

describe('generate', () => {
  test('texte et usage (entrée de message_start, sortie de message_delta)', async () => {
    const events = await collect(make(fakeFetch({ [URL_MSG]: ok('anthropic/text.sse') })));
    expect(textOf(events)).toBe('Bonjour');
    expect(usageOf(events)).toMatchObject({ inputTokens: 25, outputTokens: 9 });
    expect(events.at(-2)?.type).toBe('usage');
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  test('requête : en-tête x-api-key, max_tokens, système, image et document en base64 avant le texte', async () => {
    const f = fakeFetch({ [URL_MSG]: ok('anthropic/text.sse') });
    await collect(make(f), {
      ...req,
      attachments: [
        { mime: 'image/png', base64: 'iVBOR', filename: 'a.png' },
        { mime: 'application/pdf', base64: 'JVBER', filename: 'b.pdf' },
      ],
    });
    const call = f.calls[0]!;
    const body = await bodyOf(call);
    expect(call.headers.get('x-api-key')).toBe(KEY);
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
      { type: 'text', text: 'Décris' },
    ]);
    expect(body.system).toBe('Sois bref');
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
    expect(body.thinking).toBeUndefined();
  });

  test('sans pièce jointe ni consigne système ni température', async () => {
    const f = fakeFetch({ [URL_MSG]: ok('anthropic/text.sse') });
    await collect(make(f), { ...req, system: undefined, temperature: undefined });
    const body = await bodyOf(f.calls[0]!);
    expect(body.system).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'Décris' }]);
  });

  test('thinking_delta → reasoning ; le texte vide de raisonnement n’émet rien', async () => {
    const events = await collect(make(fakeFetch({ [URL_MSG]: ok('anthropic/thinking.sse') })));
    expect(reasoningOf(events)).toEqual(['Je réfléchis']);
    expect(textOf(events)).toBe('Bonjour');
  });

  test.each([
    ['anthropic/text.sse', 'stop'],
    ['anthropic/max-tokens.sse', 'length'],
    ['anthropic/refusal.sse', 'refusal'],
  ])('fixture %s → finish %s', async (fixture, reason) => {
    const events = await collect(make(fakeFetch({ [URL_MSG]: ok(fixture) })));
    expect(events.at(-1)).toEqual({ type: 'finish', reason });
  });

  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
  ])('stop_reason %s → %s', async (stop, reason) => {
    const sse = fixtureText('anthropic/text.sse').replace('"end_turn"', JSON.stringify(stop));
    const f = fakeFetch({ [URL_MSG]: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) });
    const events = await collect(make(f));
    expect(events.at(-1)).toEqual({ type: 'finish', reason });
  });

  test('événement error en cours de flux (overloaded_error) → provider_unavailable', async () => {
    const seen: GenerateEvent[] = [];
    const adapter = make(fakeFetch({ [URL_MSG]: ok('anthropic/error-midstream.sse') }));
    await expect(collect(adapter, req, seen)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(textOf(seen)).toBe('Début');
  });

  test.each([
    [401, 'auth_invalid'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
  ])('HTTP %i → %s, aucune nouvelle tentative du SDK, clé absente du détail', async (status, code) => {
    const body = JSON.stringify({ type: 'error', error: { type: 'x', message: `clé ${KEY}` } });
    const f = fakeFetch({ [URL_MSG]: () => new Response(body, { status, headers: { 'retry-after': '3' } }) });
    const err = await collect(make(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f.calls).toHaveLength(1);
    expect(err).toMatchObject({ code, status });
    if (status === 429) expect(err).toMatchObject({ retryAfterMs: 3000 });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('exception de fetch → provider_unavailable sans la clé', async () => {
    const f = fakeFetch({
      [URL_MSG]: () => {
        throw new TypeError(`échec réseau avec ${KEY}`);
      },
    });
    const err = await collect(make(f)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'provider_unavailable' });
    expect((err as ProviderError).detail).not.toContain(KEY);
  });

  test('annulation par l’appelant : la raison d’origine est relancée', async () => {
    const ctl = new AbortController();
    const reason = new Error('annulé');
    const f = fakeFetch({
      [URL_MSG]: () => {
        ctl.abort(reason);
        throw new Error('abandon');
      },
    });
    const run = async () => {
      for await (const e of make(f).generate(req, ctl.signal)) void e;
    };
    await expect(run()).rejects.toBe(reason);
  });

  test('400 « temperature … not supported » : renvoi sans temperature, mémorisé', async () => {
    const reject = () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is not supported for this model' } }),
        { status: 400 },
      );
    const f = fakeFetch({ [URL_MSG]: [reject, ok('anthropic/text.sse')] });
    const adapter = make(f);
    expect(textOf(await collect(adapter))).toBe('Bonjour');
    expect(f.calls).toHaveLength(2);
    expect((await bodyOf(f.calls[0]!)).temperature).toBe(0.2);
    expect((await bodyOf(f.calls[1]!)).temperature).toBeUndefined();
    await collect(adapter);
    expect(f.calls).toHaveLength(3);
    expect((await bodyOf(f.calls[2]!)).temperature).toBeUndefined();
  });

  test('le renvoi sans temperature n’a lieu qu’une fois', async () => {
    const reject = () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature is not supported' } }),
        { status: 400 },
      );
    const f = fakeFetch({ [URL_MSG]: reject });
    await expect(collect(make(f))).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.calls).toHaveLength(2);
  });
});

describe('listModels', () => {
  const list = () => new Response(fixtureText('anthropic/models.json'), { headers: { 'content-type': 'application/json' } });

  test('display_name, max_input_tokens et image_input', async () => {
    const f = fakeFetch({ [URL_MODELS]: list });
    const models = await make(f).listModels(sig);
    expect(models[0]).toMatchObject({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, supportsVision: true, supportsPdf: true });
    expect(models[1]).toMatchObject({ id: 'claude-legacy', contextWindow: 200_000, supportsVision: false, supportsPdf: false });
    expect(f.calls[0]!.headers.get('x-api-key')).toBe(KEY);
  });

  test('préremplit les prix connus', async () => {
    const f = fakeFetch({ [URL_MODELS]: list });
    const models = await make(f).listModels(sig);
    expect(models[0]).toMatchObject({ inputPricePerM: 4, outputPricePerM: 20 });
    expect(models[1]).toMatchObject({ inputPricePerM: null, outputPricePerM: null });
  });

  test('HTTP 401 → auth_invalid', async () => {
    const f = fakeFetch({ [URL_MODELS]: () => new Response('{}', { status: 401 }) });
    await expect(make(f).listModels(sig)).rejects.toMatchObject({ code: 'auth_invalid' });
  });
});
