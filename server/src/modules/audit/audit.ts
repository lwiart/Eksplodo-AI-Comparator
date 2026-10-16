import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client.js';
import { auditLog } from '../../db/schema/core.js';
import type { DbOrTx } from '../auth/invitations.js';

export type AuditEvent = {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string;
  /** Jamais de secret ni de jeton ici. */
  details?: unknown;
};

/** Écrit une ligne du journal d'audit (accepte aussi une transaction). */
export async function audit(db: Db | DbOrTx, e: AuditEvent): Promise<void> {
  await db.insert(auditLog).values({
    id: randomUUID(),
    actorUserId: e.actorUserId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    details: e.details ?? null,
  });
}
