import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { sessions, users } from '../../db/schema/core.js';
import { AppError, UnauthorizedError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../plugins/auth.js';
import { AUTH_RATE_LIMIT } from '../../plugins/rate-limit.js';
import { createUsersRepo } from '../users/users.repo.js';
import { normalizeEmail, type Role } from './actor.js';
import { createSession, destroySession } from './sessions.js';

export type PublicUser = { id: string; email: string; name: string; role: Role };

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

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
      let lockedUntil = user.lockedUntil;
      if (lockedUntil && lockedUntil.getTime() <= now.getTime()) {
        // Verrou expiré : on repart de zéro.
        await usersRepo.update(user.id, { failedLoginCount: 0, lockedUntil: null });
        lockedUntil = null;
      }
      const blocked = user.status !== 'active' || lockedUntil !== null;
      // Le hachage est vérifié même pour un compte bloqué ou sans mot de passe (temps de réponse égalisé).
      const passwordOk = await verifyPassword(user.passwordHash ?? (await getDummyHash()), body.password);
      ok = !blocked && passwordOk && user.passwordHash !== null;
      if (!ok && !blocked) {
        // Incrément atomique, puis verrou conditionnel : des requêtes parallèles ne dépassent pas 5 essais.
        await db
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
          .where(eq(users.id, user.id));
        await db
          .update(users)
          .set({ lockedUntil: new Date(now.getTime() + LOCK_MS) })
          .where(and(eq(users.id, user.id), gte(users.failedLoginCount, MAX_FAILURES), isNull(users.lockedUntil)));
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
  app.post('/api/auth/password', { preHandler: app.requireActor }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const user = await usersRepo.findById(req.actor!.userId);
    if (!user) throw new UnauthorizedError();
    const valid = user.passwordHash !== null && (await verifyPassword(user.passwordHash, body.currentPassword));
    if (!valid) throw new ValidationError('invalid_password', 'Le mot de passe actuel est incorrect.');
    const passwordHash = await hashPassword(body.newPassword);
    await usersRepo.update(user.id, { passwordHash, failedLoginCount: 0, lockedUntil: null });
    const current = req.cookies[SESSION_COOKIE];
    const others = current
      ? and(eq(sessions.userId, user.id), ne(sessions.idHash, hashToken(current)))
      : eq(sessions.userId, user.id);
    await db.delete(sessions).where(others);
    return reply.status(204).send();
  });
}
