import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sessions, users } from '../../db/schema/core.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { Actor } from './actor.js';

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const EXTEND_BELOW_MS = 6 * 24 * 3600_000;

export async function createSession(
  db: Db,
  userId: string,
  meta: { ip: string; userAgent: string },
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    idHash: hash,
    userId,
    expiresAt,
    ip: meta.ip.slice(0, 64),
    userAgent: meta.userAgent.slice(0, 400),
  });
  return { token, expiresAt };
}

/** Renvoie l'acteur de la session, ou null (absente, expirée, utilisateur non actif). */
export async function resolveSession(db: Db, token: string, now: Date): Promise<Actor | null> {
  return (await resolveSessionDetailed(db, token, now))?.actor ?? null;
}

/** Comme resolveSession ; `extendedTo` est la nouvelle expiration lorsque la session vient d'être prolongée. */
export async function resolveSessionDetailed(
  db: Db,
  token: string,
  now: Date,
): Promise<{ actor: Actor; extendedTo: Date | null } | null> {
  const idHash = hashToken(token);
  const rows = await db
    .select({
      expiresAt: sessions.expiresAt,
      userId: users.id,
      role: users.role,
      email: users.email,
      name: users.name,
      userStatus: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.idHash, idHash));
    return null;
  }
  if (row.userStatus !== 'active') return null;
  let extendedTo: Date | null = null;
  if (row.expiresAt.getTime() - now.getTime() < EXTEND_BELOW_MS) {
    extendedTo = new Date(now.getTime() + SESSION_TTL_MS);
    await db.update(sessions).set({ expiresAt: extendedTo }).where(eq(sessions.idHash, idHash));
  }
  return {
    actor: { userId: row.userId, role: row.role, email: row.email, name: row.name },
    extendedTo,
  };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.idHash, hashToken(token)));
}

export async function destroyUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
