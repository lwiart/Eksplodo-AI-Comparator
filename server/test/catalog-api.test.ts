import { afterEach, describe, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { fakeFetch } from './helpers/fake-fetch.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const BASE = 'https://api.example.test/v1';
const KEY = 'sk-test-0123456789abcd';
const created: TestApp[] = [];

async function setup(opts: { fetch?: typeof fetch; fakeLlm?: boolean } = {}) {
  const t = await buildTestApp(opts);
  created.push(t);
  await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    ...t,
    admin,
    user,
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown = {}, s = admin) => call('POST', url, s, payload),
    patch: (url: string, payload: unknown, s = admin) => call('PATCH', url, s, payload),
  };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

const code = (res: { json(): any }) => res.json().error.code;
const modelsList = (ids: string[]) => () => Response.json({ data: ids.map((id) => ({ id })) });

describe('fournisseurs', () => {
  test('POST /api/providers avec clé : chiffrée, jamais renvoyée, last4 pour l’Admin seulement', async () => {
    const { post, get, db, user } = await setup();
    const res = await post('/api/providers', {
      name: 'Requesty bis',
      type: 'openai_compatible',
      baseUrl: 'https://router.requesty.ai/v1',
      apiKey: 'rq-test-0123456789wxyz',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toMatchObject({ keyState: 'stored', keyLast4: 'wxyz', usable: true });
    expect(res.body).not.toContain('0123456789');
    const list = await get('/api/providers', user);
    expect(list.json().providers.find((p: any) => p.name === 'Requesty bis')).toMatchObject({
      keyState: 'stored',
      keyLast4: null,
    });
    expect(list.body).not.toContain('0123456789');
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('0123456789');
  });

  test('PATCH : remplacer puis supprimer la clé', async () => {
    const { patch, get, db } = await setup();
    const p = await seedProvider(db, { apiKey: KEY });
    const replaced = await patch(`/api/providers/${p.id}`, { apiKey: 'sk-autre-9876543210wxyz' });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().provider).toMatchObject({ keyState: 'stored', keyLast4: 'wxyz' });
    const removed = await patch(`/api/providers/${p.id}`, { apiKey: null });
    expect(removed.json().provider).toMatchObject({ keyState: 'missing', keyLast4: null, usable: false });
    const one = (await get('/api/providers')).json().providers.find((x: any) => x.id === p.id);
    expect(one.keyState).toBe('missing');
    const audits = JSON.stringify(await db.select().from(auditLog));
    expect(audits).toContain('"keyChanged":"replaced"');
    expect(audits).toContain('"keyChanged":"removed"');
    expect(audits).not.toContain('9876543210');
  });

  test('clé invalide (vide, espaces, retour à la ligne) → 400 validation', async () => {
    const { post } = await setup();
    for (const apiKey of ['', '   ', 'sk-avec espace-123', 'sk-ligne\n-1234567']) {
      const res = await post('/api/providers', { name: 'X', type: 'google', baseUrl: 'https://x.test', apiKey });
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe('validation');
    }
  });

  test('nom déjà pris → 409 provider_name_taken', async () => {
    const { post, db } = await setup();
    await seedProvider(db, { name: 'Doublon' });
    const res = await post('/api/providers', { name: 'Doublon', type: 'google', baseUrl: 'https://x.test' });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('provider_name_taken');
  });

  test('baseUrl http:// refusée sauf localhost', async () => {
    const { post } = await setup();
    const body = (baseUrl: string, name: string) => ({ name, type: 'openai_compatible', baseUrl });
    expect((await post('/api/providers', body('http://evil.test/v1', 'A'))).statusCode).toBe(400);
    expect((await post('/api/providers', body('ftp://x.test', 'B'))).statusCode).toBe(400);
    expect((await post('/api/providers', body('http://localhost:11434/v1', 'C'))).statusCode).toBe(201);
    expect((await post('/api/providers', body('http://127.0.0.1:11434/v1', 'D'))).statusCode).toBe(201);
  });

  test('maxConcurrency de 1 à 10', async () => {
    const { post } = await setup();
    const body = (maxConcurrency: number) => ({ name: `C${maxConcurrency}`, type: 'google', baseUrl: 'https://x.test', maxConcurrency });
    expect((await post('/api/providers', body(0))).statusCode).toBe(400);
    expect((await post('/api/providers', body(11))).statusCode).toBe(400);
    expect((await post('/api/providers', body(10))).statusCode).toBe(201);
  });

  test('clé chiffrée avec une autre APP_ENCRYPTION_KEY → unreadable ; test et remote-models le disent sans appel réseau', async () => {
    const f = fakeFetch({});
    const { post, get, db } = await setup({ fetch: f });
    const p = await seedProvider(db, { apiKey: KEY, encryptionKey: Buffer.alloc(32, 9) });
    expect((await get('/api/providers')).json().providers.find((x: any) => x.id === p.id).keyState).toBe('unreadable');
    expect((await post(`/api/providers/${p.id}/test`)).json()).toMatchObject({ ok: false, code: 'key_unreadable' });
    const remote = await get(`/api/providers/${p.id}/remote-models`);
    expect(remote.statusCode).toBe(409);
    expect(code(remote)).toBe('key_unreadable');
    expect(f.calls).toHaveLength(0);
  });

  test('Tester la connexion : succès, puis 401 du fournisseur → ok false auth_invalid, sans la clé', async () => {
    const f = fakeFetch({ [`GET ${BASE}/models`]: [modelsList(['m-a', 'm-b']), () => new Response('{}', { status: 401 })] });
    const { post, db } = await setup({ fetch: f });
    const p = await seedProvider(db, { apiKey: KEY });
    const ok = await post(`/api/providers/${p.id}/test`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, modelCount: 2 });
    expect(typeof ok.json().latencyMs).toBe('number');
    const ko = await post(`/api/providers/${p.id}/test`);
    expect(ko.statusCode).toBe(200);
    expect(ko.json()).toMatchObject({ ok: false, code: 'auth_invalid', message: 'Clé invalide ou sans droit sur ce modèle' });
    expect(ko.body).not.toContain(KEY);
  });

  test('Tester la connexion sans clé → ok false key_missing', async () => {
    const { post, db } = await setup({ fetch: fakeFetch({}) });
    const p = await seedProvider(db);
    expect((await post(`/api/providers/${p.id}/test`)).json()).toMatchObject({ ok: false, code: 'key_missing' });
  });

  test('mode faux : tous les fournisseurs utilisables, test réussi sans clé', async () => {
    const { post, get, db } = await setup({ fakeLlm: true });
    const p = await seedProvider(db);
    const listed = (await get('/api/providers')).json().providers.find((x: any) => x.id === p.id);
    expect(listed).toMatchObject({ usable: true, fake: true });
    expect((await post(`/api/providers/${p.id}/test`)).json()).toMatchObject({ ok: true, modelCount: 5 });
  });

  test('remote-models : liste du fournisseur, modèles déjà ajoutés marqués, triés', async () => {
    const f = fakeFetch({ [`GET ${BASE}/models`]: modelsList(['mistral-small', 'mistral-large']) });
    const { get, db } = await setup({ fetch: f });
    const p = await seedProvider(db, { apiKey: KEY });
    await seedModel(db, { providerId: p.id, apiModelId: 'mistral-large' });
    const res = await get(`/api/providers/${p.id}/remote-models`);
    expect(res.statusCode).toBe(200);
    expect(res.json().models.map((m: any) => m.id)).toEqual(['mistral-large', 'mistral-small']);
    expect(res.json().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mistral-large', alreadyAdded: true }),
        expect.objectContaining({ id: 'mistral-small', alreadyAdded: false }),
      ]),
    );
  });

  test('remote-models : prix connus complétés quand le fournisseur n’en donne pas', async () => {
    const f = fakeFetch({ [`GET ${BASE}/models`]: modelsList(['claude-sonnet-5-5']) });
    const { get, db } = await setup({ fetch: f });
    const p = await seedProvider(db, { apiKey: KEY });
    const res = await get(`/api/providers/${p.id}/remote-models`);
    expect(res.json().models[0]).toMatchObject({ id: 'claude-sonnet-5-5', inputPricePerM: 2, outputPricePerM: 10 });
  });

  test('remote-models sans clé → 409 key_missing ; 401 du fournisseur → 502 provider_error / auth_invalid', async () => {
    const f = fakeFetch({ [`GET ${BASE}/models`]: () => new Response('{}', { status: 401 }) });
    const { get, db } = await setup({ fetch: f });
    const sans = await seedProvider(db);
    const r1 = await get(`/api/providers/${sans.id}/remote-models`);
    expect(r1.statusCode).toBe(409);
    expect(code(r1)).toBe('key_missing');
    const avec = await seedProvider(db, { apiKey: KEY });
    const r2 = await get(`/api/providers/${avec.id}/remote-models`);
    expect(r2.statusCode).toBe(502);
    expect(r2.json().error).toMatchObject({ code: 'provider_error', providerCode: 'auth_invalid' });
    expect(r2.body).not.toContain(KEY);
  });

  test('remote-models : fournisseur muet → réponse en moins de 16 s, code timeout', async () => {
    // fetch qui ne répond jamais mais rejette quand son signal est annulé
    const silent = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const { get, db } = await setup({ fetch: silent });
    const p = await seedProvider(db, { apiKey: KEY });
    const started = Date.now();
    const res = await get(`/api/providers/${p.id}/remote-models`);
    expect(Date.now() - started).toBeLessThan(16_000);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'provider_error', providerCode: 'timeout' });
  }, 20_000);

  test('PATCH inconnu → 404 ; corps vide → 400', async () => {
    const { patch, db } = await setup();
    expect((await patch('/api/providers/00000000-0000-4000-8000-000000000000', { enabled: false })).statusCode).toBe(404);
    const p = await seedProvider(db);
    expect((await patch(`/api/providers/${p.id}`, {})).statusCode).toBe(400);
  });
});

