import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { count } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { suiteTests, suites, testAttachments, tests } from '../../db/schema/tests.js';
import { APP_ROOT } from '../../lib/paths.js';
import { readValue, writeValue } from '../settings/settings.repo.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TEST, resolveAttachmentPath } from './attachments.js';
import { countPdfPages, detectFileType } from './filetype.js';
import { parseScoringConfig } from './scoring-config.js';

/**
 * Jeu de première installation livré avec l'application (`npm run export:tests` le produit) : `tests.json` (fournisseurs
 * sans clé, modèles, tests, suites) et les pièces jointes des tests.
 */
export const SEED_DIR = path.join(APP_ROOT, 'server', 'seed');
const SEEDED_SETTING = 'tests.seeded_at';
const MODELS_SEEDED_SETTING = 'models.seeded_at';

const seedFile = z.object({
  version: z.literal(1),
  /** Fournisseurs à créer s'ils n'existent pas (jamais de clé : elle se saisit dans l'interface). */
  providers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        type: z.enum(['openai_compatible', 'anthropic', 'google']),
        baseUrl: z.string().url().max(500),
        maxConcurrency: z.number().int().min(1).max(20).default(2),
      }),
    )
    .default([]),
  /** Modèles, rattachés à leur fournisseur par son nom. */
  models: z
    .array(
      z.object({
        provider: z.string().min(1),
        apiModelId: z.string().trim().min(1).max(200),
        displayName: z.string().trim().min(1).max(200),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        inputPricePerM: z.number().min(0).default(0),
        outputPricePerM: z.number().min(0).default(0),
        priceSource: z.enum(['manual', 'openrouter']).default('manual'),
        supportsVision: z.boolean().default(false),
        supportsPdf: z.boolean().default(false),
        contextWindow: z.number().int().positive().nullable().default(null),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  tests: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
        systemPrompt: z.string().max(50_000).nullable().default(null),
        userPrompt: z.string().min(1).max(100_000),
        temperature: z.number().min(0).max(2).default(0.2),
        maxTokens: z.number().int().min(1).max(50_000).default(1000),
        scoringMethod: z.enum(['judge', 'expected', 'manual']),
        scoringConfig: z.unknown(),
        /** Chemins relatifs au dossier du jeu (ex. `attachments/03-1.png`). */
        attachments: z
          .array(z.object({ file: z.string().min(1), originalName: z.string().min(1).max(255) }))
          .max(MAX_ATTACHMENTS_PER_TEST)
          .default([]),
      }),
    )
    .max(1000)
    .default([]),
  suites: z
    .array(z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(5_000).nullable().default(null), tests: z.array(z.string()) }))
    .default([]),
});
export type SeedFile = z.input<typeof seedFile>;

export type SeedResult = { status: 'seeded'; tests: number; suites: number } | { status: 'skipped' | 'absent' };

