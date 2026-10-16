import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { users } from '../src/db/schema/core.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { createUsersRepo } from '../src/modules/users/users.repo.js';
import { buildTestApp, loginAs, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const DAY = 24 * 3600_000;
const created: TestApp[] = [];

async function setup() {
  const t = await buildTestApp();
  created.push(t);
  await seedUser(t.db, { email: 'm@acme.fr', password: PW, role: 'user' });
  return t;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

async function csrfPair(app: TestApp['app']) {
  const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
  const csrf = init.cookies.find((c) => c.name === 'aic_csrf')!.value;
  return { cookie: `aic_csrf=${csrf}`, csrf };
}

async function rawLogin(app: TestApp['app'], email: string, password: string) {
  const { cookie, csrf } = await csrfPair(app);
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { email, password },
  });
}

describe('authentification', () => {
  test('connexion réussie puis /me', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'm@acme.fr', role: 'user' });
  });

  test('connexion insensible à la casse et aux espaces', async () => {
    const { app, db } = await setup();
    await seedUser(db, { email: 'laurent@eksplodo.fr', role: 'admin', password: 'motdepasse-12' });
    const { cookie, csrf } = await csrfPair(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: ' Laurent@Eksplodo.FR ', password: 'motdepasse-12' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('admin');
  });

  test('cookies aic_session et aic_csrf posés', async () => {
    const { app } = await setup();
    const res = await rawLogin(app, 'm@acme.fr', PW);
    const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const names = [...res.cookies, ...init.cookies].map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['aic_session', 'aic_csrf']));
  });

  test('cookie de session HttpOnly SameSite=Lax, cookie CSRF lisible', async () => {
    const { app } = await setup();
    const res = await rawLogin(app, 'm@acme.fr', PW);
    const session = res.cookies.find((c) => c.name === 'aic_session')!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 3600 });
    const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const csrfCookie = init.cookies.find((c) => c.name === 'aic_csrf')!;
    expect(csrfCookie.httpOnly).toBeFalsy();
    expect(csrfCookie.sameSite).toBe('Lax');
  });

  test('/me sans session → 401', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  test('requireAdmin : un Utilisateur reçoit 403, un Admin passe, sans session 401', async () => {
    const { app, db } = await setup();
    app.get('/api/_admin-probe', { preHandler: app.requireAdmin }, async () => ({ ok: true }));
    await seedUser(db, { email: 'admin@x.fr', password: PW, role: 'admin' });
    const u = await loginAs(app, 'm@acme.fr', PW);
    const res = await app.inject({ method: 'GET', url: '/api/_admin-probe', headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    const a = await loginAs(app, 'admin@x.fr', PW);
    expect((await app.inject({ method: 'GET', url: '/api/_admin-probe', headers: { cookie: a.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/_admin-probe' })).statusCode).toBe(401);
  });

  test('mauvais mot de passe et e-mail inconnu : même réponse', async () => {
    const { app } = await setup();
    const a = await rawLogin(app, 'm@acme.fr', 'mauvais-mot-de-passe');
    const b = await rawLogin(app, 'inconnu@acme.fr', PW);
    const expected = { error: { code: 'invalid_credentials', message: 'E-mail ou mot de passe incorrect.' } };
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(expected);
    expect(b.json()).toEqual(expected);
  });

  test('corps invalide → 400 validation', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await csrfPair(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  test('utilisateur invité (sans mot de passe) : même réponse 401', async () => {
    const { app, db } = await setup();
    await createUsersRepo(db).insert({ email: 'inv@acme.fr', name: 'Invité', role: 'user', status: 'invited' });
    const res = await rawLogin(app, 'inv@acme.fr', PW);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  test('verrouillage après 5 échecs pendant 15 min', async () => {
    const { app, clock } = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe')).statusCode).toBe(401);
    }
    expect((await rawLogin(app, 'm@acme.fr', PW)).statusCode).toBe(401);
    clock.advance(15 * 60_000 + 1);
    expect((await rawLogin(app, 'm@acme.fr', PW)).statusCode).toBe(200);
  });

  test('succès : compteur remis à 0 et lastLoginAt renseigné', async () => {
    const { app, db, clock } = await setup();
    await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    await rawLogin(app, 'm@acme.fr', PW);
    const row = (await db.select().from(users).where(eq(users.email, 'm@acme.fr')))[0]!;
    expect(row.failedLoginCount).toBe(0);
    expect(row.lastLoginAt?.getTime()).toBe(clock.now().getTime());
  });

  test('compte désactivé pendant la session → 401 à la requête suivante', async () => {
    const { app, db } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    await db.update(users).set({ status: 'disabled' }).where(eq(users.email, 'm@acme.fr'));
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(401);
    const res = await rawLogin(app, 'm@acme.fr', PW);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  test('requête modifiante sans jeton CSRF → 403', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });

  test('jeton CSRF différent du cookie ou de longueur différente → 403', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    for (const bad of ['autre', s.csrf.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: s.cookie, 'x-csrf-token': bad },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('csrf');
    }
  });

  test('connexion sans jeton CSRF → 403', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'm@acme.fr', password: PW },
    });
    expect(res.statusCode).toBe(403);
  });

  test('/internal n’est pas soumis au CSRF', async () => {
    const { app } = await setup();
    app.post('/internal/ping', async () => ({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/internal/ping' });
    expect(res.statusCode).toBe(200);
  });

  test('déconnexion invalide la session', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(401);
  });

  test('expiration glissante', async () => {
    const { app, clock } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const me = () => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    clock.advance(6 * DAY + 23 * 3600_000);
    expect((await me()).statusCode).toBe(200); // prolonge
    clock.advance(6 * DAY);
    expect((await me()).statusCode).toBe(200);
    clock.advance(8 * DAY);
    expect((await me()).statusCode).toBe(401);
  });

  test('la 11e tentative depuis la même IP est limitée (429)', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await csrfPair(app);
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { email: 'inconnu@acme.fr', password: 'faux-mot-de-passe' },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    const res = await attempt();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  }, 30_000);

  test('trustProxy : seul le dernier relais est cru (X-Forwarded-For falsifié ignoré)', async () => {
    const { app } = await setup();
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
    expect(res.json().ip).toBe('203.0.113.7');
  });

  test('CSRF : chemin avec échappements percent (/%61pi, /ap%69) → 403 csrf', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const out = await app.inject({ method: 'POST', url: '/%61pi/auth/logout', headers: { cookie: s.cookie } });
    expect(out.statusCode).toBe(403);
    expect(out.json().error.code).toBe('csrf');
    const login = await app.inject({
      method: 'POST',
      url: '/ap%69/auth/login',
      payload: { email: 'm@acme.fr', password: PW },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('csrf');
  });

  test('expiration glissante : le cookie est renvoyé quand la session est prolongée', async () => {
    const { app, clock } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const token = /aic_session=([^;]+)/.exec(s.cookie)![1];
    const first = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(first.cookies.find((c) => c.name === 'aic_session')).toBeUndefined();
    clock.advance(6 * DAY + 23 * 3600_000);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(res.cookies.find((c) => c.name === 'aic_session')).toMatchObject({
      value: token,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 3600,
    });
  });

  test('verrou expiré : le compteur repart de zéro (le 5e échec suivant verrouille)', async () => {
    const { app, db, clock } = await setup();
    for (let i = 0; i < 5; i++) await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    clock.advance(15 * 60_000 + 1);
    for (let i = 0; i < 4; i++) await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe'); // 5e échec de la nouvelle série
    const row = (await db.select().from(users).where(eq(users.email, 'm@acme.fr')))[0]!;
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil?.getTime()).toBe(clock.now().getTime() + 15 * 60_000);
  });

  test('verrou expiré : 4 échecs ne verrouillent pas', async () => {
    const { app, clock } = await setup();
    for (let i = 0; i < 5; i++) await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    clock.advance(15 * 60_000 + 1);
    for (let i = 0; i < 4; i++) await rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe');
    expect((await rawLogin(app, 'm@acme.fr', PW)).statusCode).toBe(200);
  });

  test('échecs parallèles : verrou posé et compteur exact', async () => {
    const { app, db } = await setup();
    await Promise.all(Array.from({ length: 5 }, () => rawLogin(app, 'm@acme.fr', 'faux-mot-de-passe')));
    const row = (await db.select().from(users).where(eq(users.email, 'm@acme.fr')))[0]!;
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).not.toBeNull();
  });

  test('createSession accepte une IP vide (socket UNIX)', async () => {
    const { db, clock } = await setup();
    const u = (await createUsersRepo(db).findByEmail('m@acme.fr'))!;
    const s = await createSession(db, u.id, { ip: '', userAgent: '' }, clock.now());
    expect(s.token).toBeTruthy();
  });
});

describe('changement de mot de passe', () => {
  const NEW_PW = 'nouveau-mot-de-passe-1';
  const change = (app: TestApp['app'], s: { cookie: string; csrf: string }, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: payload as object,
    });

  test('ancien mot de passe exigé, autres sessions fermées', async () => {
    const { app } = await setup();
    const first = await loginAs(app, 'm@acme.fr', PW);
    const second = await loginAs(app, 'm@acme.fr', PW);
    const bad = await change(app, first, { currentPassword: 'mauvais-mot-de-passe', newPassword: NEW_PW });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_password');
    // Le refus ne ferme aucune session.
    const stillOk = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie } });
    expect(stillOk.statusCode).toBe(200);

    const ok = await change(app, first, { currentPassword: PW, newPassword: NEW_PW });
    expect(ok.statusCode).toBe(204);
    const me1 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie } });
    const me2 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie } });
    expect(me1.statusCode).toBe(200);
    expect(me2.statusCode).toBe(401);
    // Le nouveau mot de passe est effectif, l'ancien non.
    expect((await rawLogin(app, 'm@acme.fr', PW)).statusCode).toBe(401);
    expect((await rawLogin(app, 'm@acme.fr', NEW_PW)).statusCode).toBe(200);
  });

  test('nouveau mot de passe de moins de 12 caractères refusé', async () => {
    const { app } = await setup();
    const s = await loginAs(app, 'm@acme.fr', PW);
    const res = await change(app, s, { currentPassword: PW, newPassword: 'court-1234' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  test('sans session → 401', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await csrfPair(app);
    const res = await change(app, { cookie, csrf }, { currentPassword: PW, newPassword: NEW_PW });
    expect(res.statusCode).toBe(401);
  });
});
