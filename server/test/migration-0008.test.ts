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

/** Copie des migrations arrêtée à la 0007 : la base est mise dans l'état d'avant le statut « tronquée ». */
async function foldersUpTo0007(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aic-migr-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 7);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

test('migration 0008 : réponses vides qui ont épuisé la limite requalifiées « tronquées », note retirée ; les autres intactes', async () => {
  const empty = await createEmptyTestDb();
  cleanups.push(empty.destroy);
  const { db, close } = createDb(empty.url);
  cleanups.push(close);
  await migrate(db, { migrationsFolder: await foldersUpTo0007() });

  const q = async (sql: string, params: unknown[] = []) => (await poolOf(db).query(sql, params))[0] as Record<string, unknown>[];
  const [userId, providerId, modelId, testId, runId, runTestId] = Array.from({ length: 6 }, () => randomUUID());
  await q(`INSERT INTO users (id, email, name, role, status) VALUES (?, 'a@example.test', 'A', 'admin', 'active')`, [userId]);
  await q(`INSERT INTO providers (id, name, type, base_url) VALUES (?, 'P', 'openai_compatible', 'https://p.example/v1')`, [providerId]);
  await q(`INSERT INTO models (id, provider_id, api_model_id, display_name, color) VALUES (?, ?, 'm', 'M', '#112233')`, [modelId, providerId]);
  await q(`INSERT INTO tests (id, name, category, tags, user_prompt, scoring_method, scoring_config) VALUES (?, 'T', 'C', '[]', 'P', 'judge', '{}')`, [testId]);
  await q(
    `INSERT INTO runs (id, name, repetitions, concurrency, status, weights, created_by) VALUES (?, 'R', 4, 4, 'completed', '{"quality":50,"speed":20,"cost":20,"reliability":10}', ?)`,
    [runId, userId],
  );
  await q(`INSERT INTO run_tests (id, run_id, test_id, position, snapshot) VALUES (?, ?, ?, 0, '{"maxTokens":1500}')`, [runTestId, runId, testId]);
  const result = async (rep: number, values: { text: string | null; finish: string | null; out: number; reasoning: number | null; auto: number | null }) => {
    const id = randomUUID();
    await q(
      `INSERT INTO results (id, run_id, run_test_id, model_id, repetition, status, response_text, finish_reason, output_tokens, reasoning_tokens, auto_score, score_status, judge_rationale)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, 'done', 'Réponse vide')`,
      [id, runId, runTestId, modelId, rep, values.text, values.finish, values.out, values.reasoning, values.auto],
    );
    return id;
  };
  const atLimit = await result(1, { text: '', finish: null, out: 0, reasoning: 1500, auto: 0 });
  const lengthFinish = await result(2, { text: null, finish: 'length', out: 1, reasoning: 200, auto: 0 });
  const real = await result(3, { text: 'Une vraie réponse', finish: 'length', out: 1500, reasoning: 0, auto: 70 });
  const emptyStop = await result(4, { text: '  ', finish: 'stop', out: 2, reasoning: 10, auto: 0 });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const row = async (id: string) => (await q('SELECT status, response_text, auto_score, score_status, judge_rationale, error_code, error_message FROM results WHERE id = ?', [id]))[0]!;
  for (const id of [atLimit, lengthFinish]) {
    expect(await row(id)).toMatchObject({
      status: 'truncated',
      response_text: null,
      auto_score: null,
      score_status: 'pending',
      judge_rationale: null,
      error_code: 'truncated',
    });
    expect(String((await row(id)).error_message)).toMatch(/^Aucun texte : la limite de 1500 tokens a été atteinte pendant la réflexion/);
  }
  // Vraie réponse coupée en cours de rédaction, ou réponse vide qui n'a pas atteint la limite : inchangées.
  expect(await row(real)).toMatchObject({ status: 'done', response_text: 'Une vraie réponse', error_code: null });
  expect(Number((await row(real)).auto_score)).toBe(70);
  expect(await row(emptyStop)).toMatchObject({ status: 'done', error_code: null });
});
