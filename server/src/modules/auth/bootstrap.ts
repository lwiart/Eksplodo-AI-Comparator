import { count, eq } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { users } from '../../db/schema/core.js';
import type { Clock } from '../../lib/clock.js';
import { hashPassword } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import { createUsersRepo } from '../users/users.repo.js';

export type BootstrapLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
export type BootstrapResult = 'created' | 'skipped';

const ER_DUP_ENTRY = 1062;
function isDupEntry(err: unknown): boolean {
  const e = err as { errno?: number; cause?: { errno?: number } };
  return (e.errno ?? e.cause?.errno) === ER_DUP_ENTRY;
}

/**
 * Crée le premier Admin (actif) depuis BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD s'il n'existe aucun
 * utilisateur `admin`, quel que soit son statut. Création et audit dans une seule transaction ; un doublon d'e-mail
 * (démarrage concurrent, ou e-mail déjà pris par un autre compte) donne `skipped`. Le mot de passe n'est jamais journalisé.
 */
export async function ensureBootstrapAdmin(deps: {
  db: Db;
  config: AppConfig;
  clock: Clock;
  logger?: BootstrapLogger;
}): Promise<BootstrapResult> {
  const { db, config, logger } = deps;
  const bootstrap = config.bootstrapAdmin;
  if (!bootstrap) return 'skipped';

  const [row] = await db.select({ n: count() }).from(users).where(eq(users.role, 'admin'));
  if (Number(row?.n ?? 0) > 0) return 'skipped';

  const passwordHash = await hashPassword(bootstrap.password);
  try {
    await db.transaction(async (tx) => {
      const admin = await createUsersRepo(tx as unknown as Db).insert({
        email: bootstrap.email,
        name: 'Admin',
        role: 'admin',
        status: 'active',
        passwordHash,
      });
      await audit(tx, {
        actorUserId: null,
        action: 'bootstrap_admin',
        targetType: 'user',
        targetId: admin.id,
        details: { email: admin.email },
      });
    });
  } catch (err) {
    if (isDupEntry(err)) {
      logger?.warn("Premier Admin non créé : l'e-mail de BOOTSTRAP_ADMIN_EMAIL existe déjà (autre démarrage ou autre compte)");
      return 'skipped';
    }
    throw err;
  }
  logger?.info(`Premier Admin créé (${bootstrap.email})`);
  return 'created';
}
