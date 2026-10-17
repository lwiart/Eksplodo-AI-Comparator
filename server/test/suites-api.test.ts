import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { runTests, runs } from '../src/db/schema/runs.js';
import { suiteTests, testAttachments } from '../src/db/schema/tests.js';
import { buildTestApp, loginAs, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

async function setup() {
  const t = await buildTestApp();
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const api = {
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown = {}, s = admin) => call('POST', url, s, payload),
    put: (url: string, payload: unknown, s = admin) => call('PUT', url, s, payload),
    del: (url: string, s = admin) => call('DELETE', url, s),
  };
  /** Crée un test via l'API et renvoie son identifiant. */
  const makeTest = async (name: string): Promise<string> => {
    const res = await api.post('/api/tests', {
      name,
      category: 'Culture',
      userPrompt: `Question ${name}`,
      scoringMethod: 'manual',
      scoringConfig: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().test.id as string;
  };
  return { ...t, adminRow, admin, user, ...api, makeTest };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

test('créer une suite ordonnée puis réordonner', async () => {
  const t = await setup();
  const [a, b, c] = [await t.makeTest('A'), await t.makeTest('B'), await t.makeTest('C')];
  const res = await t.post('/api/suites', { name: 'Ma suite', description: 'Essai', testIds: [b, a, c] });
  expect(res.statusCode).toBe(201);
  const suite = res.json().suite;
  expect(suite).toMatchObject({ name: 'Ma suite', description: 'Essai' });
  expect(suite.tests.map((x: { id: string }) => x.id)).toEqual([b, a, c]);
  expect(suite.tests[0]).toEqual({
    id: b,
    name: 'B',
    category: 'Culture',
    scoringMethod: 'manual',
    archived: false,
    attachmentCount: 0,
  });
  const rows = await t.db.select().from(suiteTests).where(eq(suiteTests.suiteId, suite.id)).orderBy(asc(suiteTests.position));
  expect(rows.map((r) => [r.testId, r.position])).toEqual([[b, 0], [a, 1], [c, 2]]);

  // Réordonner et retirer un test : positions réécrites 0..n−1.
  const upd = await t.put(`/api/suites/${suite.id}`, { name: 'Ma suite 2', testIds: [c, b] });
  expect(upd.statusCode).toBe(200);
  expect(upd.json().suite).toMatchObject({ name: 'Ma suite 2', description: null });
  expect(upd.json().suite.tests.map((x: { id: string }) => x.id)).toEqual([c, b]);
  const rows2 = await t.db.select().from(suiteTests).where(eq(suiteTests.suiteId, suite.id)).orderBy(asc(suiteTests.position));
  expect(rows2.map((r) => [r.testId, r.position])).toEqual([[c, 0], [b, 1]]);

  const list = await t.get('/api/suites');
  expect(list.json().suites).toHaveLength(1);
  expect((await t.get(`/api/suites/${suite.id}`)).json().suite.id).toBe(suite.id);
  expect((await t.get(`/api/suites/${randomUUID()}`)).statusCode).toBe(404);
});

test('dupliquer : « Suite (copie) » puis « Suite (copie 2) »', async () => {
  const t = await setup();
  const [a, b] = [await t.makeTest('A'), await t.makeTest('B')];
  const suite = (await t.post('/api/suites', { name: 'Suite', testIds: [b, a] })).json().suite;
  const first = await t.post(`/api/suites/${suite.id}/duplicate`);
  expect(first.statusCode).toBe(201);
  expect(first.json().suite.name).toBe('Suite (copie)');
  expect(first.json().suite.id).not.toBe(suite.id);
  expect(first.json().suite.tests.map((x: { id: string }) => x.id)).toEqual([b, a]);
  const second = await t.post(`/api/suites/${suite.id}/duplicate`);
  expect(second.json().suite.name).toBe('Suite (copie 2)');
  const third = await t.post(`/api/suites/${suite.id}/duplicate`);
  expect(third.json().suite.name).toBe('Suite (copie 3)');
  expect((await t.post(`/api/suites/${randomUUID()}/duplicate`)).statusCode).toBe(404);
});

test('test archivé : reste dans la suite, marqué archived ; pièces jointes comptées sans les retirées', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const suite = (await t.post('/api/suites', { name: 'Suite', testIds: [a] })).json().suite;
  // Test utilisé par une série : la suppression l'archive.
  const runId = randomUUID();
  await t.db.insert(runs).values({
    id: runId,
    name: 'Série',
    repetitions: 1,
    concurrency: 4,
    status: 'completed',
    weights: { quality: 50, speed: 20, cost: 20, reliability: 10 },
    createdBy: t.adminRow.id,
  });
  await t.db.insert(runTests).values({ id: randomUUID(), runId, testId: a, position: 0, snapshot: {} });
  await t.db.insert(testAttachments).values([
    { id: randomUUID(), testId: a, originalName: 'x.png', mime: 'image/png', size: 1, storagePath: 'p1', sha256: 'a'.repeat(64) },
    { id: randomUUID(), testId: a, originalName: 'y.png', mime: 'image/png', size: 1, storagePath: 'p2', sha256: 'b'.repeat(64) },
    { id: randomUUID(), testId: a, originalName: 'z.png', mime: 'image/png', size: 1, storagePath: 'p3', sha256: 'c'.repeat(64), deletedAt: new Date() },
  ]);
  expect((await t.del(`/api/tests/${a}`)).json().outcome).toBe('archived');
  const read = (await t.get(`/api/suites/${suite.id}`)).json().suite;
  expect(read.tests).toHaveLength(1);
  expect(read.tests[0]).toMatchObject({ id: a, archived: true, attachmentCount: 2 });
});

test('nom déjà pris → 409 ; test inconnu → 400 ; doublon → 400', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const s1 = (await t.post('/api/suites', { name: 'Une', testIds: [a] })).json().suite;
  const s2 = (await t.post('/api/suites', { name: 'Deux', testIds: [] })).json().suite;
  const dup = await t.post('/api/suites', { name: 'Une', testIds: [] });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().error.code).toBe('suite_name_taken');
  const renamed = await t.put(`/api/suites/${s2.id}`, { name: 'Une', testIds: [] });
  expect(renamed.statusCode).toBe(409);
  expect(renamed.json().error.code).toBe('suite_name_taken');

  const unknown = await t.post('/api/suites', { name: 'Trois', testIds: [a, randomUUID()] });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json().error.code).toBe('test_not_found');
  const unknownPut = await t.put(`/api/suites/${s1.id}`, { name: 'Une', testIds: [randomUUID()] });
  expect(unknownPut.statusCode).toBe(400);
  expect(unknownPut.json().error.code).toBe('test_not_found');
  // L'échec d'un PUT laisse la suite intacte.
  expect((await t.get(`/api/suites/${s1.id}`)).json().suite.tests.map((x: { id: string }) => x.id)).toEqual([a]);

  const twice = await t.post('/api/suites', { name: 'Quatre', testIds: [a, a] });
  expect(twice.statusCode).toBe(400);
  expect(twice.json().error.code).toBe('validation');
  expect((await t.post('/api/suites', { name: 'Cinq', testIds: [], extra: 1 })).statusCode).toBe(400);
  expect((await t.post('/api/suites', { name: '', testIds: [] })).statusCode).toBe(400);
});

