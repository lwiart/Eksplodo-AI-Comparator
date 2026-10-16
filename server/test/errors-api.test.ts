import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { errorEvents } from '../src/db/schema/errors.js';
import { newReference } from '../src/modules/errors/reference.js';
import { buildTestApp, csrfHeaders, loginAs, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const created: TestApp[] = [];
const REF = /^E-[A-Z0-9]{5}$/;

async function setup(role: 'admin' | 'user' = 'admin', routes?: (app: TestApp['app']) => void) {
  const t = await buildTestApp({ now: NOW });
  created.push(t);
  routes?.(t.app);
  const admin = await seedUser(t.db, {
    email: 'a@x.fr', password: PW, role, name: 'Alice Admin',
  });
  const auth = await loginAs(t.app, 'a@x.fr', PW);
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const event = async (over: Partial<typeof errorEvents.$inferInsert> = {}) => {
    const row: typeof errorEvents.$inferInsert = {
      id: randomUUID(), reference: newReference(), severity: 'normale', source: 'job', origin: 'demo_job',
      code: 'internal', message: 'boum', fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      firstSeenAt: hoursAgo(1), lastSeenAt: hoursAgo(1), ...over,
    };
    await t.db.insert(errorEvents).values(row);
    return row;
  };
  return { ...t, admin, headers, get, post, event };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

describe('GET /api/admin/errors', () => {
  test('DTO complet, utilisateur résolu, cible, du plus récent au plus ancien', async () => {
    const t = await setup();
    const targetId = randomUUID();
    const old = await t.event({ lastSeenAt: hoursAgo(5) });
    const recent = await t.event({
      lastSeenAt: hoursAgo(2), firstSeenAt: hoursAgo(3), severity: 'grave', source: 'request', origin: 'POST /api/x', code: 'llm_key',
      httpStatus: 500, message: 'msg', stack: 'pile', userId: t.admin.id, targetType: 'analysis', targetId,
      occurrences: 4, notifiedAt: hoursAgo(2),
    });
    const res = await t.get('/api/admin/errors');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(body.items.map((i: { reference: string }) => i.reference)).toEqual([recent.reference, old.reference]);
    expect(body.items[0]).toEqual({
      id: recent.id, reference: recent.reference, severity: 'grave', source: 'request', origin: 'POST /api/x', code: 'llm_key',
      httpStatus: 500, message: 'msg', stack: 'pile',
      userId: t.admin.id, userName: 'Alice Admin', target: { type: 'analysis', id: targetId }, occurrences: 4,
      firstSeenAt: hoursAgo(3).toISOString(), lastSeenAt: hoursAgo(2).toISOString(), resolvedAt: null,
      notifiedAt: hoursAgo(2).toISOString(),
    });
    expect(body.items[1]).toMatchObject({ userName: null, target: null, httpStatus: null });
  });

  test('filtres : gravité, origine', async () => {
    const t = await setup();
    const a = await t.event({ severity: 'grave', origin: 'o1' });
    const b = await t.event({ origin: 'o2' });
    const c = await t.event({ origin: 'o1' });
    const refs = async (qs: string) =>
      (await t.get(`/api/admin/errors?${qs}`)).json().items.map((i: { reference: string }) => i.reference).sort();
    expect(await refs('severity=grave')).toEqual([a.reference]);
    expect(await refs('severity=normale')).toEqual([b.reference, c.reference].sort());
    expect(await refs('origin=o1')).toEqual([a.reference, c.reference].sort());
    expect(await refs('severity=grave&origin=o2')).toEqual([]);
  });

  test('période : 7 jours par défaut, from et to explicites', async () => {
    const t = await setup();
    const in3d = await t.event({ lastSeenAt: hoursAgo(72) });
    const in10d = await t.event({ lastSeenAt: hoursAgo(240) });
    const in30d = await t.event({ lastSeenAt: hoursAgo(720) });
    const refs = async (qs: string) =>
      (await t.get(`/api/admin/errors?${qs}`)).json().items.map((i: { reference: string }) => i.reference);
    expect(await refs('')).toEqual([in3d.reference]);
    expect(await refs('from=2026-09-01T00:00:00.000Z')).toEqual([in3d.reference, in10d.reference, in30d.reference]);
    expect(await refs('from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z')).toEqual([in10d.reference, in30d.reference]);
    // Date seule : « to » couvre toute la journée (in10d : 6 oct. 12:00).
    expect(await refs('from=2026-10-06&to=2026-10-06')).toEqual([in10d.reference]);
    expect((await t.get('/api/admin/errors?from=pas-une-date')).statusCode).toBe(400);
    expect((await t.get('/api/admin/errors?severity=autre')).statusCode).toBe(400);
  });

  test('les traitées sont exclues par défaut, visibles avec includeResolved=1', async () => {
    const t = await setup();
    const open = await t.event();
    const done = await t.event({ resolvedAt: hoursAgo(1), resolvedBy: t.admin.id });
    const refs = async (qs: string) =>
      (await t.get(`/api/admin/errors?${qs}`)).json().items.map((i: { reference: string }) => i.reference).sort();
    expect(await refs('')).toEqual([open.reference]);
    expect(await refs('includeResolved=0')).toEqual([open.reference]);
    expect(await refs('includeResolved=1')).toEqual([open.reference, done.reference].sort());
    const item = (await t.get('/api/admin/errors?includeResolved=1')).json().items.find((i: { id: string }) => i.id === done.id);
    expect(item.resolvedAt).toBe(hoursAgo(1).toISOString());
  });

  test('pagination : 50 par page, total sur toute la sélection', async () => {
    const t = await setup();
    await t.db.insert(errorEvents).values(
      Array.from({ length: 55 }, (_, i) => ({
        id: randomUUID(), reference: newReference(), severity: 'normale' as const,
        source: 'job' as const, origin: 'o', code: 'c', message: 'm', fingerprint: String(i).padEnd(64, '0'),
        firstSeenAt: hoursAgo(1), lastSeenAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      })),
    );
    const p1 = (await t.get('/api/admin/errors')).json();
    expect(p1).toMatchObject({ total: 55, page: 1, pageSize: 50 });
    expect(p1.items).toHaveLength(50);
    const p2 = (await t.get('/api/admin/errors?page=2')).json();
    expect(p2.page).toBe(2);
    expect(p2.items).toHaveLength(5);
    expect(new Date(p2.items[0].lastSeenAt) < new Date(p1.items[49].lastSeenAt)).toBe(true);
    expect((await t.get('/api/admin/errors?page=0')).statusCode).toBe(400);
  });

  test('filtre source=request (Page / API) et source invalide : 400', async () => {
    const t = await setup();
    const a = await t.event({ source: 'request', origin: 'GET /api/x' });
    await t.event({ source: 'job' });
    const items = (await t.get('/api/admin/errors?source=request')).json().items as { reference: string }[];
    expect(items.map((i) => i.reference)).toEqual([a.reference]);
    expect((await t.get('/api/admin/errors?source=autre')).statusCode).toBe(400);
  });

  test('page au plus 10 000 ; from après to : 400 invalid_range', async () => {
    const t = await setup();
    expect((await t.get('/api/admin/errors?page=10000')).statusCode).toBe(200);
    expect((await t.get('/api/admin/errors?page=10001')).statusCode).toBe(400);
    const res = await t.get('/api/admin/errors?from=2026-10-10&to=2026-10-01');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_range');
    expect((await t.get('/api/admin/errors?from=2026-10-01&to=2026-10-01')).statusCode).toBe(200);
  });
});

describe('GET /api/admin/errors/summary', () => {
  test('compte à la main : 24 h, 7 jours, 3 premières origines, graves non traitées', async () => {
    const t = await setup();
    await t.event({ origin: 'A', severity: 'grave', lastSeenAt: hoursAgo(2) });
    await t.event({ origin: 'A', lastSeenAt: hoursAgo(10) });
    await t.event({ origin: 'A', lastSeenAt: hoursAgo(30) });
    await t.event({ origin: 'B', severity: 'grave', lastSeenAt: hoursAgo(40), resolvedAt: hoursAgo(1) });
    await t.event({ origin: 'B', lastSeenAt: hoursAgo(100) });
    await t.event({ origin: 'C', lastSeenAt: hoursAgo(120) });
    await t.event({ origin: 'D', lastSeenAt: hoursAgo(150) });
    await t.event({ origin: 'E', severity: 'grave', lastSeenAt: hoursAgo(167) });
    // Hors des 7 jours : compté seulement dans les graves non traitées.
    await t.event({ origin: 'Z', severity: 'grave', lastSeenAt: hoursAgo(300) });
    await t.event({ origin: 'Z', lastSeenAt: hoursAgo(300) });
    const res = await t.get('/api/admin/errors/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last24h).toEqual({ total: 2, grave: 1 });
    expect(body.last7d).toEqual({ total: 8, grave: 3 });
    expect(body.unresolvedGrave).toBe(3);
    expect(body.topOrigins).toHaveLength(3);
    expect(body.topOrigins[0]).toEqual({ origin: 'A', count: 3 });
    expect(body.topOrigins[1]).toEqual({ origin: 'B', count: 2 });
    expect(body.topOrigins[2].count).toBe(1);
  });

  test('journal vide', async () => {
    const t = await setup();
    expect((await t.get('/api/admin/errors/summary')).json()).toEqual({
      last24h: { total: 0, grave: 0 }, last7d: { total: 0, grave: 0 }, topOrigins: [], unresolvedGrave: 0,
    });
  });
});

describe('GET /api/admin/errors/by-reference/:reference', () => {
  test('insensible à la casse, E- facultatif', async () => {
    const t = await setup();
    const e = await t.event({ reference: 'E-7K2QX', lastSeenAt: hoursAgo(500) });
    for (const q of ['E-7K2QX', 'e-7k2qx', '7K2QX', '7k2qx']) {
      const res = await t.get(`/api/admin/errors/by-reference/${q}`);
      expect(res.statusCode, q).toBe(200);
      expect(res.json().item).toMatchObject({ id: e.id, reference: 'E-7K2QX' });
    }
  });

  test('inconnue ou format invalide : 404', async () => {
    const t = await setup();
    await t.event({ reference: 'E-7K2QX' });
    for (const q of ['E-ABCDE', 'E-7K2Q', 'E-7K2QXX', 'E-0O1IL', 'n-importe-quoi']) {
      expect((await t.get(`/api/admin/errors/by-reference/${q}`)).statusCode, q).toBe(404);
    }
  });
});

describe('POST /api/admin/errors/resolve', () => {
  test('marquer traité puis rouvrir', async () => {
    const t = await setup();
    const a = await t.event();
    const b = await t.event();
    const c = await t.event();
    const row = async (id: string) => (await t.db.select().from(errorEvents).where(eq(errorEvents.id, id)))[0]!;
    const res = await t.post('/api/admin/errors/resolve', { ids: [a.id, b.id, randomUUID()], resolved: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 2 });
    expect(await row(a.id)).toMatchObject({ resolvedBy: t.admin.id });
    expect((await row(a.id)).resolvedAt).toEqual(NOW);
    expect((await row(c.id)).resolvedAt).toBeNull();
    const reopen = await t.post('/api/admin/errors/resolve', { ids: [a.id], resolved: false });
    expect(reopen.json()).toEqual({ updated: 1 });
    expect(await row(a.id)).toMatchObject({ resolvedAt: null, resolvedBy: null });
    expect((await row(b.id)).resolvedAt).not.toBeNull();
  });

  test('validation : ids vide, trop nombreux, non UUID, resolved absent', async () => {
    const t = await setup();
    const url = '/api/admin/errors/resolve';
    expect((await t.post(url, { ids: [], resolved: true })).statusCode).toBe(400);
    expect((await t.post(url, { ids: Array.from({ length: 201 }, () => randomUUID()), resolved: true })).statusCode).toBe(400);
    expect((await t.post(url, { ids: ['x'], resolved: true })).statusCode).toBe(400);
    expect((await t.post(url, { ids: [randomUUID()] })).statusCode).toBe(400);
    expect((await t.post(url, { ids: Array.from({ length: 200 }, () => randomUUID()), resolved: true })).statusCode).toBe(200);
  });
});

describe('contrôle d accès', () => {
  test('un Utilisateur reçoit 403 sur /api/admin/errors', async () => {
    const m = await setup('user');
    expect((await m.get('/api/admin/errors')).statusCode).toBe(403);
  });

  test('Utilisateur : 403 sur chaque route', async () => {
    const m = await setup('user');
    expect((await m.get('/api/admin/errors')).statusCode).toBe(403);
    expect((await m.get('/api/admin/errors/summary')).statusCode).toBe(403);
    expect((await m.get('/api/admin/errors/by-reference/E-7K2QX')).statusCode).toBe(403);
    expect((await m.post('/api/admin/errors/resolve', { ids: [randomUUID()], resolved: true })).statusCode).toBe(403);
  });

  test('sans session : 401 ; POST sans jeton CSRF : 403', async () => {
    const t = await setup();
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/errors' })).statusCode).toBe(401);
    const url = '/api/admin/errors/resolve';
    const payload = { ids: [randomUUID()], resolved: true };
    expect((await t.app.inject({ method: 'POST', url, headers: await csrfHeaders(t.app), payload })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie: t.headers.cookie }, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });
});

describe('erreurs 500 des routes', () => {
  test('erreur 500 d’une route : référence E-XXXXX renvoyée et enregistrée', async () => {
    const t = await setup('admin', (app) =>
      app.get('/api/test-boom/:id', async () => {
        throw new Error('boum interne');
      }),
    );
    const res = await t.app.inject({ method: 'GET', url: '/api/test-boom/42', headers: t.headers });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.reference).toMatch(REF);
    const [row] = await t.db.select().from(errorEvents).where(eq(errorEvents.reference, res.json().error.reference));
    expect(row).toMatchObject({ source: 'request', origin: 'GET /api/test-boom/:id', severity: 'grave', userId: t.admin.id });
    expect(res.body).not.toContain('boum interne');
  });

  test('masquage : une clé sk-… et un paramètre key= n’atteignent jamais error_events', async () => {
    const t = await setup('admin', (app) =>
      app.get('/api/test-leak', async () => {
        throw new Error('échec avec sk-or-v1-abcdef0123456789 et https://x/models?key=AIzaSy123 ; Authorization: Bearer tok.en-1');
      }),
    );
    const res = await t.app.inject({ method: 'GET', url: '/api/test-leak', headers: t.headers });
    expect(res.statusCode).toBe(500);
    const [row] = await t.db.select().from(errorEvents).where(eq(errorEvents.reference, res.json().error.reference));
    for (const text of [row!.message, row!.stack ?? '']) {
      expect(text).not.toMatch(/sk-or-v1-abcdef|AIzaSy123|tok.en-1/);
    }
    expect(row!.message).toContain('[clé masquée]');
  });
});
