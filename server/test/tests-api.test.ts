import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { runTests, runs } from '../src/db/schema/runs.js';
import { suiteTests, suites, testAttachments, tests } from '../src/db/schema/tests.js';
import { buildTestApp, loginAs, seedUser, testConfig, type TestApp } from './helpers/test-app.js';

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
  return {
    ...t,
    adminRow,
    admin,
    user,
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown = {}, s = admin) => call('POST', url, s, payload),
    put: (url: string, payload: unknown, s = admin) => call('PUT', url, s, payload),
    del: (url: string, s = admin) => call('DELETE', url, s),
  };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

const base = {
  name: 'Capitale de la France',
  category: 'Culture',
  tags: ['géo'],
  userPrompt: 'Quelle est la capitale de la France ?',
  scoringMethod: 'expected',
  scoringConfig: { mode: 'exact', expected: 'Paris' },
};

/** Insère une série minimale dont `run_tests` référence le test. */
async function useInRun(t: Awaited<ReturnType<typeof setup>>, testId: string) {
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
  await t.db.insert(runTests).values({ id: randomUUID(), runId, testId, position: 0, snapshot: {} });
}

test('créer, lire, modifier un test ; valeurs par défaut 0,2 et 1 000', async () => {
  const t = await setup();
  const res = await t.post('/api/tests', base);
  expect(res.statusCode).toBe(201);
  const created_ = res.json().test;
  expect(created_).toMatchObject({
    ...base,
    systemPrompt: null,
    temperature: 0.2,
    maxTokens: 1000,
    scoringConfig: { mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false },
    archivedAt: null,
    attachments: [],
    usedInRuns: 0,
  });
  const read = await t.get(`/api/tests/${created_.id}`);
  expect(read.json().test.id).toBe(created_.id);
  const upd = await t.put(`/api/tests/${created_.id}`, {
    ...base,
    name: 'Capitale',
    systemPrompt: 'Réponds en un mot.',
    temperature: 0.5,
    maxTokens: 50,
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  expect(upd.statusCode).toBe(200);
  expect(upd.json().test).toMatchObject({ name: 'Capitale', systemPrompt: 'Réponds en un mot.', temperature: 0.5, maxTokens: 50, scoringConfig: {} });
  const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(['test_created', 'test_updated']));
});

test('max tokens 50 001 et température 2,1 refusés ; regex invalide refusée', async () => {
  const t = await setup();
  for (const bad of [{ maxTokens: 50_001 }, { temperature: 2.1 }, { scoringConfig: { mode: 'regex', pattern: '(', flags: '' } }]) {
    const res = await t.post('/api/tests', { ...base, ...bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  }
  const ok = await t.post('/api/tests', { ...base, maxTokens: 50_000, temperature: 2 });
  expect(ok.statusCode).toBe(201);
});

test('supprimer un test jamais utilisé → deleted ; utilisé par une série → archived, toujours lisible', async () => {
  const t = await setup();
  const a = (await t.post('/api/tests', base)).json().test;
  const b = (await t.post('/api/tests', { ...base, name: 'B' })).json().test;
  const suiteId = randomUUID();
  await t.db.insert(suites).values({ id: suiteId, name: 'Suite' });
  await t.db.insert(suiteTests).values({ suiteId, testId: a.id, position: 0 });
  await t.db.insert(testAttachments).values({
    id: randomUUID(),
    testId: a.id,
    originalName: 'x.png',
    mime: 'image/png',
    size: 1,
    storagePath: `attachments/${a.id}/inexistant`,
    sha256: 'a'.repeat(64),
  });
  const del = await t.del(`/api/tests/${a.id}`);
  expect(del.json()).toEqual({ outcome: 'deleted' });
  expect(await t.db.select().from(tests).where(eq(tests.id, a.id))).toHaveLength(0);
  expect(await t.db.select().from(suiteTests)).toHaveLength(0);
  expect((await t.get(`/api/tests/${a.id}`)).statusCode).toBe(404);

  await useInRun(t, b.id);
  const arch = await t.del(`/api/tests/${b.id}`);
  expect(arch.json()).toEqual({ outcome: 'archived' });
  const read = await t.get(`/api/tests/${b.id}`);
  expect(read.statusCode).toBe(200);
  expect(read.json().test).toMatchObject({ usedInRuns: 1 });
  expect(read.json().test.archivedAt).not.toBeNull();
  const restored = await t.post(`/api/tests/${b.id}/restore`);
  expect(restored.json().test.archivedAt).toBeNull();
  const actions = (await t.db.select().from(auditLog)).map((x) => x.action);
  expect(actions).toEqual(expect.arrayContaining(['test_deleted', 'test_archived', 'test_restored']));
});

test('liste : archivés exclus par défaut, filtres catégorie, tag et recherche', async () => {
  const t = await setup();
  await t.post('/api/tests', base);
  await t.post('/api/tests', { ...base, name: 'Intégrale', category: 'Maths', tags: ['calcul', 'lycée'], userPrompt: 'Calcule 2+2' });
  const old = (await t.post('/api/tests', { ...base, name: 'Ancien', category: 'Culture' })).json().test;
  await useInRun(t, old.id);
  await t.del(`/api/tests/${old.id}`);
  const names = async (qs: string) => (await t.get(`/api/tests${qs}`)).json().tests.map((x: { name: string }) => x.name).sort();
  expect(await names('')).toEqual(['Capitale de la France', 'Intégrale']);
  expect(await names('?archived=true')).toEqual(['Ancien']);
  expect(await names('?category=Maths')).toEqual(['Intégrale']);
  expect(await names('?tag=lycée')).toEqual(['Intégrale']);
  expect(await names('?q=2%2B2')).toEqual(['Intégrale']);
  expect(await names('?q=capitale')).toEqual(['Capitale de la France']);
  const meta = (await t.get('/api/tests/meta')).json();
  expect(meta.categories).toEqual(['Culture', 'Maths']);
  expect(meta.tags).toEqual(['calcul', 'géo', 'lycée']);
});

test('un Utilisateur reçoit 403 sur toutes les routes /api/tests', async () => {
  const t = await setup();
  const id = randomUUID();
  const u = t.user;
  const results = await Promise.all([
    t.get('/api/tests', u),
    t.get('/api/tests/meta', u),
    t.get(`/api/tests/${id}`, u),
    t.post('/api/tests', base, u),
    t.put(`/api/tests/${id}`, base, u),
    t.del(`/api/tests/${id}`, u),
    t.post(`/api/tests/${id}/restore`, {}, u),
  ]);
  expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403, 403, 403]);
});

test('supprimer un test efface ses fichiers sous dataDir, jamais un fichier hors de la racine', async () => {
  const t = await setup();
  const root = path.resolve(testConfig().dataDir);
  const id = (await t.post('/api/tests', base)).json().test.id as string;
  const rel = `attachments/${id}/${randomUUID()}`;
  await mkdir(path.join(root, 'attachments', id), { recursive: true });
  await writeFile(path.join(root, rel), 'contenu');
  const outsideName = `outside-${randomUUID()}.txt`;
  const outside = path.resolve(root, '..', outsideName);
  await writeFile(outside, 'à conserver');
  try {
    const row = { testId: id, originalName: 'x.png', mime: 'image/png' as const, size: 7, sha256: 'a'.repeat(64) };
    await t.db.insert(testAttachments).values([
      { ...row, id: randomUUID(), storagePath: rel },
      { ...row, id: randomUUID(), storagePath: `../${outsideName}`, deletedAt: new Date() },
    ]);
    expect((await t.del(`/api/tests/${id}`)).json()).toEqual({ outcome: 'deleted' });
    expect(existsSync(path.join(root, rel))).toBe(false);
    expect(existsSync(path.join(root, 'attachments', id))).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(await t.db.select().from(testAttachments).where(eq(testAttachments.testId, id))).toHaveLength(0);
  } finally {
    await rm(outside, { force: true });
    await rm(path.join(root, 'attachments', id), { recursive: true, force: true });
  }
});

test('modifier ou restaurer un test inconnu → 404', async () => {
  const t = await setup();
  const id = randomUUID();
  expect((await t.put(`/api/tests/${id}`, { ...base, scoringConfig: { mode: 'exact', expected: 'x' } })).statusCode).toBe(404);
  expect((await t.post(`/api/tests/${id}/restore`)).statusCode).toBe(404);
});
