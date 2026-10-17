import { sql } from 'drizzle-orm';
import {
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
  varchar,
} from 'drizzle-orm/mysql-core';

const now = () => sql`CURRENT_TIMESTAMP(3)`;
const createdAt = () => datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(now());
const updatedAt = () =>
  datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(now())
    .$onUpdate(() => new Date());

export const tests = mysqlTable(
  'tests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    category: varchar('category', { length: 100 }).notNull(),
    tags: json('tags').$type<string[]>().notNull(),
    systemPrompt: mediumtext('system_prompt'),
    userPrompt: mediumtext('user_prompt').notNull(),
    temperature: decimal('temperature', { precision: 3, scale: 2, mode: 'number' }).notNull().default(0.2),
    maxTokens: int('max_tokens').notNull().default(1000),
    scoringMethod: mysqlEnum('scoring_method', ['judge', 'expected', 'manual']).notNull(),
    scoringConfig: json('scoring_config').$type<Record<string, unknown>>().notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tests_category_idx').on(t.category)],
);

export const testAttachments = mysqlTable('test_attachments', {
  id: char('id', { length: 36 }).primaryKey(),
  testId: char('test_id', { length: 36 })
    .notNull()
    .references(() => tests.id, { onDelete: 'cascade' }),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mime: mysqlEnum('mime', ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']).notNull(),
  size: int('size').notNull(),
  // Relatif à DATA_DIR ; jamais servi directement.
  storagePath: varchar('storage_path', { length: 500 }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  pages: int('pages'),
  deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
  createdAt: createdAt(),
});

export const suites = mysqlTable('suites', {
  id: char('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull().unique(),
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const suiteTests = mysqlTable(
  'suite_tests',
  {
    suiteId: char('suite_id', { length: 36 })
      .notNull()
      .references(() => suites.id, { onDelete: 'cascade' }),
    testId: char('test_id', { length: 36 })
      .notNull()
      .references(() => tests.id, { onDelete: 'restrict' }),
    position: int('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.suiteId, t.testId] })],
);
