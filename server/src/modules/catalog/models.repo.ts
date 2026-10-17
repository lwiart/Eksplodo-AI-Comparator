import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models } from '../../db/schema/catalog.js';

export type ModelRow = typeof models.$inferSelect;
export type ModelInsert = typeof models.$inferInsert;
export type ModelPatch = Partial<Omit<ModelInsert, 'id' | 'providerId' | 'apiModelId' | 'createdAt' | 'updatedAt'>>;

export function createModelsRepo(db: Db) {
  return {
    async list(enabledOnly: boolean): Promise<ModelRow[]> {
      return db
        .select()
        .from(models)
        .where(enabledOnly ? eq(models.enabled, true) : undefined)
        .orderBy(models.displayName);
    },
    async find(id: string): Promise<ModelRow | undefined> {
      const [row] = await db.select().from(models).where(eq(models.id, id));
      return row;
    },
    async insert(values: ModelInsert): Promise<ModelRow> {
      await db.insert(models).values(values);
      return (await this.find(values.id))!;
    },
    async update(id: string, patch: ModelPatch): Promise<ModelRow | undefined> {
      if (Object.keys(patch).length > 0) await db.update(models).set(patch).where(eq(models.id, id));
      return this.find(id);
    },
    async apiModelIdsOf(providerId: string): Promise<Set<string>> {
      const rows = await db.select({ id: models.apiModelId }).from(models).where(eq(models.providerId, providerId));
      return new Set(rows.map((r) => r.id));
    },
  };
}
