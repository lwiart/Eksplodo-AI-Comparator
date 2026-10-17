import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { shareLinks } from '../src/db/schema/sharing.js';
import { hashShareToken } from '../src/modules/sharing/token.js';
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
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const provider = await seedProvider(t.db, {});
  const model = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-modele-0', displayName: 'Modèle A' });
  const outsider = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-modele-1', displayName: 'Modèle B' });
  const testRes = await call('POST', '/api/tests', admin, {
    name: 'T',
    category: 'Culture',
    userPrompt: 'Salut',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  const runRes = await call('POST', '/api/runs', admin, { name: 'Série', testIds: [testRes.json().test.id], modelIds: [model.id] });
  expect(runRes.statusCode).toBe(201);
  const runId = runRes.json().run.id as string;
  const body = (over: Record<string, unknown> = {}) => ({
    runId,
    title: 'Comparatif',
    intro: 'Introduction',
    verdicts: [{ label: 'Meilleur choix', modelId: model.id, text: 'Le plus régulier.' }],
    showCosts: false,
    showResponses: false,
    ...over,
  });
  return { ...t, admin, user, model, outsider, runId, body, call, create: (over: Record<string, unknown> = {}) => call('POST', '/api/share-links', admin, body(over)) };
}

test('Admin : création → jeton de 32 caractères base64url, seule l’empreinte SHA-256 est en base, audit share_link_created', async () => {
  const s = await setup();
  const res = await s.create();
  expect(res.statusCode).toBe(201);
  const { link, token } = res.json();
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(link).toMatchObject({ runId: s.runId, runName: 'Série', title: 'Comparatif', active: true, viewCount: 0, showCosts: false, showResponses: false });
  const [row] = await s.db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
  expect(row?.tokenHash).toBe(hashShareToken(token));
  expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  const list = await s.call('GET', `/api/share-links?runId=${s.runId}`, s.admin);
  expect(list.json().links).toHaveLength(1);
  const actions = (await s.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);
  expect(actions).toContain('share_link_created');
});

test('Utilisateur : 403 sur toutes les routes /api/share-links et /api/settings/sharing', async () => {
  const s = await setup();
  const id = randomUUID();
  const calls: [Parameters<typeof s.call>[0], string, unknown?][] = [
    ['GET', '/api/share-links'],
    ['POST', '/api/share-links', s.body()],
    ['PATCH', `/api/share-links/${id}`, { ...s.body(), runId: undefined, active: true }],
    ['POST', `/api/share-links/${id}/regenerate`],
    ['DELETE', `/api/share-links/${id}`],
    ['GET', '/api/settings/sharing'],
    ['PUT', '/api/settings/sharing', { auditUrl: 'https://exemple.fr' }],
  ];
  for (const [method, url, payload] of calls) {
    const res = await s.call(method, url, s.user, payload);
    expect(res.statusCode, `${method} ${url}`).toBe(403);
  }
});

test('verdict avec un modèle hors série → 400 verdict_model_not_in_run ; 7 verdicts → 400', async () => {
  const s = await setup();
  let res = await s.create({ verdicts: [{ label: 'X', modelId: s.outsider.id, text: '' }] });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('verdict_model_not_in_run');
  expect(res.json().error.message).toBe('Le modèle du verdict ne fait pas partie de la série');

  const seven = Array.from({ length: 7 }, (_, i) => ({ label: `V${i}`, modelId: null, text: '' }));
  res = await s.create({ verdicts: seven });
  expect(res.statusCode).toBe(400);
  res = await s.create({ verdicts: seven.slice(0, 6) });
  expect(res.statusCode).toBe(201);

  // La même vérification s'applique à la modification.
  const id = res.json().link.id as string;
  res = await s.call('PATCH', `/api/share-links/${id}`, s.admin, {
    title: 'T',
    verdicts: [{ label: 'X', modelId: s.outsider.id, text: '' }],
    showCosts: false,
    showResponses: false,
    active: true,
  });
  expect(res.json().error.code).toBe('verdict_model_not_in_run');
});

test('PATCH active=false puis true ; regenerate change l’empreinte et renvoie un nouveau jeton ; DELETE → 204 puis 404', async () => {
  const s = await setup();
  const created1 = (await s.create()).json();
  const id = created1.link.id as string;
  const patch = (active: boolean) =>
    s.call('PATCH', `/api/share-links/${id}`, s.admin, {
      title: ' Nouveau titre ',
      intro: null,
      verdicts: [],
      showCosts: true,
      showResponses: true,
      active,
    });
  let res = await patch(false);
  expect(res.statusCode).toBe(200);
  expect(res.json().link).toMatchObject({ active: false, title: 'Nouveau titre', intro: null, showCosts: true, showResponses: true });
  res = await patch(true);
  expect(res.json().link.active).toBe(true);

  const [before] = await s.db.select().from(shareLinks).where(eq(shareLinks.id, id));
  res = await s.call('POST', `/api/share-links/${id}/regenerate`, s.admin);
  expect(res.statusCode).toBe(200);
  const { token } = res.json();
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(token).not.toBe(created1.token);
  const [after] = await s.db.select().from(shareLinks).where(eq(shareLinks.id, id));
  expect(after?.tokenHash).not.toBe(before?.tokenHash);
  expect(after?.tokenHash).toBe(hashShareToken(token));

  res = await s.call('DELETE', `/api/share-links/${id}`, s.admin);
  expect(res.statusCode).toBe(204);
  res = await s.call('DELETE', `/api/share-links/${id}`, s.admin);
  expect(res.statusCode).toBe(404);
  res = await patch(true);
  expect(res.statusCode).toBe(404);

  const actions = (await s.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);
  for (const a of ['share_link_created', 'share_link_updated', 'share_link_regenerated', 'share_link_deleted']) {
    expect(actions).toContain(a);
  }
});

test('réglage audit : défaut https://eksplodo.fr ; http:// refusé ; enregistrement audité audit_url_changed', async () => {
  const s = await setup();
  let res = await s.call('GET', '/api/settings/sharing', s.admin);
  expect(res.json()).toEqual({ auditUrl: 'https://eksplodo.fr' });

  res = await s.call('PUT', '/api/settings/sharing', s.admin, { auditUrl: 'http://eksplodo.fr/audit' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('invalid_audit_url');
  res = await s.call('PUT', '/api/settings/sharing', s.admin, { auditUrl: `https://exemple.fr/${'a'.repeat(300)}` });
  expect(res.json().error.code).toBe('invalid_audit_url');
  res = await s.call('PUT', '/api/settings/sharing', s.admin, { auditUrl: 'pas une url' });
  expect(res.json().error.code).toBe('invalid_audit_url');

  res = await s.call('PUT', '/api/settings/sharing', s.admin, { auditUrl: 'https://eksplodo.fr/audit-gratuit' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ auditUrl: 'https://eksplodo.fr/audit-gratuit' });
  expect((await s.call('GET', '/api/settings/sharing', s.admin)).json()).toEqual({ auditUrl: 'https://eksplodo.fr/audit-gratuit' });
  const actions = (await s.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);
  expect(actions.filter((a) => a === 'audit_url_changed')).toHaveLength(1);
});

test('aucune réponse ne contient token_hash ni l’empreinte', async () => {
  const s = await setup();
  const createRes = await s.create();
  const { link, token } = createRes.json();
  const [row] = await s.db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
  const hash = row!.tokenHash;
  const regen = await s.call('POST', `/api/share-links/${link.id}/regenerate`, s.admin);
  const [row2] = await s.db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
  const responses = [
    createRes,
    regen,
    await s.call('GET', '/api/share-links', s.admin),
    await s.call('PATCH', `/api/share-links/${link.id}`, s.admin, { title: 'T', verdicts: [], showCosts: false, showResponses: false, active: true }),
  ];
  for (const r of responses) {
    expect(r.body).not.toMatch(/token_?hash/i);
    expect(r.body).not.toContain(hash);
    expect(r.body).not.toContain(row2!.tokenHash);
  }
  // Le jeton en clair n'apparaît qu'à la création et à la régénération.
  expect(createRes.body).toContain(token);
  expect(responses[2]!.body).not.toContain(token);
});
