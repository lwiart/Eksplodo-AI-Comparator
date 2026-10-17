import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const now = () => sql`CURRENT_TIMESTAMP(3)`;
const createdAt = () => datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(now());
const updatedAt = () =>
  datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(now())
    .$onUpdate(() => new Date());
/** Prix en $ par million de tokens, lus et écrits en nombres. */
const price = (name: string) => decimal(name, { precision: 10, scale: 4, mode: 'number' });

export const providers = mysqlTable('providers', {
  id: char('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  type: mysqlEnum('type', ['openai_compatible', 'anthropic', 'google']).notNull(),
  baseUrl: varchar('base_url', { length: 500 }).notNull(),
  // Clé chiffrée (AES-256-GCM, APP_ENCRYPTION_KEY) ; jamais de clé en clair.
  apiKeyEncrypted: text('api_key_encrypted'),
  apiKeyLast4: varchar('api_key_last4', { length: 4 }),
  maxConcurrency: int('max_concurrency').notNull().default(2),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const models = mysqlTable(
  'models',
  {
    id: char('id', { length: 36 }).primaryKey(),
    providerId: char('provider_id', { length: 36 })
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    apiModelId: varchar('api_model_id', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    color: char('color', { length: 7 }).notNull(),
    inputPricePerM: price('input_price_per_m').notNull().default(0),
    outputPricePerM: price('output_price_per_m').notNull().default(0),
    priceSource: mysqlEnum('price_source', ['manual', 'openrouter']).notNull().default('manual'),
    supportsVision: boolean('supports_vision').notNull().default(false),
    supportsPdf: boolean('supports_pdf').notNull().default(false),
    contextWindow: int('context_window'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('models_provider_api_model_uq').on(t.providerId, t.apiModelId)],
);

export const openrouterCatalog = mysqlTable(
  'openrouter_catalog',
  {
    id: char('id', { length: 36 }).primaryKey(),
    openrouterId: varchar('openrouter_id', { length: 200 }).notNull().unique(),
    name: varchar('name', { length: 300 }).notNull(),
    inputPricePerM: price('input_price_per_m'),
    outputPricePerM: price('output_price_per_m'),
    inputModalities: json('input_modalities').$type<string[]>().notNull(),
    contextWindow: int('context_window'),
    // Ajoutée par la première synchronisation : jamais présentée comme une nouveauté.
    initialSync: boolean('initial_sync').notNull().default(false),
    firstSeenAt: datetime('first_seen_at', { mode: 'date', fsp: 3 }).notNull(),
    lastSeenAt: datetime('last_seen_at', { mode: 'date', fsp: 3 }).notNull(),
    dismissedAt: datetime('dismissed_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [index('openrouter_catalog_first_seen_idx').on(t.firstSeenAt)],
);
