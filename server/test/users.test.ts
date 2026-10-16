import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { auditLog, invitations } from '../src/db/schema/core.js';
import { hashToken } from '../src/lib/crypto.js';
import { createUsersRepo } from '../src/modules/users/users.repo.js';
import { buildTestApp, loginAs, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

async function setup() {
  const t = await buildTestApp();
  created.push(t);
  const admin = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Admin' });
  const session = await loginAs(t.app, 'admin@acme.fr', PW);
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, s = session) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    ...t,
    admin,
    session,
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
    call,
  };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

const code = (res: { json(): any }) => res.json().error.code;
const tokenOf = (link: string) => link.split('/').pop()!;

describe('API Admin des utilisateurs', () => {
  test('inviter renvoie le lien une seule fois et envoie l’e-mail', async () => {
    const { get, post, mailer } = await setup();
    const res = await post('/api/users', { email: ' Nouveau@Client.fr ', name: 'Camille', role: 'user' });
    expect(res.statusCode).toBe(201);
    expect(res.json().link).toMatch(/\/invitation\/[A-Za-z0-9_-]{32,}$/);
    expect(res.json().mail).toBe('sent');
    expect(res.json().user).toMatchObject({
      email: 'nouveau@client.fr',
      name: 'Camille',
      role: 'user',
      status: 'invited',
      lastLoginAt: null,
    });
    expect(typeof res.json().expiresAt).toBe('string');
    expect(mailer.sent[0]?.to).toBe('nouveau@client.fr');
    const list = await get('/api/users');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(tokenOf(res.json().link));
    expect(list.body).not.toContain('passwordHash');
    expect(list.json().users).toHaveLength(2);
  });

  test('SMTP absent → mail "not_configured", lien quand même renvoyé', async () => {
    const { post, mailer } = await setup();
    (mailer as { delivers: boolean }).delivers = false;
    const res = await post('/api/users', { email: 'a@b.fr', name: 'A', role: 'user' });
    expect(res.statusCode).toBe(201);
    expect(res.json().mail).toBe('not_configured');
    expect(res.json().link).toMatch(/\/invitation\//);
    expect(mailer.sent).toHaveLength(0);
  });

  test('échec d’envoi → mail "failed", lien utilisable', async () => {
    const { post, db, mailer } = await setup();
    mailer.send = async () => {
      throw new Error('SMTP en panne');
    };
    const res = await post('/api/users', { email: 'a@b.fr', name: 'A', role: 'user' });
    expect(res.statusCode).toBe(201);
    expect(res.json().mail).toBe('failed');
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(tokenOf(res.json().link))));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedAt).toBeNull();
  });

  test('e-mail déjà utilisé (autre casse) → 409 "email_taken"', async () => {
    const { post } = await setup();
    const res = await post('/api/users', { email: 'ADMIN@acme.fr', name: 'Bis', role: 'user' });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('email_taken');
  });

  test('validation : nom vide ou trop long, rôle inconnu', async () => {
    const { post } = await setup();
    expect(code(await post('/api/users', { email: 'a@b.fr', name: '  ', role: 'user' }))).toBe('validation');
    expect(code(await post('/api/users', { email: 'a@b.fr', name: 'A', role: 'manager' }))).toBe('validation');
    expect(code(await post('/api/users', { email: 'a@b.fr', name: 'x'.repeat(201), role: 'user' }))).toBe('validation');
  });

  test('régénérer le lien : nouveau lien, l’ancien est refusé', async () => {
    const { app, post, mailer } = await setup();
    const first = await post('/api/users', { email: 'a@b.fr', name: 'A', role: 'user' });
    const id = first.json().user.id;
    const second = await post(`/api/users/${id}/invite-link`);
    expect(second.statusCode).toBe(200);
    expect(second.json().mail).toBe('sent');
    expect(second.json().link).not.toBe(first.json().link);
    expect(mailer.sent).toHaveLength(2);
    const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const csrf = init.cookies.find((c) => c.name === 'aic_csrf')!.value;
    const accept = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/invitations/accept',
        headers: { cookie: `aic_csrf=${csrf}`, 'x-csrf-token': csrf },
        payload: { token, password: 'un-mot-de-passe-long' },
      });
    expect(code(await accept(tokenOf(first.json().link)))).toBe('invitation_invalid');
    expect((await accept(tokenOf(second.json().link))).statusCode).toBe(200);
  });

  test('régénérer l’invitation d’un compte non invité → 409 "user_not_invited"', async () => {
    const { post, admin } = await setup();
    const res = await post(`/api/users/${admin.id}/invite-link`);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('user_not_invited');
  });

  test('lien de réinitialisation réservé aux comptes actifs', async () => {
    const { post, db } = await setup();
    const invited = await createUsersRepo(db).insert({ email: 'i@b.fr', name: 'I', role: 'user', status: 'invited' });
    const resInvited = await post(`/api/users/${invited.id}/reset-link`);
    expect(resInvited.statusCode).toBe(409);
    expect(code(resInvited)).toBe('user_not_active');
    const active = await seedUser(db, { email: 'u@b.fr', role: 'user' });
    const ok = await post(`/api/users/${active.id}/reset-link`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().link).toMatch(/\/reinitialiser\/[A-Za-z0-9_-]{32,}$/);
    expect(ok.json().mail).toBe('sent');
    expect((await post('/api/users/00000000-0000-4000-8000-000000000000/reset-link')).statusCode).toBe(404);
  });

  test('désactiver ferme les sessions du compte', async () => {
    const { app, db, patch } = await setup();
    const user = await seedUser(db, { email: 'u@b.fr', role: 'user' });
    const userSession = await loginAs(app, 'u@b.fr', PW);
    const me = () => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: userSession.cookie } });
    expect((await me()).statusCode).toBe(200);
    const res = await patch(`/api/users/${user.id}`, { status: 'disabled' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.status).toBe('disabled');
    expect((await me()).statusCode).toBe(401);
  });

  test('réactivation : permise après activation, refusée pour un compte jamais activé', async () => {
    const { db, patch } = await setup();
    const used = await seedUser(db, { email: 'u@b.fr', role: 'user', status: 'disabled' });
    expect((await patch(`/api/users/${used.id}`, { status: 'active' })).json().user.status).toBe('active');
    const invited = await createUsersRepo(db).insert({ email: 'i@b.fr', name: 'I', role: 'user', status: 'invited' });
    const res = await patch(`/api/users/${invited.id}`, { status: 'active' });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('user_not_activated');
  });

  test('dernier Admin actif : ni désactivation ni rétrogradation, y compris de soi-même', async () => {
    const { patch, admin } = await setup();
    const a = await patch(`/api/users/${admin.id}`, { status: 'disabled' });
    expect(a.statusCode).toBe(409);
    expect(code(a)).toBe('last_admin');
    expect(code(await patch(`/api/users/${admin.id}`, { role: 'user' }))).toBe('last_admin');
  });

  test('avec deux Admins actifs, l’un peut rétrograder l’autre', async () => {
    const { patch, db } = await setup();
    const other = await seedUser(db, { email: 'admin2@acme.fr', role: 'admin' });
    const res = await patch(`/api/users/${other.id}`, { role: 'user' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('user');
  });

  test('deux désactivations concurrentes de deux Admins : un Admin actif subsiste', async () => {
    const { patch, db, admin } = await setup();
    const other = await seedUser(db, { email: 'admin2@acme.fr', role: 'admin' });
    const results = await Promise.all([
      patch(`/api/users/${admin.id}`, { status: 'disabled' }),
      patch(`/api/users/${other.id}`, { status: 'disabled' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await createUsersRepo(db).countActive({ role: 'admin' })).toBe(1);
  });

  test('un Utilisateur reçoit 403 sur toutes les routes /api/users', async () => {
    const { db, app, call, admin } = await setup();
    await seedUser(db, { email: 'u@b.fr', role: 'user' });
    const s = await loginAs(app, 'u@b.fr', PW);
    const id = admin.id;
    const results = await Promise.all([
      call('GET', '/api/users', undefined, s),
      call('POST', '/api/users', { email: 'x@y.fr', name: 'X', role: 'user' }, s),
      call('PATCH', `/api/users/${id}`, { role: 'user' }, s),
      call('POST', `/api/users/${id}/invite-link`, {}, s),
      call('POST', `/api/users/${id}/reset-link`, {}, s),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
  });

  test('chaque action est auditée, sans jeton', async () => {
    const { post, patch, db } = await setup();
    const invite = await post('/api/users', { email: 'a@b.fr', name: 'A', role: 'user' });
    const id = invite.json().user.id;
    const regen = await post(`/api/users/${id}/invite-link`);
    const active = await seedUser(db, { email: 'u@b.fr', role: 'user' });
    await post(`/api/users/${active.id}/reset-link`);
    await patch(`/api/users/${active.id}`, { status: 'disabled' });
    const rows = await db.select().from(auditLog);
    const actions = rows.map((r) => r.action);
    for (const a of ['user_invited', 'invite_regenerated', 'reset_issued', 'user_updated']) expect(actions).toContain(a);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(tokenOf(invite.json().link));
    expect(dump).not.toContain(tokenOf(regen.json().link));
  });
});