test('supprimer une suite : les tests restent, audit journalisé', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const suite = (await t.post('/api/suites', { name: 'Suite', testIds: [a] })).json().suite;
  await t.post(`/api/suites/${suite.id}/duplicate`);
  await t.put(`/api/suites/${suite.id}`, { name: 'Suite', description: 'd', testIds: [a] });
  const del = await t.del(`/api/suites/${suite.id}`);
  expect(del.statusCode).toBe(200);
  expect((await t.get(`/api/suites/${suite.id}`)).statusCode).toBe(404);
  expect((await t.get(`/api/tests/${a}`)).statusCode).toBe(200);
  expect((await t.del(`/api/suites/${suite.id}`)).statusCode).toBe(404);
  const actions = (await t.db.select().from(auditLog)).map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['suite_created', 'suite_updated', 'suite_duplicated', 'suite_deleted']));
});

test('Utilisateur : 403', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const suite = (await t.post('/api/suites', { name: 'Suite', testIds: [a] })).json().suite;
  const id = suite.id as string;
  const body = { name: 'X', testIds: [] };
  expect((await t.get('/api/suites', t.user)).statusCode).toBe(403);
  expect((await t.get(`/api/suites/${id}`, t.user)).statusCode).toBe(403);
  expect((await t.post('/api/suites', body, t.user)).statusCode).toBe(403);
  expect((await t.put(`/api/suites/${id}`, body, t.user)).statusCode).toBe(403);
  expect((await t.post(`/api/suites/${id}/duplicate`, {}, t.user)).statusCode).toBe(403);
  expect((await t.del(`/api/suites/${id}`, t.user)).statusCode).toBe(403);
});
