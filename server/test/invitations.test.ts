import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { invitations, sessions } from '../src/db/schema/core.js';
import { verifyPassword } from '../src/lib/crypto.js';
import {
  INVITE_TTL_MS,
  invitationLink,
  issueInvitation,
  redeemInvitation,
  RESET_TTL_MS,
  updateUserUnlessDisabled,
} from '../src/modules/auth/invitations.js';
import { createSession } from '../src/modules/auth/sessions.js';
import { invitationEmail, resetEmail } from '../src/modules/mail/templates.js';
import { createUsersRepo } from '../src/modules/users/users.repo.js';
import { buildTestApp, seedUser, testConfig, type TestApp } from './helpers/test-app.js';

const HOUR = 3600_000;
const PW = 'un-mot-de-passe-long';
const created: TestApp[] = [];

async function setup() {
  const t = await buildTestApp();
  created.push(t);
  const invited = await createUsersRepo(t.db).insert({
    email: 'nouveau@acme.fr',
    name: 'Nouveau',
    role: 'user',
    status: 'invited',
  });
  return { ...t, invited };
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

type App = TestApp['app'];
async function post(app: App, url: string, payload: unknown) {
  const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
  const csrf = init.cookies.find((c) => c.name === 'aic_csrf')!.value;
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: `aic_csrf=${csrf}`, 'x-csrf-token': csrf },
    payload: payload as object,
  });
}
const accept = (app: App, body: unknown) => post(app, '/api/auth/invitations/accept', body);
const reset = (app: App, body: unknown) => post(app, '/api/auth/password/reset', body);
const errCode = (res: { json(): any }) => res.json().error.code;

