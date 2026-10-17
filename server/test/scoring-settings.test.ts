import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog, settings } from '../src/db/schema/core.js';
import { models } from '../src/db/schema/catalog.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

async function setup() {
  const t = await buildTestApp({ fakeLlm: true });
  created.push(t);
  await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'PUT', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const provider = await seedProvider(t.db, {});
  const model = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-juge', displayName: 'Juge' });
  return {
    ...t,
    admin,
    user,
    provider,
    model,
    get: (u: string, s = admin) => call('GET', u, s),
    put: (u: string, p: unknown, s = admin) => call('PUT', u, s, p),
  };
}

test('juge par défaut : lecture, écriture, retrait, audit', async () => {
  const s = await setup();
  let res = await s.get('/api/settings/scoring');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ defaultJudgeModelId: null });

  res = await s.put('/api/settings/scoring', { defaultJudgeModelId: s.model.id });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ defaultJudgeModelId: s.model.id });
  expect((await s.get('/api/settings/scoring')).json()).toEqual({ defaultJudgeModelId: s.model.id });
  const [row] = await s.db.select().from(settings).where(eq(settings.key, 'scoring.default_judge_model_id'));
  expect(row?.value).toBe(s.model.id);

  res = await s.put('/api/settings/scoring', { defaultJudgeModelId: null });
  expect(res.json()).toEqual({ defaultJudgeModelId: null });
  const actions = (await s.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);
  expect(actions.filter((a) => a === 'default_judge_changed')).toHaveLength(2);
});

test('juge par défaut : modèle inconnu ou désactivé → 400 ; Utilisateur → 403', async () => {
  const s = await setup();
  let res = await s.put('/api/settings/scoring', { defaultJudgeModelId: randomUUID() });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('model_not_found');

  await s.db.update(models).set({ enabled: false }).where(eq(models.id, s.model.id));
  res = await s.put('/api/settings/scoring', { defaultJudgeModelId: s.model.id });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('model_not_found');

  res = await s.put('/api/settings/scoring', { defaultJudgeModelId: s.model.id }, s.user);
  expect(res.statusCode).toBe(403);
  res = await s.get('/api/settings/scoring', s.user);
  expect(res.statusCode).toBe(403);
});
