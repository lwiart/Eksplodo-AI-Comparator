import { sql } from 'drizzle-orm';
import { boolean, char, datetime, int, json, mysqlTable, text, uniqueIndex, varchar, index } from 'drizzle-orm/mysql-core';
import { users } from './core.js';
import { runs } from './runs.js';

const now = () => sql`CURRENT_TIMESTAMP(3)`;

/** Verdict rédigé par l'Admin, affiché sur la page publique (modèle désigné ou non). */
/** `auto` : verdict proposé automatiquement, recalculé à chaque affichage (modèle et phrase) ; absent : verdict figé. */
export type VerdictAuto = 'global' | 'quality' | 'cost';

export interface ShareVerdict {
  label: string;
  modelId: string | null;
  text: string;
  auto?: VerdictAuto;
}

/**
 * Liens de partage public d'une série. La page publique retrouve le lien par l'empreinte SHA-256 du jeton ; le jeton
 * lui-même est aussi gardé chiffré (AES-256-GCM, lié à l'identifiant du lien) pour que l'Admin puisse le recopier.
 * `tokenEncrypted` est nul pour les liens créés avant cette possibilité : les régénérer une fois.
 */
export const shareLinks = mysqlTable(
  'share_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    runId: char('run_id', { length: 36 })
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    tokenEncrypted: text('token_encrypted'),
    title: varchar('title', { length: 120 }).notNull(),
    intro: text('intro'),
    verdicts: json('verdicts').$type<ShareVerdict[]>().notNull(),
    showCosts: boolean('show_costs').notNull().default(false),
    showResponses: boolean('show_responses').notNull().default(false),
    active: boolean('active').notNull().default(true),
    viewCount: int('view_count').notNull().default(0),
    createdBy: char('created_by', { length: 36 }).references(() => users.id, { onDelete: 'set null' }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(now()),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(now())
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('share_links_token_hash_uq').on(t.tokenHash), index('share_links_run_idx').on(t.runId)],
);
