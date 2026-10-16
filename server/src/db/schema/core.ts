import { sql } from 'drizzle-orm';
import { char, datetime, int, json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

const now = () => sql`CURRENT_TIMESTAMP(3)`;
const createdAt = () => datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(now());

export const users = mysqlTable('users', {
  id: char('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  role: mysqlEnum('role', ['admin', 'user']).notNull(),
  status: mysqlEnum('status', ['invited', 'active', 'disabled']).notNull().default('invited'),
  failedLoginCount: int('failed_login_count').notNull().default(0),
  lockedUntil: datetime('locked_until', { mode: 'date', fsp: 3 }),
  lastLoginAt: datetime('last_login_at', { mode: 'date', fsp: 3 }),
  createdAt: createdAt(),
});

export const invitations = mysqlTable('invitations', {
  id: char('id', { length: 36 }).primaryKey(),
  userId: char('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  purpose: mysqlEnum('purpose', ['invite', 'reset']).notNull(),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
  createdAt: createdAt(),
});

export const sessions = mysqlTable('sessions', {
  idHash: char('id_hash', { length: 64 }).primaryKey(),
  userId: char('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  createdAt: createdAt(),
  ip: varchar('ip', { length: 64 }).notNull(),
  userAgent: varchar('user_agent', { length: 400 }).notNull(),
});

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: json('value').notNull(),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(now())
    .$onUpdate(() => new Date()),
});

export const auditLog = mysqlTable('audit_log', {
  id: char('id', { length: 36 }).primaryKey(),
  actorUserId: char('actor_user_id', { length: 36 }),
  action: varchar('action', { length: 100 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: varchar('target_id', { length: 36 }),
  details: json('details'),
  createdAt: createdAt(),
});
