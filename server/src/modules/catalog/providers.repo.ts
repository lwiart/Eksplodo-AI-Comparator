import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';

export type ProviderRow = typeof providers.$inferSelect;
export type ProviderInsert = typeof providers.$inferInsert;
export type ProviderPatch = Partial<Omit<ProviderInsert, 'id' | 'createdAt' | 'updatedAt'>>;

export function createProvidersRepo(db: Db) {
  return {
    async list(): Promise<ProviderRow[]> {
      return db.select().from(providers).orderBy(providers.name);
    },
    async find(id: string): Promise<ProviderRow | undefined> {
      const [row] = await db.select().from(providers).where(eq(providers.id, id));
      return row;
    },
    async insert(values: ProviderInsert): Promise<ProviderRow> {
      await db.insert(providers).values(values);
      return (await this.find(values.id))!;
    },
    async update(id: string, patch: ProviderPatch): Promise<ProviderRow | undefined> {
      if (Object.keys(patch).length > 0) await db.update(providers).set(patch).where(eq(providers.id, id));
      return this.find(id);
    },
    /** Nombre de modèles par fournisseur ; `enabledOnly` ne compte que les modèles actifs. */
    async modelCounts(enabledOnly: boolean): Promise<Map<string, number>> {
      const rows = await db
        .select({ providerId: models.providerId, n: sql<number>`COUNT(*)` })
        .from(models)
        .where(enabledOnly ? eq(models.enabled, true) : undefined)
        .groupBy(models.providerId);
      return new Map(rows.map((r) => [r.providerId, Number(r.n)]));
    },
    async enabled(): Promise<ProviderRow[]> {
      return db.select().from(providers).where(eq(providers.enabled, true));
    },
  };
}