describe('modèles', () => {
  test('créer un modèle (couleur par défaut dans la palette), doublon → 409 model_exists', async () => {
    const { post, db } = await setup();
    const p = await seedProvider(db, { apiKey: KEY });
    const body = { providerId: p.id, apiModelId: 'mistral-large', displayName: 'Mistral Large', inputPricePerM: 2, outputPricePerM: 6 };
    const res = await post('/api/models', body);
    expect(res.statusCode).toBe(201);
    expect(res.json().model).toMatchObject({
      providerName: p.name,
      apiModelId: 'mistral-large',
      inputPricePerM: 2,
      outputPricePerM: 6,
      priceSource: 'manual',
      available: true,
    });
    expect(res.json().model.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    const again = await post('/api/models', body);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('model_exists');
  });

  test('couleur invalide refusée ; fournisseur inconnu → 404', async () => {
    const { post, db } = await setup();
    const p = await seedProvider(db);
    const base = { providerId: p.id, apiModelId: 'm', displayName: 'M' };
    expect((await post('/api/models', { ...base, color: 'rouge' })).statusCode).toBe(400);
    expect((await post('/api/models', { ...base, color: '#12abEF' })).statusCode).toBe(201);
    const unknown = await post('/api/models', { ...base, providerId: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.statusCode).toBe(404);
  });

  test('prix : 4 décimales au plus, négatif et trop grand refusés', async () => {
    const { post, db } = await setup();
    const p = await seedProvider(db);
    const body = (extra: object) => ({ providerId: p.id, apiModelId: `m${Math.random()}`, displayName: 'M', ...extra });
    expect((await post('/api/models', body({ inputPricePerM: 0.12345 }))).statusCode).toBe(400);
    expect((await post('/api/models', body({ outputPricePerM: -1 }))).statusCode).toBe(400);
    expect((await post('/api/models', body({ outputPricePerM: 100_001 }))).statusCode).toBe(400);
    const ok = await post('/api/models', body({ inputPricePerM: 0.1234, contextWindow: null }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().model.inputPricePerM).toBe(0.1234);
  });

  test('PATCH modèle : modifie les champs, contextWindow entier positif ou null', async () => {
    const { patch, db } = await setup();
    const p = await seedProvider(db);
    const m = await seedModel(db, { providerId: p.id });
    const res = await patch(`/api/models/${m.id}`, { displayName: 'Nouveau nom', contextWindow: 32000, enabled: false });
    expect(res.json().model).toMatchObject({ displayName: 'Nouveau nom', contextWindow: 32000, enabled: false, available: false });
    expect((await patch(`/api/models/${m.id}`, { contextWindow: 0 })).statusCode).toBe(400);
    expect((await patch(`/api/models/${m.id}`, { contextWindow: null })).json().model.contextWindow).toBeNull();
    expect((await patch(`/api/models/${m.id}`, { apiModelId: 'autre' })).statusCode).toBe(400); // champ non modifiable
  });

  test('available : faux si clé absente ou illisible, fournisseur ou modèle désactivé', async () => {
    const { get, db } = await setup();
    const ok = await seedProvider(db, { apiKey: KEY });
    const sans = await seedProvider(db);
    const illisible = await seedProvider(db, { apiKey: KEY, encryptionKey: Buffer.alloc(32, 9) });
    const off = await seedProvider(db, { apiKey: KEY, enabled: false });
    const mOk = await seedModel(db, { providerId: ok.id });
    const mOff = await seedModel(db, { providerId: ok.id, enabled: false });
    const mSans = await seedModel(db, { providerId: sans.id });
    const mIll = await seedModel(db, { providerId: illisible.id });
    const mProvOff = await seedModel(db, { providerId: off.id });
    const list = (await get('/api/models')).json().models as { id: string; available: boolean }[];
    const avail = (id: string) => list.find((m) => m.id === id)!.available;
    expect(avail(mOk.id)).toBe(true);
    expect([mOff, mSans, mIll, mProvOff].map((m) => avail(m.id))).toEqual([false, false, false, false]);
  });

  test('GET /api/models/:id renvoie le fournisseur ; 404 pour un Utilisateur si désactivé', async () => {
    const { get, db, user } = await setup();
    const p = await seedProvider(db, { apiKey: KEY });
    const on = await seedModel(db, { providerId: p.id });
    const off = await seedModel(db, { providerId: p.id, enabled: false });
    const res = await get(`/api/models/${on.id}`, user);
    expect(res.json().model.provider).toMatchObject({ id: p.id, keyLast4: null });
    expect((await get(`/api/models/${off.id}`, user)).statusCode).toBe(404);
    expect((await get(`/api/models/${off.id}`)).statusCode).toBe(200);
  });

  test('Utilisateur : modèles désactivés invisibles ; 403 sur les écritures et les appels fournisseur', async () => {
    const { get, post, patch, db, user } = await setup({ fetch: fakeFetch({}) });
    const p = await seedProvider(db, { apiKey: KEY });
    const on = await seedModel(db, { providerId: p.id });
    const off = await seedModel(db, { providerId: p.id, enabled: false });
    const ids = (await get('/api/models', user)).json().models.map((m: any) => m.id);
    expect(ids).toContain(on.id);
    expect(ids).not.toContain(off.id);
    const forbidden = [
      await post('/api/providers', { name: 'Z', type: 'google', baseUrl: 'https://x.test' }, user),
      await patch(`/api/providers/${p.id}`, { enabled: false }, user),
      await post(`/api/providers/${p.id}/test`, {}, user),
      await get(`/api/providers/${p.id}/remote-models`, user),
      await post('/api/models', { providerId: p.id, apiModelId: 'x', displayName: 'X' }, user),
      await patch(`/api/models/${on.id}`, { enabled: false }, user),
    ];
    expect(forbidden.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  test('anonyme : 401', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/providers' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);
  });
});

describe('audit', () => {
  test('chaque modification est auditée, sans valeur de clé', async () => {
    const { post, patch, db } = await setup();
    const created = await post('/api/providers', {
      name: 'Audité',
      type: 'openai_compatible',
      baseUrl: 'https://x.test/v1',
      apiKey: 'sk-secret-0123456789zzzz',
    });
    const id = created.json().provider.id as string;
    await patch(`/api/providers/${id}`, { name: 'Audité 2', maxConcurrency: 3 });
    const m = await post('/api/models', { providerId: id, apiModelId: 'm', displayName: 'M' });
    await patch(`/api/models/${m.json().model.id}`, { enabled: false });
    const rows = await db.select().from(auditLog);
    expect(rows.map((r) => r.action).sort()).toEqual(['model_created', 'model_updated', 'provider_created', 'provider_updated']);
    const updated = rows.find((r) => r.action === 'provider_updated')!;
    expect(updated.details).toMatchObject({ fields: ['maxConcurrency', 'name'], keyChanged: null });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('secret-0123456789');
    expect(dump).not.toContain('apiKey');
  });
});