/** Jeu lu et validé, ou `null` sans fichier `tests.json`. */
async function loadSeed(seedDir: string): Promise<z.output<typeof seedFile> | null> {
  try {
    return seedFile.parse(JSON.parse(await readFile(path.join(seedDir, 'tests.json'), 'utf8')));
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
}

export type ModelsSeedResult = { status: 'seeded'; providers: number; models: number } | { status: 'skipped' | 'absent' };

/**
 * Crée les fournisseurs (sans clé) et les modèles du jeu livré, une seule fois dans la vie de la base (réglage
 * `models.seeded_at`) et seulement si elle n'a encore aucun modèle. Un fournisseur de même nom n'est jamais modifié ; un
 * modèle dont le fournisseur est absent est ignoré. Appelé sous le verrou de démarrage, après les fournisseurs préconfigurés.
 */
export async function seedModels(deps: { db: Db; now: Date; seedDir?: string }): Promise<ModelsSeedResult> {
  const { db } = deps;
  if ((await readValue(db, MODELS_SEEDED_SETTING)) !== undefined) return { status: 'skipped' };
  const [existing] = await db.select({ n: count() }).from(models);
  if (Number(existing!.n) > 0) {
    await writeValue(db, MODELS_SEEDED_SETTING, deps.now.toISOString());
    return { status: 'skipped' };
  }
  const seed = await loadSeed(deps.seedDir ?? SEED_DIR);
  if (!seed) return { status: 'absent' };
  let providersAdded = 0;
  let modelsAdded = 0;
  await db.transaction(async (tx) => {
    const known = new Map((await tx.select({ id: providers.id, name: providers.name }).from(providers)).map((p) => [p.name, p.id]));
    for (const p of seed.providers) {
      if (known.has(p.name)) continue;
      const id = randomUUID();
      await tx.insert(providers).values({ id, name: p.name, type: p.type, baseUrl: p.baseUrl, maxConcurrency: p.maxConcurrency });
      known.set(p.name, id);
      providersAdded++;
    }
    const rows = seed.models.flatMap((m) => {
      const providerId = known.get(m.provider);
      if (!providerId) return [];
      const { provider: _name, ...fields } = m;
      return [{ id: randomUUID(), providerId, ...fields }];
    });
    if (rows.length > 0) {
      await tx.insert(models).ignore().values(rows);
      modelsAdded = rows.length;
    }
    await writeValue(tx as unknown as Db, MODELS_SEEDED_SETTING, deps.now.toISOString());
  });
  return { status: 'seeded', providers: providersAdded, models: modelsAdded };
}

/** Chemin d'une pièce jointe du jeu, sans sortir de son dossier. */
function seedPath(seedDir: string, file: string): string {
  const full = path.resolve(seedDir, file);
  if (!full.startsWith(path.resolve(seedDir) + path.sep)) throw new Error(`Jeu de tests : chemin refusé (${file})`);
  return full;
}

/**
 * Crée les tests et suites du jeu livré, une seule fois dans la vie de la base (réglage `tests.seeded_at`), et seulement
 * si elle n'a encore aucun test : une installation existante n'est jamais modifiée, et un test supprimé ensuite par
 * l'Admin n'est pas recréé. Sans fichier `tests.json`, rien n'est fait. Appelé sous le verrou de démarrage.
 */
export async function seedTests(deps: { db: Db; dataDir: string; now: Date; seedDir?: string }): Promise<SeedResult> {
  const { db } = deps;
  const seedDir = deps.seedDir ?? SEED_DIR;
  if ((await readValue(db, SEEDED_SETTING)) !== undefined) return { status: 'skipped' };
  const [existing] = await db.select({ n: count() }).from(tests);
  if (Number(existing!.n) > 0) {
    await writeValue(db, SEEDED_SETTING, deps.now.toISOString());
    return { status: 'skipped' };
  }

  const seed = await loadSeed(seedDir);
  if (!seed) return { status: 'absent' };

  // Fichiers écrits d'abord, puis les lignes en une transaction ; en cas d'échec, les fichiers écrits sont retirés.
  const written: string[] = [];
  const idByName = new Map<string, string>();
  try {
    const testRows: (typeof tests.$inferInsert)[] = [];
    const attachmentRows: (typeof testAttachments.$inferInsert)[] = [];
    for (const t of seed.tests) {
      const id = randomUUID();
      idByName.set(t.name, id);
      testRows.push({
        id,
        name: t.name,
        category: t.category,
        tags: t.tags,
        systemPrompt: t.systemPrompt,
        userPrompt: t.userPrompt,
        temperature: t.temperature,
        maxTokens: t.maxTokens,
        scoringMethod: t.scoringMethod,
        scoringConfig: parseScoringConfig(t.scoringMethod, t.scoringConfig),
      });
      for (const a of t.attachments) {
        const content = await readFile(seedPath(seedDir, a.file));
        if (content.length > MAX_ATTACHMENT_BYTES) throw new Error(`Jeu de tests : ${a.file} dépasse 10 Mo`);
        const mime = detectFileType(content.subarray(0, 16));
        if (mime === null) throw new Error(`Jeu de tests : type de fichier non pris en charge (${a.file})`);
        const attachmentId = randomUUID();
        const relative = path.posix.join('attachments', id, attachmentId);
        const dest = resolveAttachmentPath(deps.dataDir, relative);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, content);
        written.push(path.dirname(dest));
        attachmentRows.push({
          id: attachmentId,
          testId: id,
          originalName: a.originalName,
          mime,
          size: content.length,
          storagePath: relative,
          sha256: createHash('sha256').update(content).digest('hex'),
          pages: mime === 'application/pdf' ? countPdfPages(content) : null,
        });
      }
    }
    let suiteCount = 0;
    await db.transaction(async (tx) => {
      if (testRows.length > 0) await tx.insert(tests).values(testRows);
      if (attachmentRows.length > 0) await tx.insert(testAttachments).values(attachmentRows);
      for (const s of seed.suites) {
        const ids = s.tests.map((name) => idByName.get(name)).filter((id): id is string => id !== undefined);
        const suiteId = randomUUID();
        await tx.insert(suites).values({ id: suiteId, name: s.name, description: s.description });
        if (ids.length > 0) await tx.insert(suiteTests).values(ids.map((testId, position) => ({ suiteId, testId, position })));
        suiteCount++;
      }
      await writeValue(tx as unknown as Db, SEEDED_SETTING, deps.now.toISOString());
    });
    return { status: 'seeded', tests: testRows.length, suites: suiteCount };
  } catch (err) {
    await Promise.all(written.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    throw err;
  }
}
