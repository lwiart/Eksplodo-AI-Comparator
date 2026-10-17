import { afterEach, describe, expect, test } from 'vitest';
import { createFakeAdapter, FAKE_MODELS, resetFakeCallCounters } from '../src/modules/providers/fake.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter } from '../src/modules/providers/types.js';

const sig = new AbortController().signal;
const req: GenerateRequest = { model: 'fake-rapide', prompt: 'Explique la photosynthèse', attachments: [], maxTokens: 200 };

function withSleeps(seed?: number) {
  const sleeps: number[] = [];
  const adapter = createFakeAdapter({
    seed,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { adapter, sleeps };
}

async function run(adapter: ProviderAdapter, r: GenerateRequest = req, signal: AbortSignal = sig): Promise<GenerateEvent[]> {
  const events: GenerateEvent[] = [];
  for await (const e of adapter.generate(r, signal)) events.push(e);
  return events;
}

describe('faux fournisseur', () => {
  afterEach(() => resetFakeCallCounters());

  test('même graine, même prompt → mêmes événements', async () => {
    const a1 = withSleeps(7).adapter;
    const a2 = withSleeps(7).adapter;
    expect(await run(a1)).toEqual(await run(a2));
  });

  test('latence avant le premier texte proche du profil', async () => {
    const { adapter, sleeps } = withSleeps();
    await run(adapter);
    expect(sleeps[0]).toBeGreaterThanOrEqual(240);
    expect(sleeps[0]).toBeLessThanOrEqual(360);
  });

  test('texte borné à maxTokens, finish length si coupé', async () => {
    const events = await run(withSleeps().adapter, { ...req, maxTokens: 5 });
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text.length).toBeLessThanOrEqual(5 * 4);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' });
    const usage = events.find((e) => e.type === 'usage') as Extract<GenerateEvent, { type: 'usage' }>;
    expect(usage.outputTokens).toBeLessThanOrEqual(5);
    expect('costUsd' in usage).toBe(false);
  });

  test('flux complet : texte, usage puis finish stop', async () => {
    const events = await run(withSleeps().adapter);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(events.at(-2)?.type).toBe('usage');
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  test('usage : entrée = caractères ÷ 4, plus 1 500 par image et 800 par PDF', async () => {
    const adapter = withSleeps().adapter;
    const base = { ...req, model: 'fake-vision', system: 'abcd', prompt: 'efghijkl' };
    const get = async (r: GenerateRequest) =>
      ((await run(adapter, r)).find((e) => e.type === 'usage') as Extract<GenerateEvent, { type: 'usage' }>).inputTokens;
    expect(await get(base)).toBe(3);
    const atts = [
      { mime: 'image/png', base64: 'AA', filename: 'a.png' },
      { mime: 'application/pdf', base64: 'AA', filename: 'a.pdf' },
    ];
    expect(await get({ ...base, attachments: atts })).toBe(3 + 1500 + 800);
  });

  test.each([
    ['[[fake:429]]', 'rate_limited'],
    ['[[fake:500]]', 'provider_unavailable'],
  ])('%s → %s avant tout texte', async (d, code) => {
    const events: GenerateEvent[] = [];
    const gen = withSleeps().adapter.generate({ ...req, prompt: `x ${d}` }, sig);
    await expect(
      (async () => {
        for await (const e of gen) events.push(e);
      })(),
    ).rejects.toMatchObject({ code });
    expect(events).toEqual([]);
  });

  test('[[fake:timeout]] attend l’annulation', async () => {
    const p = run(createFakeAdapter(), { ...req, prompt: '[[fake:timeout]]' }, AbortSignal.timeout(20));
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test('[[fake:refusal]] et [[fake:length]] fixent la raison de fin', async () => {
    const refusal = await run(withSleeps().adapter, { ...req, prompt: '[[fake:refusal]]' });
    expect(refusal.at(-1)).toEqual({ type: 'finish', reason: 'refusal' });
    const length = await run(withSleeps().adapter, { ...req, prompt: '[[fake:length]]' });
    expect(length.at(-1)).toEqual({ type: 'finish', reason: 'length' });
  });

  test('[[fake:cut]] : ni usage ni finish', async () => {
    const events = await run(withSleeps().adapter, { ...req, prompt: '[[fake:cut]]' });
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.some((e) => e.type === 'usage' || e.type === 'finish')).toBe(false);
  });

  test('[[fake:reasoning]] : raisonnement avant le texte', async () => {
    const events = await run(withSleeps().adapter, { ...req, prompt: '[[fake:reasoning]]' });
    const firstText = events.findIndex((e) => e.type === 'text');
    const firstReasoning = events.findIndex((e) => e.type === 'reasoning');
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstText);
    // Sortie hors raisonnement : autant de tokens que de texte émis (4 caractères par token).
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    const usage = events.find((e) => e.type === 'usage') as Extract<GenerateEvent, { type: 'usage' }>;
    expect(usage.reasoningTokens).toBe(24);
    expect(usage.outputTokens! * 4).toBe(text.length);
  });

  test('modèle inconnu → profil fake-equilibre, pas model_not_found', async () => {
    const { adapter, sleeps } = withSleeps();
    const events = await run(adapter, { ...req, model: 'gpt-x' });
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    expect(sleeps[0]).toBeGreaterThanOrEqual(640); // 800 ms ± 20 %
    expect(sleeps[0]).toBeLessThanOrEqual(960);
  });

  test('fake-instable : une nouvelle tentative du même appel peut réussir', async () => {
    const adapter = withSleeps(1).adapter;
    const instable = (prompt: string): GenerateRequest => ({ ...req, model: 'fake-instable', prompt });
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      resetFakeCallCounters();
      const prompt = `essai ${i}`;
      try {
        await run(adapter, instable(prompt));
      } catch {
        // 1er appel en échec : l'un des 5 suivants doit réussir
        for (let k = 0; k < 5 && !found; k++) {
          try {
            await run(adapter, instable(prompt));
            found = true;
          } catch {
            /* nouvelle tentative */
          }
        }
        expect(found).toBe(true);
      }
    }
    expect(found).toBe(true);
  });

  test('les directives restent déterministes malgré le compteur', async () => {
    const adapter = withSleeps().adapter;
    const r = { ...req, model: 'fake-instable', prompt: '[[fake:429]]' };
    for (let i = 0; i < 3; i++) await expect(run(adapter, r)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  test('fake-instable échoue parfois (429 ou 500), de façon déterministe', async () => {
    const adapter = withSleeps(1).adapter;
    const codes: string[] = [];
    for (let i = 0; i < 40; i++) {
      try {
        await run(adapter, { ...req, model: 'fake-instable', prompt: `essai ${i}` });
        codes.push('ok');
      } catch (e) {
        codes.push((e as { code: string }).code);
      }
    }
    expect(codes).toContain('ok');
    expect(codes.some((c) => c === 'rate_limited' || c === 'provider_unavailable')).toBe(true);
  });

  test('listModels renvoie FAKE_MODELS ; seul fake-vision gère image et PDF', async () => {
    const models = await createFakeAdapter().listModels(sig);
    expect(models).toEqual(FAKE_MODELS);
    expect(models.map((m) => m.id)).toContain('fake-vision');
    expect(models.filter((m) => m.supportsVision).map((m) => m.id)).toEqual(['fake-vision']);
    expect(models.filter((m) => m.supportsPdf).map((m) => m.id)).toEqual(['fake-vision']);
  });
});
