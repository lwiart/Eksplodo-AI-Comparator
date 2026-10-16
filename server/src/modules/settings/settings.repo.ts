import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { settings } from '../../db/schema/core.js';

/** Valeur JSON d'un réglage global, ou `undefined` s'il n'existe pas. */
export async function readValue(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row?.value;
}

export async function writeValue(db: Db, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
}
