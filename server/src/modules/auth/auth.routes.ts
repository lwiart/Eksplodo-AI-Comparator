import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { sessions } from '../../db/schema/core.js';
import { AppError, UnauthorizedError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../plugins/auth.js';
import { AUTH_RATE_LIMIT } from '../../plugins/rate-limit.js';
import { createUsersRepo } from '../users/users.repo.js';
import { assertInvitationRedeemable, redeemInvitation, updateUserUnlessDisabled } from './invitations.js';
import { normalizeEmail, type Role } from './actor.js';
import { createSession, destroySession, destroyUserSessions } from './sessions.js';

export type PublicUser = { id: string; email: string; name: string; role: Role };

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

class WeakPasswordError extends ValidationError {
  constructor() {
    super('weak_password', `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
}

class InvalidCredentialsError extends AppError {
  constructor() {
    super('invalid_credentials', 401, 'E-mail ou mot de passe incorrect.');
  }
}

// Hash factice (calculé une fois, à la demande) pour égaliser le temps de réponse quand il n'y a rien à vérifier.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('mot-de-passe-factice-anti-enumeration');
  return dummyHash;
}

const loginBody = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });
const tokenField = z.string().min(1).max(200);
const acceptBody = z.object({
  token: tokenField,
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const resetBody = z.object({ token: tokenField, password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });
const passwordBody = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `au moins ${MIN_PASSWORD_LENGTH} caractères`)
    .max(MAX_PASSWORD_LENGTH),
});

export function registerAuthRoutes(app: FastifyInstance, deps: { config: AppConfig; clock: Clock; db: Db }): void {
  const { config, clock, db } = deps;
  const usersRepo = createUsersRepo(db);

  async function publicUser(userId: string): Promise<PublicUser> {
    const u = await usersRepo.findById(userId);
    if (!u) throw new UnauthorizedError();
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }

  app.post('/api/auth/login', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const now = clock();
    const user = await usersRepo.findByEmail(normalizeEmail(body.email));

    let ok = false;
    if (user) {
      // Un verrou expiré ne bloque plus ; `recordFailedLogin` (ou la réussite) le remet à zéro atomiquement.
      const lockedUntil = user.lockedUntil && user.lockedUntil.getTime() > now.getTime() ? user.lockedUntil : null;
      const blocked = user.status !== 'active' || lockedUntil !== null;
      // Le hachage est vérifié même pour un compte bloqué ou sans mot de passe (temps de réponse égalisé).
      const passwordOk = await verifyPassword(user.passwordHash ?? (await getDummyHash()), body.password);
      ok = !blocked && passwordOk && user.passwordHash !== null;
      if (!ok && !blocked) {
        await usersRepo.recordFailedLogin(user.id, now);
      }
    } else {
      await verifyPassword(await getDummyHash(), body.password);
    }
    if (!user || !ok) throw new InvalidCredentialsError();

    await usersRepo.update(user.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now });
    const session = await createSession(
      db,
      user.id,
      { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      now,
    );
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(config));
    return { user: await publicUser(user.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.requireActor }, async (req) => {
    return { user: await publicUser(req.actor!.userId) };
  });

  // Changement de mot de passe : l'ancien est exigé ; les autres sessions du compte sont fermées.
  app.post('/api/auth/password', { ...AUTH_RATE_LIMIT, preHandler: app.requireActor }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const now = clock();
    const user = await usersRepo.findById(req.actor!.userId);
    if (!user) throw new UnauthorizedError();
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) throw new UnauthorizedError();
    const valid = user.passwordHash !== null && (await verifyPassword(user.passwordHash, body.currentPassword));
    if (!valid) {
      // Même décompte que la connexion : un cookie volé ne permet pas de deviner le mot de passe sans limite.
      if (await usersRepo.recordFailedLogin(user.id, now)) {
        await destroyUserSessions(db, user.id);
        throw new UnauthorizedError('Compte verrouillé temporairement.');
      }
      throw new ValidationError('invalid_password', 'Le mot de passe actuel est incorrect.');
    }
    const passwordHash = await hashPassword(body.newPassword);
    await usersRepo.update(user.id, { passwordHash, failedLoginCount: 0, lockedUntil: null });
    const current = req.cookies[SESSION_COOKIE];
    const others = current
      ? and(eq(sessions.userId, user.id), ne(sessions.idHash, hashToken(current)))
      : eq(sessions.userId, user.id);
    await db.delete(sessions).where(others);
    return reply.status(204).send();
  });

  // Acceptation d'une invitation : nom (facultatif) + mot de passe, compte activé, session ouverte.
  app.post('/api/auth/invitations/accept', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = acceptBody.parse(req.body);
    if (body.password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
    const now = clock();
    await assertInvitationRedeemable(db, body.token, 'invite', now); // jeton invalide : refus sans hachage argon2
    const passwordHash = await hashPassword(body.password); // avant la consommation : un échec ne brûle pas le jeton
    const { userId } = await redeemInvitation(db, body.token, 'invite', now, async (tx, id) => {
      await updateUserUnlessDisabled(tx, id, {
        passwordHash,
        status: 'active',
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(body.name ? { name: body.name } : {}),
      });
      await tx.delete(sessions).where(eq(sessions.userId, id)); // le mot de passe change : anciennes sessions révoquées
    });
    const session = await createSession(
      db,
      userId,
      { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      now,
    );
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(config));
    return { user: await publicUser(userId) };
  });

  // Réinitialisation (lien émis par l'Admin) : nouveau mot de passe, toutes les sessions fermées, pas de connexion automatique.
  app.post('/api/auth/password/reset', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = resetBody.parse(req.body);
    if (body.password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
    const now = clock();
    await assertInvitationRedeemable(db, body.token, 'reset', now);
    const passwordHash = await hashPassword(body.password);
    await redeemInvitation(db, body.token, 'reset', now, async (tx, id) => {
      await updateUserUnlessDisabled(tx, id, { passwordHash, failedLoginCount: 0, lockedUntil: null });
      await tx.delete(sessions).where(eq(sessions.userId, id));
    });
    return reply.status(204).send();
  });
}
