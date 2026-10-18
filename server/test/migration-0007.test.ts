import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { afterEach, expect, test } from 'vitest';
import { createDb, poolOf } from '../src/db/client.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { createEmptyTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

/** Copie des migrations arrêtée à la 0006 (journal tronqué) : la base est mise dans l'état d'avant les notes sur 100. */
async function foldersUpTo0006(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aic-migr-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 6);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

test('migration 0007 : colonnes élargies, notes sur 10 sauvegardées puis ×10, conversion rejouable sans ×100', async () => {
  const empty = await createEmptyTestDb();
  cleanups.push(empty.destroy);
  const { db, close } = createDb(empty.url);
  cleanups.push(close);
  await migrate(db, { migrationsFolder: await foldersUpTo0006() });

  const q = async (sql: string, params: unknown[] = []) => (await poolOf(db).query(sql, params))[0] as Record<string, unknown>[];
  const userId = randomUUID();
  const providerId = randomUUID();
  const modelId = randomUUID();
  const testId = randomUUID();
  const runId = randomUUID();
  const runTestId = randomUUID();
  await q(`INSERT INTO users (id, email, name, role, status) VALUES (?, 'a@example.test', 'A', 'admin', 'active')`, [userId]);
  await q(`INSERT INTO providers (id, name, type, base_url) VALUES (?, 'P', 'openai_compatible', 'https://p.example/v1')`, [providerId]);
  await q(`INSERT INTO models (id, provider_id, api_model_id, display_name, color) VALUES (?, ?, 'm', 'M', '#112233')`, [modelId, providerId]);
  await q(`INSERT INTO tests (id, name, category, tags, user_prompt, scoring_method, scoring_config) VALUES (?, 'T', 'C', '[]', 'P', 'manual', '{}')`, [testId]);
  await q(
    `INSERT INTO runs (id, name, repetitions, concurrency, status, weights, created_by) VALUES (?, 'R', 1, 4, 'completed', '{"quality":50,"speed":20,"cost":20,"reliability":10}', ?)`,
    [runId, userId],
  );
  await q(`INSERT INTO run_tests (id, run_id, test_id, position, snapshot) VALUES (?, ?, ?, 0, '{}')`, [runTestId, runId, testId]);
  const result = (rep: number, auto: number | null, override: number | null) => {
    const id = randomUUID();
    return q(
      `INSERT INTO results (id, run_id, run_test_id, model_id, repetition, status, auto_score, override_score) VALUES (?, ?, ?, ?, ?, 'done', ?, ?)`,
      [id, runId, runTestId, modelId, rep, auto, override],
    ).then(() => id);
  };
  const full = await result(1, 10, 9.25);
  const partial = await result(2, 6.67, null);
  const unscored = await result(3, null, null);
  const manualId = randomUUID();
  await q(`INSERT INTO manual_scores (id, result_id, user_id, score) VALUES (?, ?, ?, 7)`, [manualId, full, userId]);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const scores = async () =>
    Object.fromEntries(
      (await q('SELECT id, auto_score, override_score FROM results')).map((r) => [
        r.id,
        [r.auto_score === null ? null : Number(r.auto_score), r.override_score === null ? null : Number(r.override_score)],
      ]),
    );
  const manual = async () => Number((await q('SELECT score FROM manual_scores WHERE id = ?', [manualId]))[0]!.score);
  expect(await scores()).toEqual({ [full]: [100, 92.5], [partial]: [66.7, null], [unscored]: [null, null] });
  expect(await manual()).toBe(70);

  // Valeurs d'origine conservées pour un retour en arrière ; un résultat sans note n'est pas sauvegardé.
  const backup = await q('SELECT id, auto_score, override_score FROM score_backup_results_0007 ORDER BY auto_score');
  expect(backup.map((b) => [b.id, Number(b.auto_score), b.override_score === null ? null : Number(b.override_score)])).toEqual([
    [partial, 6.67, null],
    [full, 10, 9.25],
  ]);
  expect((await q('SELECT score FROM score_backup_manual_0007'))[0]!.score).toBe(7);

  // Rejouer les instructions de conversion (migration interrompue puis relancée) ne multiplie pas une seconde fois.
  const sql = await readFile(path.join(MIGRATIONS_FOLDER, '0007_notes_sur_100.sql'), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const body = statement.replace(/^\s*--.*$/gm, '').trim();
    if (body) await q(body);
  }
  expect(await scores()).toEqual({ [full]: [100, 92.5], [partial]: [66.7, null], [unscored]: [null, null] });
  expect(await manual()).toBe(70);
});
