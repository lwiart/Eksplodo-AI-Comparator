import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { users } from '../../db/schema/core.js';
import { NotFoundError } from '../../errors.js';
import { normalizeEmail, type Role } from '../auth/actor.js';

export type UserRow = typeof users.$inferSelect;
export type UserInsert = {
  email: string;
  name: string;
  role: Role;
  status?: UserRow['status'];
  passwordHash?: string | null;
};
export type UserPatch = Partial<
  Pick<UserRow, 'name' | 'role' | 'status' | 'passwordHash' | 'failedLoginCount' | 'lockedUntil' | 'lastLoginAt'>
>;

export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;

export function createUsersRepo(db: Db) {
  async function findById(id: string): Promise<UserRow | null> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }
  return {
    findById,
    async findByEmail(email: string): Promise<UserRow | null> {
      const rows = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
      return rows[0] ?? null;
    },
    listAll(): Promise<UserRow[]> {
      return db.select().from(users).orderBy(asc(users.name));
    },
    async insert(input: UserInsert): Promise<UserRow> {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: normalizeEmail(input.email),
        name: input.name,
        role: input.role,
        ...(input.status ? { status: input.status } : {}),
        ...(input.passwordHash !== undefined ? { passwordHash: input.passwordHash } : {}),
      });
      const row = await findById(id);
      if (!row) throw new Error('Utilisateur introuvable après création');
      return row;
    },
    async update(id: string, patch: UserPatch): Promise<UserRow> {
      if (Object.keys(patch).length > 0) {
        await db.update(users).set(patch).where(eq(users.id, id));
      }
      const row = await findById(id);
      if (!row) throw new NotFoundError();
      return row;
    },
    /**
     * Compte un échec d'authentification (incrément atomique, puis verrou conditionnel : des requêtes parallèles
     * ne dépassent pas MAX_FAILED_LOGINS essais). Renvoie vrai si le compte est verrouillé après cet échec.
     */
    async recordFailedLogin(id: string, now: Date): Promise<boolean> {
      await db
        .update(users)
        .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
        .where(eq(users.id, id));
      await db
        .update(users)
        .set({ lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS) })
        .where(and(eq(users.id, id), gte(users.failedLoginCount, MAX_FAILED_LOGINS), isNull(users.lockedUntil)));
      const row = await findById(id);
      return row?.lockedUntil != null && row.lockedUntil.getTime() > now.getTime();
    },
    async countActive(filter: { role: Role }): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(users)
        .where(and(eq(users.status, 'active'), eq(users.role, filter.role)));
      return Number(rows[0]?.n ?? 0);
    },
  };
}
