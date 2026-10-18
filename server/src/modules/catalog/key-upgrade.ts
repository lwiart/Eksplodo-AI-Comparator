import { and, eq, like } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { providers } from '../../db/schema/catalog.js';
import { decryptLegacySecret, encryptSecret } from '../../lib/crypto.js';
import { keyContext } from '../providers/registry.js';

export type KeyUpgradeResult = { upgraded: number; unreadable: number };

/**
 * Convertit les clés chiffrées à l'ancien format v1 (sans contexte) au format v2, lié au fournisseur
 * (voir `keyContext`). Une clé v1 indéchiffrable est laissée telle quelle : elle reste « illisible » et l'Admin
 * la ressaisit. Mise à jour conditionnelle (chiffré inchangé) : sûre si un autre processus convertit en même temps.
 * Appelé au démarrage sous le verrou ; idempotent.
 */
export async function upgradeLegacyKeys(db: Db, encryptionKey: Buffer): Promise<KeyUpgradeResult> {
  const rows = await db
    .select({ id: providers.id, baseUrl: providers.baseUrl, apiKeyEncrypted: providers.apiKeyEncrypted })
    .from(providers)
    .where(like(providers.apiKeyEncrypted, 'v1.%'));
  const result: KeyUpgradeResult = { upgraded: 0, unreadable: 0 };
  for (const row of rows) {
    const legacy = row.apiKeyEncrypted!;
    let plain: string;
    try {
      plain = decryptLegacySecret(legacy, encryptionKey);
    } catch {
      result.unreadable++;
      continue;
    }
    await db
      .update(providers)
      .set({ apiKeyEncrypted: encryptSecret(plain, encryptionKey, keyContext(row)) })
      .where(and(eq(providers.id, row.id), eq(providers.apiKeyEncrypted, legacy)));
    result.upgraded++;
  }
  return result;
}
