import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
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
    async countActive(filter: { role: Role }): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(users)
        .where(and(eq(users.status, 'active'), eq(users.role, filter.role)));
      return Number(rows[0]?.n ?? 0);
    },
  };
}