describe('invitations', () => {
  test('invitation acceptée : compte actif, mot de passe défini, session ouverte', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    const res = await accept(app, { token, password: PW, name: 'Nouvelle Personne' });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === 'aic_session')).toBe(true);
    expect(res.json().user).toMatchObject({ email: 'nouveau@acme.fr', name: 'Nouvelle Personne', role: 'user' });
    const row = await createUsersRepo(db).findById(invited.id);
    expect(row?.status).toBe('active');
    expect(await verifyPassword(row!.passwordHash!, PW)).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, invited.id))).toHaveLength(1);
  });

  test('lien réutilisé refusé', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    expect((await accept(app, { token, password: PW })).statusCode).toBe(200);
    const second = await accept(app, { token, password: PW });
    expect(second.statusCode).toBe(400);
    expect(errCode(second)).toBe('invitation_invalid');
  });

  test('deux acceptations simultanées : une seule réussit', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    const results = await Promise.all([accept(app, { token, password: PW }), accept(app, { token, password: PW })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  test('lien expiré (72 h + 1 ms) refusé', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    clock.advance(INVITE_TTL_MS + 1);
    const res = await accept(app, { token, password: PW });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe('invitation_invalid');
  });

  test('lien encore valable 1 ms avant les 72 h', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    clock.advance(INVITE_TTL_MS - 1);
    expect((await accept(app, { token, password: PW })).statusCode).toBe(200);
  });

  test('régénérer invalide le lien précédent', async () => {
    const { app, db, clock, invited } = await setup();
    const t1 = await issueInvitation(db, invited.id, 'invite', clock.now());
    const t2 = await issueInvitation(db, invited.id, 'invite', clock.now());
    expect((await accept(app, { token: t1, password: PW })).statusCode).toBe(400);
    expect((await accept(app, { token: t2, password: PW })).statusCode).toBe(200);
  });

  test('régénérer une invitation ne touche pas les liens de réinitialisation', async () => {
    const { app, db, clock, invited } = await setup();
    const resetToken = await issueInvitation(db, invited.id, 'reset', clock.now());
    await issueInvitation(db, invited.id, 'invite', clock.now());
    expect((await reset(app, { token: resetToken, password: PW })).statusCode).toBe(204);
  });

  test('compte désactivé entre-temps : lien refusé, compte inchangé', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    await createUsersRepo(db).update(invited.id, { status: 'disabled' });
    const res = await accept(app, { token, password: PW });
    expect(errCode(res)).toBe('invitation_invalid');
    const row = await createUsersRepo(db).findById(invited.id);
    expect(row?.status).toBe('disabled');
    expect(row?.passwordHash).toBeNull();
  });

  test('jeton de réinitialisation refusé comme invitation', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'reset', clock.now());
    expect(errCode(await accept(app, { token, password: PW }))).toBe('invitation_invalid');
  });

  test('mot de passe trop court → weak_password, jeton non consommé', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    const res = await accept(app, { token, password: '12345678901' });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe('weak_password');
    expect((await accept(app, { token, password: PW })).statusCode).toBe(200);
  });

  test('le jeton est stocké haché', async () => {
    const { db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    const rows = await db.select().from(invitations).where(eq(invitations.userId, invited.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  test('liens : /invitation/<jeton> et /reinitialiser/<jeton>', () => {
    const config = testConfig();
    expect(invitationLink(config, 'invite', 'abc')).toBe('http://localhost:3000/invitation/abc');
    expect(invitationLink(config, 'reset', 'abc')).toBe('http://localhost:3000/reinitialiser/abc');
  });

  test('limitation : la 11e tentative depuis la même IP → 429', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await accept(app, { token: 'inconnu', password: PW })).statusCode;
    expect(last).toBe(429);
  });
});

describe('atomicité', () => {
  test('accepter une invitation sur un compte actif révoque ses autres sessions', async () => {
    const { app, db, clock } = await setup();
    const user = await seedUser(db, { email: 'a@acme.fr', password: PW, role: 'user' });
    await createSession(db, user.id, { ip: '', userAgent: '' }, clock.now());
    const token = await issueInvitation(db, user.id, 'invite', clock.now());
    expect((await accept(app, { token, password: 'autre-mot-de-passe-long' })).statusCode).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
  });

  test('échec de la mise à jour utilisateur : le jeton n’est pas consommé', async () => {
    const { db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    await expect(
      redeemInvitation(db, token, 'invite', clock.now(), async (tx, id) => {
        await createUsersRepo(db).update(id, { status: 'disabled' });
        await updateUserUnlessDisabled(tx, id, { status: 'active' });
      }),
    ).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect((await createUsersRepo(db).findById(invited.id))?.status).toBe('disabled');
    const rows = await db.select().from(invitations).where(eq(invitations.userId, invited.id));
    expect(rows[0]!.usedAt).toBeNull();
  });
});

describe('réinitialisation', () => {
  test('valable 24 h, change le mot de passe, lève le verrou et ferme les sessions', async () => {
    const { app, db, clock } = await setup();
    const user = await seedUser(db, { email: 'm@acme.fr', password: PW, role: 'user' });
    await createUsersRepo(db).update(user.id, {
      failedLoginCount: 5,
      lockedUntil: new Date(clock.now().getTime() + HOUR),
    });
    await createSession(db, user.id, { ip: '', userAgent: '' }, clock.now());
    const token = await issueInvitation(db, user.id, 'reset', clock.now());
    clock.advance(RESET_TTL_MS - 1);

    const bad = await reset(app, { token, password: 'court' });
    expect(errCode(bad)).toBe('weak_password');
    const res = await reset(app, { token, password: 'nouveau-mot-de-passe' });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.some((c) => c.name === 'aic_session')).toBe(false);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    const row = await createUsersRepo(db).findById(user.id);
    expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(await verifyPassword(row!.passwordHash!, 'nouveau-mot-de-passe')).toBe(true);

    const login = await post(app, '/api/auth/login', { email: 'm@acme.fr', password: 'nouveau-mot-de-passe' });
    expect(login.statusCode).toBe(200);
    expect(errCode(await reset(app, { token, password: 'encore-un-autre-mdp' }))).toBe('invitation_invalid');
  });

  test('réinitialisation expirée après 24 h + 1 ms', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'reset', clock.now());
    clock.advance(RESET_TTL_MS + 1);
    expect(errCode(await reset(app, { token, password: PW }))).toBe('invitation_invalid');
  });

  test('compte désactivé avant la réinitialisation : jeton refusé, statut inchangé', async () => {
    const { app, db, clock } = await setup();
    const user = await seedUser(db, { email: 'd@acme.fr', password: PW, role: 'user' });
    const token = await issueInvitation(db, user.id, 'reset', clock.now());
    await createUsersRepo(db).update(user.id, { status: 'disabled' });
    expect(errCode(await reset(app, { token, password: PW + 'x' }))).toBe('invitation_invalid');
    expect((await createUsersRepo(db).findById(user.id))?.status).toBe('disabled');
  });

  test('un jeton d’invitation ne réinitialise pas un mot de passe', async () => {
    const { app, db, clock, invited } = await setup();
    const token = await issueInvitation(db, invited.id, 'invite', clock.now());
    expect(errCode(await reset(app, { token, password: PW }))).toBe('invitation_invalid');
  });
});

describe('gabarits', () => {
  test('échappe le nom dans le HTML et porte la marque', () => {
    const m = invitationEmail({ name: '<b>x</b>', link: 'http://l/invitation/t' });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.html).toContain('Eksplodo · Comparateur IA');
    expect(m.text).toContain('http://l/invitation/t');
    expect(m.text).toContain('72 heures');
  });

  test('objet de l’invitation : prénom, caractères de contrôle neutralisés', () => {
    const m = invitationEmail({ name: 'Eve\r\nBcc: x@y.z', link: 'http://l' });
    expect(m.subject).not.toMatch(/[\r\n\t]/);
    expect(m.subject).toBe('Eve Bcc: x@y.z, votre accès à Eksplodo · Comparateur IA');
  });

  test('réinitialisation : 24 heures', () => {
    const m = resetEmail({ name: 'Marie Dupont', link: 'http://l/reinitialiser/t' });
    expect(m.subject).toBe('Marie Dupont, réinitialisation de votre mot de passe Eksplodo · Comparateur IA');
    expect(m.text).toContain('24 heures');
  });
});
