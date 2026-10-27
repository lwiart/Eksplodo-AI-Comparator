import { randomUUID } from 'node:crypto';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { suiteTests, suites, testAttachments, tests } from '../../db/schema/tests.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import type { ScoringMethod } from './scoring-config.js';
import { ER_DUP_ENTRY, errnoOf } from '../../lib/db-errors.js';

export type SuiteInput = { name: string; description?: string | null; testIds: string[] };

export type PublicSuiteTest = {
  id: string;
  name: string;
  category: string;
  scoringMethod: ScoringMethod;
  archived: boolean;
  attachmentCount: number;
};

export type PublicSuite = {
  id: string;
  name: string;
  description: string | null;
  tests: PublicSuiteTest[];
  createdAt: string;
  updatedAt: string;
};

export type SuitesServiceDeps = { db: Db };

type SuiteRow = typeof suites.$inferSelect;

const NAME_MAX = 200;

const suiteNotFound = () => new NotFoundError('Suite introuvable');
const nameTaken = () => new ConflictError('suite_name_taken', 'Une suite porte déjà ce nom');
const testMissing = () => new ValidationError('test_not_found', 'Un des tests demandés est introuvable');

export function createSuitesService(deps: SuitesServiceDeps) {
  const { db } = deps;

  /** Tests des suites données, dans l'ordre des positions ; archivés compris, pièces jointes retirées exclues. */
  async function testsOf(suiteIds: string[]): Promise<Map<string, PublicSuiteTest[]>> {
    const bySuite = new Map<string, PublicSuiteTest[]>();
    if (suiteIds.length === 0) return bySuite;
    const rows = await db
      .select({
        suiteId: suiteTests.suiteId,
        id: tests.id,
        name: tests.name,
        category: tests.category,
        scoringMethod: tests.scoringMethod,
        archivedAt: tests.archivedAt,
        attachmentCount: sql<number>`(SELECT COUNT(*) FROM ${testAttachments} WHERE ${testAttachments.testId} = ${tests.id} AND ${testAttachments.deletedAt} IS NULL)`,
      })
      .from(suiteTests)
      .innerJoin(tests, eq(tests.id, suiteTests.testId))
      .where(inArray(suiteTests.suiteId, suiteIds))
      .orderBy(asc(suiteTests.suiteId), asc(suiteTests.position));
    for (const r of rows) {
      const list = bySuite.get(r.suiteId) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        category: r.category,
        scoringMethod: r.scoringMethod,
        archived: r.archivedAt !== null,
        attachmentCount: Number(r.attachmentCount),
      });
      bySuite.set(r.suiteId, list);
    }
    return bySuite;
  }

  async function view(rows: SuiteRow[]): Promise<PublicSuite[]> {
    const bySuite = await testsOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tests: bySuite.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async function viewById(id: string): Promise<PublicSuite> {
    const [row] = await db.select().from(suites).where(eq(suites.id, id));
    if (!row) throw suiteNotFound();
    return (await view([row]))[0]!;
  }

  /** Vérifie que chaque identifiant désigne un test existant (archivé ou non). */
  async function assertTestsExist(testIds: string[]): Promise<void> {
    if (testIds.length === 0) return;
    const [found] = await db.select({ n: count() }).from(tests).where(inArray(tests.id, testIds));
    if (Number(found?.n) !== testIds.length) throw testMissing();
  }

  return {
    async list(): Promise<PublicSuite[]> {
      return view(await db.select().from(suites).orderBy(asc(suites.name)));
    },

    get: viewById,

    async create(actor: Actor, input: SuiteInput): Promise<PublicSuite> {
      await assertTestsExist(input.testIds);
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(suites).values({ id, name: input.name, description: input.description ?? null });
          if (input.testIds.length > 0) {
            await tx.insert(suiteTests).values(input.testIds.map((testId, position) => ({ suiteId: id, testId, position })));
          }
        });
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw nameTaken();
        throw err;
      }
      await audit(db, {
        actorUserId: actor.userId,
        action: 'suite_created',
        targetType: 'suite',
        targetId: id,
        details: { name: input.name, tests: input.testIds.length },
      });
      return viewById(id);
    },

    /** Remplace la suite entière : nom, description et liste ordonnée (positions réécrites 0..n−1), dans une transaction. */
    async update(actor: Actor, id: string, input: SuiteInput): Promise<PublicSuite> {
      await viewById(id);
      await assertTestsExist(input.testIds);
      try {
        await db.transaction(async (tx) => {
          await tx.update(suites).set({ name: input.name, description: input.description ?? null }).where(eq(suites.id, id));
          await tx.delete(suiteTests).where(eq(suiteTests.suiteId, id));
          if (input.testIds.length > 0) {
            await tx.insert(suiteTests).values(input.testIds.map((testId, position) => ({ suiteId: id, testId, position })));
          }
        });
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw nameTaken();
        throw err;
      }
      await audit(db, {
        actorUserId: actor.userId,
        action: 'suite_updated',
        targetType: 'suite',
        targetId: id,
        details: { name: input.name, tests: input.testIds.length },
      });
      return viewById(id);
    },

    /** Copie la suite sous « <nom> (copie) », puis « (copie 2) », « (copie 3) »… selon les noms déjà pris. */
    async duplicate(actor: Actor, id: string): Promise<PublicSuite> {
      const [source] = await db.select().from(suites).where(eq(suites.id, id));
      if (!source) throw suiteNotFound();
      const members = await db.select().from(suiteTests).where(eq(suiteTests.suiteId, id)).orderBy(asc(suiteTests.position));
      const newId = randomUUID();
      const stem = (suffix: string) => `${source.name.slice(0, NAME_MAX - suffix.length)}${suffix}`;
      for (let n = 1; ; n++) {
        const name = stem(n === 1 ? ' (copie)' : ` (copie ${n})`);
        try {
          const [taken] = await db.select({ id: suites.id }).from(suites).where(eq(suites.name, name));
          if (taken) continue;
          await db.transaction(async (tx) => {
            await tx.insert(suites).values({ id: newId, name, description: source.description });
            if (members.length > 0) {
              await tx
                .insert(suiteTests)
                .values(members.map((m) => ({ suiteId: newId, testId: m.testId, position: m.position })));
            }
          });
        } catch (err) {
          if (errnoOf(err) === ER_DUP_ENTRY) continue; // nom pris entre-temps : on essaie le suivant
          throw err;
        }
        await audit(db, {
          actorUserId: actor.userId,
          action: 'suite_duplicated',
          targetType: 'suite',
          targetId: newId,
          details: { name, sourceId: id },
        });
        return viewById(newId);
      }
    },

    async remove(actor: Actor, id: string): Promise<'deleted'> {
      const [row] = await db.select().from(suites).where(eq(suites.id, id));
      if (!row) throw suiteNotFound();
      await db.delete(suites).where(eq(suites.id, id)); // `suite_tests` suit en cascade
      await audit(db, {
        actorUserId: actor.userId,
        action: 'suite_deleted',
        targetType: 'suite',
        targetId: id,
        details: { name: row.name },
      });
      return 'deleted';
    },
  };
}

export type SuitesService = ReturnType<typeof createSuitesService>;
