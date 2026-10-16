import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { invitations, users } from '../../db/schema/core.js';
import { ValidationError } from '../../errors.js';
import { generateToken, hashToken } from '../../lib/crypto.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export type InvitationPurpose = 'invite' | 'reset';

export const INVITE_TTL_MS = 72 * 3600_000;
export const RESET_TTL_MS = 24 * 3600_000;
const TTL_MS: Record<InvitationPurpose, number> = { invite: INVITE_TTL_MS, reset: RESET_TTL_MS };

const ER_CHECKREAD = 1020;
function errnoOf(err: unknown): number | undefined {
  const e = err as { errno?: number; cause?: { errno?: number } };
  return e.errno ?? e.cause?.errno;
}
const invalidToken = () => new ValidationError('invitation_invalid', 'Lien invalide ou expiré.');

/** Lien à envoyer par e-mail : `/invitation/<jeton>` (invitation) ou `/reinitialiser/<jeton>` (réinitialisation). */
export function invitationLink(config: Pick<AppConfig, 'appBaseUrl'>, purpose: InvitationPurpose, token: string): string {
  return `${config.appBaseUrl}/${purpose === 'invite' ? 'invitation' : 'reinitialiser'}/${token}`;
}

/** Crée un jeton à usage unique (stocké haché) et marque comme utilisés les jetons non utilisés de même finalité pour cet utilisateur. */
export async function issueInvitation(
  db: DbOrTx,
  userId: string,
  purpose: InvitationPurpose,
  now: Date,
): Promise<string> {
  const { token, hash } = generateToken();
  // Sur une transaction existante, Drizzle ouvre un point de sauvegarde imbriqué.
  await (db as Db).transaction(async (tx) => {
    await tx
      .update(invitations)
      .set({ usedAt: now })
      .where(
        and(
          eq(invitations.userId, userId),
          eq(invitations.purpose, purpose),
          isNull(invitations.usedAt),
        ),
      );
    await tx.insert(invitations).values({
      id: randomUUID(),
      userId,
      tokenHash: hash,
      purpose,
      expiresAt: new Date(now.getTime() + TTL_MS[purpose]),
    });
  });
  return token;
}

/**
 * Vérification préalable, sans consommation : le jeton existe, a la bonne finalité, n'est ni utilisé ni expiré, et
 * son titulaire n'est pas désactivé. Sinon invalid_token. Permet de refuser un jeton invalide AVANT le hachage argon2
 * (coûteux) du nouveau mot de passe ; la consommation atomique (`redeemInvitation`) refait toutes ces vérifications.
 */
export async function assertInvitationRedeemable(
  db: DbOrTx,
  token: string,
  purpose: InvitationPurpose,
  now: Date,
): Promise<void> {
  const rows = await db
    .select({ id: invitations.id })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        eq(invitations.purpose, purpose),
        isNull(invitations.usedAt),
        gt(invitations.expiresAt, now),
        ne(users.status, 'disabled'),
      ),
    )
    .limit(1);
  if (rows.length === 0) throw invalidToken();
}

/** Consomme le jeton de façon atomique : de deux requêtes concurrentes, une seule réussit. */
export async function consumeInvitation(
  db: DbOrTx,
  token: string,
  purpose: InvitationPurpose,
  now: Date,
): Promise<{ userId: string }> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select({ userId: invitations.userId, userStatus: users.status })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(and(eq(invitations.tokenHash, tokenHash), eq(invitations.purpose, purpose)))
    .limit(1);
  const row = rows[0];
  if (!row || row.userStatus === 'disabled') throw invalidToken();

  let affected: number;
  try {
    const [res] = await db
      .update(invitations)
      .set({ usedAt: now })
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.purpose, purpose),
          isNull(invitations.usedAt),
          gt(invitations.expiresAt, now),
        ),
      );
    affected = res.affectedRows;
  } catch (err) {
    // MariaDB (REPEATABLE READ) : le jeton a été consommé par une requête concurrente depuis la lecture de la transaction.
    if (errnoOf(err) === ER_CHECKREAD) throw invalidToken();
    throw err;
  }
  if (affected !== 1) throw invalidToken();
  return { userId: row.userId };
}

/**
 * Consomme le jeton ET applique `apply` dans une seule transaction : si `apply` lève, le jeton reste utilisable.
 * `apply` doit exécuter ses écritures sur la transaction reçue.
 */
export async function redeemInvitation(
  db: Db,
  token: string,
  purpose: InvitationPurpose,
  now: Date,
  apply: (tx: Tx, userId: string) => Promise<void>,
): Promise<{ userId: string }> {
  return db.transaction(async (tx) => {
    const { userId } = await consumeInvitation(tx, token, purpose, now);
    await apply(tx, userId);
    return { userId };
  });
}

/** Met à jour l'utilisateur sauf s'il est désactivé (désactivation concurrente) ; sinon invalid_token et annulation. */
export async function updateUserUnlessDisabled(
  tx: DbOrTx,
  userId: string,
  patch: Partial<typeof users.$inferInsert>,
): Promise<void> {
  try {
    const [res] = await tx
      .update(users)
      .set(patch)
      .where(and(eq(users.id, userId), ne(users.status, 'disabled')));
    if (res.affectedRows !== 1) throw invalidToken();
  } catch (err) {
    // MariaDB (REPEATABLE READ) : la ligne a changé depuis la lecture de la transaction (ex. désactivation concurrente).
    if (errnoOf(err) === ER_CHECKREAD) throw invalidToken();
    throw err;
  }
}
