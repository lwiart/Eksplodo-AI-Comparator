import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { models } from './catalog.js';
import { users } from './core.js';
import type { TestSnapshot } from '../../modules/runs/snapshot.js';
import { suites, tests } from './tests.js';

const now = () => sql`CURRENT_TIMESTAMP(3)`;
const createdAt = () => datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(now());
/** Montants en $, lus et écrits en nombres. */
const money = (name: string) => decimal(name, { precision: 12, scale: 6, mode: 'number' });
const score = (name: string) => decimal(name, { precision: 4, scale: 2, mode: 'number' });
const date = (name: string) => datetime(name, { mode: 'date', fsp: 3 });

export interface RunWeights {
  quality: number;
  speed: number;
  cost: number;
  reliability: number;
}

export const runs = mysqlTable('runs', {
  id: char('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  suiteId: char('suite_id', { length: 36 }).references(() => suites.id, { onDelete: 'set null' }),
  judgeModelId: char('judge_model_id', { length: 36 }).references(() => models.id, { onDelete: 'restrict' }),
  repetitions: int('repetitions').notNull(),
  concurrency: int('concurrency').notNull(),
  budgetUsd: decimal('budget_usd', { precision: 10, scale: 4, mode: 'number' }),
  status: mysqlEnum('status', ['queued', 'running', 'paused', 'completed', 'interrupted']).notNull(),
  pauseReason: mysqlEnum('pause_reason', ['user', 'budget']),
  modelsCostUsd: money('models_cost_usd').notNull().default(0),
  judgeCostUsd: money('judge_cost_usd').notNull().default(0),
  weights: json('weights').$type<RunWeights>().notNull(),
  activeJobId: char('active_job_id', { length: 36 }),
  createdBy: char('created_by', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
  startedAt: date('started_at'),
  completedAt: date('completed_at'),
});

export const runModels = mysqlTable(
  'run_models',
  {
    runId: char('run_id', { length: 36 })
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    modelId: char('model_id', { length: 36 })
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    addedAt: datetime('added_at', { mode: 'date', fsp: 3 }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.runId, t.modelId] })],
);

export const runTests = mysqlTable('run_tests', {
  id: char('id', { length: 36 }).primaryKey(),
  runId: char('run_id', { length: 36 })
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  testId: char('test_id', { length: 36 })
    .notNull()
    .references(() => tests.id, { onDelete: 'restrict' }),
  position: int('position').notNull(),
  // Instantané du test au lancement (type TestSnapshot).
  snapshot: json('snapshot').$type<TestSnapshot>().notNull(),
});

export const results = mysqlTable(
  'results',
  {
    id: char('id', { length: 36 }).primaryKey(),
    runId: char('run_id', { length: 36 })
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    runTestId: char('run_test_id', { length: 36 })
      .notNull()
      .references(() => runTests.id, { onDelete: 'cascade' }),
    modelId: char('model_id', { length: 36 })
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    repetition: int('repetition').notNull(),
    status: mysqlEnum('status', ['pending', 'running', 'done', 'error', 'timeout', 'unsupported']).notNull(),
    attempts: int('attempts').notNull().default(0),
    responseText: mediumtext('response_text'),
    finishReason: varchar('finish_reason', { length: 20 }),
    inputTokens: int('input_tokens'),
    outputTokens: int('output_tokens'),
    reasoningTokens: int('reasoning_tokens'),
    tokensEstimated: boolean('tokens_estimated').notNull().default(false),
    ttftMs: int('ttft_ms'),
    totalMs: int('total_ms'),
    tokensPerS: decimal('tokens_per_s', { precision: 10, scale: 2, mode: 'number' }),
    costUsd: money('cost_usd'),
    costSource: mysqlEnum('cost_source', ['computed', 'provider']),
    errorCode: varchar('error_code', { length: 50 }),
    errorMessage: text('error_message'),
    scoreStatus: mysqlEnum('score_status', ['pending', 'done', 'awaiting_manual', 'judge_failed']).notNull().default('pending'),
    autoScore: score('auto_score'),
    judgeRationale: text('judge_rationale'),
    judgeCostUsd: money('judge_cost_usd'),
    overrideScore: score('override_score'),
    overrideBy: char('override_by', { length: 36 }),
    startedAt: date('started_at'),
    completedAt: date('completed_at'),
  },
  (t) => [
    uniqueIndex('results_run_test_model_rep_uq').on(t.runId, t.runTestId, t.modelId, t.repetition),
    index('results_run_status_idx').on(t.runId, t.status),
  ],
);

export const aiUsage = mysqlTable(
  'ai_usage',
  {
    id: char('id', { length: 36 }).primaryKey(),
    origin: mysqlEnum('origin', ['run', 'judge', 'quick_try']).notNull(),
    runId: char('run_id', { length: 36 }).references(() => runs.id, { onDelete: 'set null' }),
    modelId: char('model_id', { length: 36 })
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    inputTokens: int('input_tokens').notNull(),
    outputTokens: int('output_tokens').notNull(),
    reasoningTokens: int('reasoning_tokens').notNull(),
    costUsd: money('cost_usd').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);
