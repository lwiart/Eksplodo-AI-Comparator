import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { models, openrouterCatalog, providers } from '../src/db/schema/catalog.js';
import { auditLog } from '../src/db/schema/core.js';
import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import {
  OPENROUTER_MODELS_URL,
  createCatalogRefreshHandler,
  refreshOpenRouterCatalog,
} from '../src/modules/catalog/openrouter-sync.js';
import { fakeFetch, fixtureText } from './helpers/fake-fetch.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, testConfig, testRegistry, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const day1 = new Date('2026-03-10T06:00:00Z');
const day2 = new Date('2026-03-11T06:00:00Z');
const route = (make: () => Response) => fakeFetch({ [`GET ${OPENROUTER_MODELS_URL}`]: make });
const served = (fixture: string) => route(() => new Response(fixtureText(fixture), { headers: { 'content-type': 'application/json' } }));
const status500 = route(() => new Response('boom', { status: 500 }));
const noData = route(() => Response.json({ error: 'x' }));
const emptyData = route(() => Response.json({ data: [] }));
const notJson = route(() => new Response('<html>', { status: 200 }));

const created: TestApp[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

async function setup() {
  const t = await buildTestApp({ now: day2 });
  created.push(t);
  let current = day2;
  const svc = createCatalogService({ db: t.db, registry: testRegistry(), clock: () => current, config: testConfig() });
  const admin = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  const actor = { userId: admin.id, role: 'admin' as const, email: admin.email, name: admin.name };
  const refresh = (at: Date, f: typeof fetch) => refreshOpenRouterCatalog({ db: t.db, fetch: f, now: at });
  const row = async (openrouterId: string) =>
    (await t.db.select().from(openrouterCatalog).where(eq(openrouterCatalog.openrouterId, openrouterId)))[0]!;
  const count = async () => (await t.db.select().from(openrouterCatalog)).length;
  return { ...t, svc, actor, refresh, row, count, setNow: (d: Date) => (current = d) };
}

describe('synchronisation du catalogue OpenRouter', () => {
  test('première synchronisation silencieuse', async () => {
    const { refresh, svc, count } = await setup();
    const r = await refresh(day1, served('openrouter/models.json'));
    expect(r).toMatchObject({ initial: true, added: 6, updated: 0 });
    expect(await count()).toBe(6);
    expect(await svc.newModels()).toEqual([]);
  });

  test('le lendemain, seuls les modèles apparus sont des nouveautés', async () => {
    const { refresh, svc } = await setup();
    await refresh(day1, served('openrouter/models.json'));
    const r = await refresh(day2, served('openrouter/models-day2.json'));
    expect(r).toMatchObject({ initial: false, added: 1, updated: 6 });
    const news = await svc.newModels();
    expect(news.map((m) => m.openrouterId)).toEqual(['newlab/model-x']);
    expect(news[0]).toMatchObject({
      name: 'NewLab: Model X',
      inputPricePerM: 1,
      outputPricePerM: 4,
      supportsVision: true,
      supportsPdf: false,
      contextWindow: 200000,
    });
  });

  test('nouveauté de plus de 30 jours, écartée, ou déjà dans le catalogue local : absente', async () => {
    const { refresh, svc, db, setNow, actor } = await setup();
    await refresh(day1, served('openrouter/models.json'));
    await refresh(day2, served('openrouter/models-day2.json'));
    setNow(new Date('2026-04-10T05:00:00Z')); // un peu moins de 30 jours après l'apparition
    expect((await svc.newModels()).map((m) => m.openrouterId)).toEqual(['newlab/model-x']);
    setNow(new Date('2026-04-11T07:00:00Z')); // plus de 30 jours
    expect(await svc.newModels()).toEqual([]);

    // Écartée
    setNow(day2);
    const n = (await svc.newModels())[0]!;
    await svc.dismissNew(actor, n.id);
    expect(await svc.newModels()).toEqual([]);

    // Déjà dans le catalogue local d'un fournisseur OpenRouter
    await db.update(openrouterCatalog).set({ dismissedAt: null });
    const p = await seedProvider(db, { baseUrl: 'https://openrouter.ai/api/v1' });
    expect(await svc.newModels()).toHaveLength(1);
    await seedModel(db, { providerId: p.id, apiModelId: 'newlab/model-x' });
    expect(await svc.newModels()).toEqual([]);
    // Un modèle de même identifiant chez un autre fournisseur ne compte pas
    await db.delete(models).where(eq(models.providerId, p.id));
    const other = await seedProvider(db, { baseUrl: 'https://api.example.test/v1' });
    await seedModel(db, { providerId: other.id, apiModelId: 'newlab/model-x' });
    expect(await svc.newModels()).toHaveLength(1);
  });

  test('échec de la première synchronisation (500, JSON illisible, sans data, data vide) : rien écrit, la suivante reste silencieuse', async () => {
    const { refresh, count } = await setup();
    for (const f of [status500, notJson, noData, emptyData]) await expect(refresh(day1, f)).rejects.toThrow();
    expect(await count()).toBe(0);
    expect((await refresh(day2, served('openrouter/models.json'))).initial).toBe(true);
  });

  test('prix "-1" stocké null, jamais 0 ; gratuit stocké 0', async () => {
    const { refresh, row } = await setup();
    await refresh(day1, served('openrouter/models.json'));
    expect(await row('openrouter/auto')).toMatchObject({ inputPricePerM: null, outputPricePerM: null });
    expect(await row('meta-llama/llama-free:free')).toMatchObject({ inputPricePerM: 0, outputPricePerM: 0 });
    expect(await row('anthropic/claude-sonnet-5.5')).toMatchObject({ inputPricePerM: 2, outputPricePerM: 10, contextWindow: 1000000 });
  });

  test('les connues sont mises à jour (nom, prix, lastSeenAt) sans changer firstSeenAt', async () => {
    const { refresh, row, db } = await setup();
    await refresh(day1, served('openrouter/models.json'));
    await db.update(openrouterCatalog).set({ name: 'Ancien nom', inputPricePerM: 99 });
    await refresh(day2, served('openrouter/models.json'));
    const r = await row('anthropic/claude-sonnet-5.5');
    expect(r.name).toBe('Anthropic: Claude Sonnet 5.5');
    expect(r.inputPricePerM).toBe(2);
    expect(r.firstSeenAt).toEqual(day1);
    expect(r.lastSeenAt).toEqual(day2);
  });

  test('prix du catalogue local mis à jour pour priceSource openrouter seulement', async () => {
    const { refresh, db } = await setup();
    const orp = await seedProvider(db, { baseUrl: 'https://openrouter.ai/api/v1' });
    const other = await seedProvider(db, { baseUrl: 'https://api.example.test/v1' });
    const auto = await seedModel(db, { providerId: orp.id, apiModelId: 'anthropic/claude-sonnet-5.5', priceSource: 'openrouter', inputPricePerM: 1, outputPricePerM: 1 });
    const manual = await seedModel(db, { providerId: orp.id, apiModelId: 'mistralai/mistral-large', priceSource: 'manual', inputPricePerM: 7, outputPricePerM: 8 });
    const nullPrice = await seedModel(db, { providerId: orp.id, apiModelId: 'openrouter/auto', priceSource: 'openrouter', inputPricePerM: 5, outputPricePerM: 6 });
    const foreign = await seedModel(db, { providerId: other.id, apiModelId: 'anthropic/claude-sonnet-5.5', priceSource: 'openrouter', inputPricePerM: 1, outputPricePerM: 1 });
    await refresh(day1, served('openrouter/models.json'));
    const get = async (id: string) => (await db.select().from(models).where(eq(models.id, id)))[0]!;
    // La première synchronisation met déjà à jour les prix locaux.
    expect(await get(auto.id)).toMatchObject({ inputPricePerM: 2, outputPricePerM: 10 });
    expect(await get(manual.id)).toMatchObject({ inputPricePerM: 7, outputPricePerM: 8 });
    expect(await get(nullPrice.id)).toMatchObject({ inputPricePerM: 5, outputPricePerM: 6 });
    expect(await get(foreign.id)).toMatchObject({ inputPricePerM: 1, outputPricePerM: 1 });
    // Rien ne change au passage suivant
    expect((await refresh(day2, served('openrouter/models.json'))).localPricesUpdated).toBe(0);
  });

  test('localPricesUpdated compte les modèles locaux réellement modifiés', async () => {
    const { refresh, db } = await setup();
    const orp = await seedProvider(db, { baseUrl: 'https://openrouter.ai/api/v1' });
    await seedModel(db, { providerId: orp.id, apiModelId: 'anthropic/claude-sonnet-5.5', priceSource: 'openrouter', inputPricePerM: 1, outputPricePerM: 1 });
    expect((await refresh(day1, served('openrouter/models.json'))).localPricesUpdated).toBe(1);
  });

  test('le gestionnaire catalog_refresh utilise le fetch injecté et l’horloge de la tâche', async () => {
    const { db, count } = await setup();
    const handler = createCatalogRefreshHandler({ fetch: served('openrouter/models.json') });
    await handler({} as never, { db, now: () => day1, signal: new AbortController().signal, reportProgress: async () => {} });
    expect(await count()).toBe(6);
  });
});

describe('API des nouveautés', () => {
  async function api() {
    const s = await setup();
    await seedUser(s.db, { email: 'user@acme.fr', role: 'user' });
    const admin = await loginAs(s.app, 'admin@acme.fr', PW);
    const user = await loginAs(s.app, 'user@acme.fr', PW);
    const call = (method: 'GET' | 'POST', url: string, who: typeof admin) =>
      s.app.inject({ method, url, headers: { cookie: who.cookie, 'x-csrf-token': who.csrf } });
    return { ...s, admin, user, call };
  }

  test('403 pour un Utilisateur', async () => {
    const { call, user } = await api();
    expect((await call('GET', '/api/catalog/new', user)).statusCode).toBe(403);
    expect((await call('POST', '/api/catalog/00000000-0000-4000-8000-000000000000/dismiss', user)).statusCode).toBe(403);
  });

  test('liste, fournisseur OpenRouter actif, dismiss retire la nouveauté et audite', async () => {
    const { call, admin, refresh, db } = await api();
    await db.update(providers).set({ enabled: false });
    const orp = await seedProvider(db, { name: 'OpenRouter test', baseUrl: 'https://openrouter.ai/api/v1' });
    await refresh(day1, served('openrouter/models.json'));
    await refresh(day2, served('openrouter/models-day2.json'));
    const res = await call('GET', '/api/catalog/new', admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().models.map((m: { openrouterId: string }) => m.openrouterId)).toEqual(['newlab/model-x']);
    expect(res.json().openRouterProviderId).toBe(orp.id);
    const id = res.json().models[0].id;
    expect((await call('POST', `/api/catalog/${id}/dismiss`, admin)).statusCode).toBe(204);
    expect((await call('GET', '/api/catalog/new', admin)).json().models).toEqual([]);
    const log = await db.select().from(auditLog).where(eq(auditLog.action, 'catalog_dismissed'));
    expect(log).toHaveLength(1);
    expect(log[0]!.targetId).toBe(id);
    expect((await call('POST', '/api/catalog/00000000-0000-4000-8000-000000000000/dismiss', admin)).statusCode).toBe(404);
  });

  test('openRouterProviderId nul sans fournisseur OpenRouter actif', async () => {
    const { call, admin, db } = await api();
    await db.update(providers).set({ enabled: false });
    expect((await call('GET', '/api/catalog/new', admin)).json().openRouterProviderId).toBeNull();
  });
});
