import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { runTests } from '../../db/schema/runs.js';
import { suiteTests, testAttachments, tests } from '../../db/schema/tests.js';

export type TestRow = typeof tests.$inferSelect;
export type TestInsert = typeof tests.$inferInsert;
export type TestPatch = Partial<Omit<TestInsert, 'id' | 'createdAt' | 'updatedAt'>>;
export type AttachmentRow = typeof testAttachments.$inferSelect;

export type TestFilters = { archived?: boolean; category?: string; tag?: string; q?: string };

/** Échappe `%`, `_` et `\` pour un LIKE littéral. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createTestsRepo(db: Db) {
  return {
    async find(id: string): Promise<TestRow | undefined> {
      const [row] = await db.select().from(tests).where(eq(tests.id, id));
      return row;
    },
    async list(f: TestFilters): Promise<TestRow[]> {
      const where = and(
        f.archived ? isNotNull(tests.archivedAt) : isNull(tests.archivedAt),
        f.category === undefined ? undefined : eq(tests.category, f.category),
        f.tag === undefined ? undefined : sql`JSON_CONTAINS(${tests.tags}, JSON_QUOTE(${f.tag}))`,
        f.q === undefined || f.q === ''
          ? undefined
          : or(like(tests.name, likePattern(f.q)), like(tests.userPrompt, likePattern(f.q)), like(tests.systemPrompt, likePattern(f.q))),
      );
      return db.select().from(tests).where(where).orderBy(asc(tests.name), desc(tests.createdAt));
    },
    async insert(values: TestInsert): Promise<TestRow> {
      await db.insert(tests).values(values);
      return (await this.find(values.id))!;
    },
    async update(id: string, patch: TestPatch): Promise<TestRow | undefined> {
      if (Object.keys(patch).length > 0) await db.update(tests).set(patch).where(eq(tests.id, id));
      return this.find(id);
    },
    /** Pièces jointes actives (non retirées) des tests donnés, par date de création. */
    async activeAttachments(testIds: string[]): Promise<AttachmentRow[]> {
      if (testIds.length === 0) return [];
      return db
        .select()
        .from(testAttachments)
        .where(and(inArray(testAttachments.testId, testIds), isNull(testAttachments.deletedAt)))
        .orderBy(asc(testAttachments.createdAt), asc(testAttachments.id));
    },
    /** Toutes les pièces jointes du test, retirées comprises (pour effacer les fichiers). */
    async allAttachments(testId: string): Promise<AttachmentRow[]> {
      return db.select().from(testAttachments).where(eq(testAttachments.testId, testId));
    },
    /** Nombre de séries distinctes dont les `run_tests` référencent chaque test. */
    async usedInRuns(testIds: string[]): Promise<Map<string, number>> {
      if (testIds.length === 0) return new Map();
      const rows = await db
        .select({ testId: runTests.testId, n: sql<number>`COUNT(DISTINCT ${runTests.runId})` })
        .from(runTests)
        .where(inArray(runTests.testId, testIds))
        .groupBy(runTests.testId);
      return new Map(rows.map((r) => [r.testId, Number(r.n)]));
    },
    /** Supprime pièces jointes, appartenances aux suites puis le test, dans une transaction. */
    async deleteWithDependents(id: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(testAttachments).where(eq(testAttachments.testId, id));
        await tx.delete(suiteTests).where(eq(suiteTests.testId, id));
        await tx.delete(tests).where(eq(tests.id, id));
      });
    },
    async categories(): Promise<string[]> {
      const rows = await db
        .selectDistinct({ category: tests.category })
        .from(tests)
        .where(isNull(tests.archivedAt))
        .orderBy(asc(tests.category));
      return rows.map((r) => r.category);
    },
    async tagLists(): Promise<string[][]> {
      const rows = await db.select({ tags: tests.tags }).from(tests).where(isNull(tests.archivedAt));
      return rows.map((r) => r.tags);
    },
  };
}
