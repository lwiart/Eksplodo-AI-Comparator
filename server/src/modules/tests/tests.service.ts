import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { NotFoundError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import { parseScoringConfig, type ScoringConfig, type ScoringMethod } from './scoring-config.js';
import { createTestsRepo, type AttachmentRow, type TestFilters, type TestRow } from './tests.repo.js';

export type TestInput = {
  name: string;
  category: string;
  tags: string[];
  systemPrompt: string | null;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  scoringMethod: ScoringMethod;
  /** Brute en entrée : validée et normalisée selon `scoringMethod`. */
  scoringConfig: unknown;
};

export type PublicAttachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  pages: number | null;
  sha256: string;
};

export type PublicTest = Omit<TestInput, 'scoringConfig'> & {
  scoringConfig: ScoringConfig;
  id: string;
  archivedAt: string | null;
  attachments: PublicAttachment[];
  usedInRuns: number;
  createdAt: string;
  updatedAt: string;
};

export type TestsServiceDeps = {
  db: Db;
  clock: Clock;
  config: Pick<AppConfig, 'dataDir'>;
};

const testNotFound = () => new NotFoundError('Test introuvable');

function publicAttachment(a: AttachmentRow): PublicAttachment {
  return { id: a.id, originalName: a.originalName, mime: a.mime, size: a.size, pages: a.pages, sha256: a.sha256 };
}

function publicTest(row: TestRow, attachments: AttachmentRow[], usedInRuns: number): PublicTest {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    tags: row.tags,
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    scoringMethod: row.scoringMethod,
    scoringConfig: row.scoringConfig,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    attachments: attachments.map(publicAttachment),
    usedInRuns,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createTestsService(deps: TestsServiceDeps) {
  const { db } = deps;
  const repo = createTestsRepo(db);

  async function view(rows: TestRow[]): Promise<PublicTest[]> {
    const ids = rows.map((r) => r.id);
    const [atts, used] = await Promise.all([repo.activeAttachments(ids), repo.usedInRuns(ids)]);
    return rows.map((r) =>
      publicTest(
        r,
        atts.filter((a) => a.testId === r.id),
        used.get(r.id) ?? 0,
      ),
    );
  }

  async function viewOne(row: TestRow): Promise<PublicTest> {
    return (await view([row]))[0]!;
  }

  async function require(id: string): Promise<TestRow> {
    const row = await repo.find(id);
    if (!row) throw testNotFound();
    return row;
  }

  /** Efface les fichiers d'un test (au mieux : un fichier déjà absent n'est pas une erreur). */
  async function removeFiles(testId: string, rows: AttachmentRow[]): Promise<void> {
    const root = path.resolve(deps.config.dataDir);
    const inside = (p: string) => p.startsWith(root + path.sep);
    await Promise.all(
      rows.map(async (a) => {
        const file = path.resolve(root, a.storagePath);
        if (inside(file)) await rm(file, { force: true }).catch(() => undefined);
      }),
    );
    const dir = path.resolve(root, 'attachments', testId);
    if (inside(dir)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    async list(filters: TestFilters = {}): Promise<PublicTest[]> {
      return view(await repo.list(filters));
    },

    async get(id: string): Promise<PublicTest> {
      return viewOne(await require(id));
    },

    async create(actor: Actor, input: TestInput): Promise<PublicTest> {
      const row = await repo.insert({
        id: randomUUID(),
        ...input,
        scoringConfig: parseScoringConfig(input.scoringMethod, input.scoringConfig),
      });
      await audit(db, {
        actorUserId: actor.userId,
        action: 'test_created',
        targetType: 'test',
        targetId: row.id,
        details: { name: row.name, category: row.category, scoringMethod: row.scoringMethod },
      });
      return viewOne(row);
    },

    async update(actor: Actor, id: string, input: TestInput): Promise<PublicTest> {
      await require(id);
      const row = await repo.update(id, { ...input, scoringConfig: parseScoringConfig(input.scoringMethod, input.scoringConfig) });
      if (!row) throw testNotFound();
      await audit(db, {
        actorUserId: actor.userId,
        action: 'test_updated',
        targetType: 'test',
        targetId: id,
        details: { name: row.name },
      });
      return viewOne(row);
    },

    /** Test utilisé par au moins une série : archivé ; sinon supprimé avec ses fichiers et retiré des suites. */
    async remove(actor: Actor, id: string): Promise<'deleted' | 'archived'> {
      const row = await require(id);
      const used = (await repo.usedInRuns([id])).get(id) ?? 0;
      if (used > 0) {
        if (row.archivedAt === null) await repo.update(id, { archivedAt: deps.clock() });
        await audit(db, {
          actorUserId: actor.userId,
          action: 'test_archived',
          targetType: 'test',
          targetId: id,
          details: { name: row.name, usedInRuns: used },
        });
        return 'archived';
      }
      const files = await repo.allAttachments(id);
      await repo.deleteWithDependents(id);
      await removeFiles(id, files);
      await audit(db, {
        actorUserId: actor.userId,
        action: 'test_deleted',
        targetType: 'test',
        targetId: id,
        details: { name: row.name },
      });
      return 'deleted';
    },

    async restore(actor: Actor, id: string): Promise<PublicTest> {
      await require(id);
      const row = await repo.update(id, { archivedAt: null });
      if (!row) throw testNotFound();
      await audit(db, {
        actorUserId: actor.userId,
        action: 'test_restored',
        targetType: 'test',
        targetId: id,
        details: { name: row.name },
      });
      return viewOne(row);
    },

    categories: () => repo.categories(),

    async tags(): Promise<string[]> {
      const all = new Set((await repo.tagLists()).flat());
      return [...all].sort((a, b) => a.localeCompare(b, 'fr'));
    },
  };
}

export type TestsService = ReturnType<typeof createTestsService>;
