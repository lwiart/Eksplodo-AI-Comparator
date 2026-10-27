import { and, eq, isNull, or } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { invitations, users } from '../../db/schema/core.js';
import { ConflictError, NotFoundError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import { normalizeEmail, type Actor, type Role } from '../auth/actor.js';
import type { PublicUser } from '../auth/auth.routes.js';
import {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  invitationLink,
  issueInvitation,
  type InvitationPurpose,
} from '../auth/invitations.js';
import { destroyUserSessions } from '../auth/sessions.js';
import type { Mailer } from '../mail/mailer.js';
import { invitationEmail, resetEmail } from '../mail/templates.js';
import { createUsersRepo, type UserRow } from './users.repo.js';
import { ER_DUP_ENTRY, ER_LOCK_DEADLOCK, errnoOf } from '../../lib/db-errors.js';

export type ErrorLogger = { error(obj: object, msg: string): void };
export type UsersServiceDeps = {
  db: Db;
  clock: Clock;
  mailer: Mailer;
  config: Pick<AppConfig, 'appBaseUrl'>;
};

export type PublicUserWithStatus = PublicUser & {
  status: 'invited' | 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
};
export type IssuedLink = { link: string; expiresAt: string; mail: 'sent' | 'failed' | 'not_configured' };

const MAX_DEADLOCK_RETRIES = 3;
const TTL_MS: Record<InvitationPurpose, number> = { invite: INVITE_TTL_MS, reset: RESET_TTL_MS };

function toPublicUser(u: UserRow): PublicUserWithStatus {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function createUsersService(deps: UsersServiceDeps) {
  const { db, clock, mailer, config } = deps;
  const usersRepo = createUsersRepo(db);

  async function loadTarget(id: string): Promise<UserRow> {
    const row = await usersRepo.findById(id);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Émet le lien, tente l'envoi et renvoie le lien quel que soit le résultat (jamais journalisé ni stocké en clair). */
  async function issueAndSend(user: UserRow, purpose: InvitationPurpose, log?: ErrorLogger): Promise<IssuedLink> {
    const now = clock();
    const token = await issueInvitation(db, user.id, purpose, now);
    const link = invitationLink(config, purpose, token);
    const expiresAt = new Date(now.getTime() + TTL_MS[purpose]).toISOString();
    if (!mailer.delivers) return { link, expiresAt, mail: 'not_configured' };
    const body =
      purpose === 'invite' ? invitationEmail({ name: user.name, link }) : resetEmail({ name: user.name, link });
    try {
      await mailer.send({ to: user.email, ...body });
      return { link, expiresAt, mail: 'sent' };
    } catch (err) {
      // Seul le nom de l'erreur est journalisé : ni le message (il peut citer le destinataire) ni le lien.
      log?.error({ err: { name: err instanceof Error ? err.name : 'UnknownError' }, purpose }, "échec de l'envoi de l'e-mail");
      return { link, expiresAt, mail: 'failed' };
    }
  }

  async function runWithDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (errnoOf(err) !== ER_LOCK_DEADLOCK || attempt >= MAX_DEADLOCK_RETRIES) throw err;
      }
    }
  }

  return {
    async listUsers(): Promise<PublicUserWithStatus[]> {
      return (await usersRepo.listAll()).map(toPublicUser);
    },

    async inviteUser(
      actor: Actor,
      input: { email: string; name: string; role: Role },
      log?: ErrorLogger,
    ): Promise<{ user: PublicUserWithStatus } & IssuedLink> {
      const email = normalizeEmail(input.email);
      const taken = () => new ConflictError('email_taken', 'Cette adresse e-mail est déjà utilisée.');
      if (await usersRepo.findByEmail(email)) throw taken();
      let user: UserRow;
      try {
        user = await usersRepo.insert({ email, name: input.name, role: input.role, status: 'invited' });
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw taken();
        throw err;
      }
      const issued = await issueAndSend(user, 'invite', log);
      await audit(db, {
        actorUserId: actor.userId,
        action: 'user_invited',
        targetType: 'user',
        targetId: user.id,
        details: { email: user.email, role: user.role, mail: issued.mail },
      });
      return { user: toPublicUser(user), ...issued };
    },

    async regenerateInvite(actor: Actor, id: string, log?: ErrorLogger): Promise<IssuedLink> {
      const target = await loadTarget(id);
      if (target.status !== 'invited') {
        throw new ConflictError('user_not_invited', "Ce compte n'est pas en attente d'invitation.");
      }
      const issued = await issueAndSend(target, 'invite', log);
      await audit(db, {
        actorUserId: actor.userId,
        action: 'invite_regenerated',
        targetType: 'user',
        targetId: id,
        details: { email: target.email, mail: issued.mail },
      });
      return issued;
    },

    async issueReset(actor: Actor, id: string, log?: ErrorLogger): Promise<IssuedLink> {
      const target = await loadTarget(id);
      if (target.status !== 'active') {
        throw new ConflictError('user_not_active', "La réinitialisation n'est possible que pour un compte actif.");
      }
      const issued = await issueAndSend(target, 'reset', log);
      await audit(db, {
        actorUserId: actor.userId,
        action: 'reset_issued',
        targetType: 'user',
        targetId: id,
        details: { email: target.email, mail: issued.mail },
      });
      return issued;
    },

    async updateUser(
      actor: Actor,
      id: string,
      patch: { role?: Role; status?: 'active' | 'disabled' },
    ): Promise<PublicUserWithStatus> {
      // Garde « dernier Admin actif » : verrous (SELECT … FOR UPDATE) sur la cible et sur tous les Admins actifs, relus et
      // comptés dans la même transaction que la mise à jour. Deux requêtes concurrentes se sérialisent donc sur ces
      // lignes et la seconde voit l'état déjà modifié par la première.
      const updated = await runWithDeadlockRetry(() =>
        db.transaction(async (tx) => {
          const locked = await tx
            .select()
            .from(users)
            .where(or(eq(users.id, id), and(eq(users.role, 'admin'), eq(users.status, 'active'))))
            .orderBy(users.id)
            .for('update');
          const target = locked.find((r) => r.id === id);
          if (!target) throw new NotFoundError();

          const newRole = patch.role ?? target.role;
          const newStatus = patch.status ?? target.status;
          if (patch.status === 'active' && target.status !== 'active' && target.passwordHash === null) {
            throw new ConflictError('user_not_activated', "Ce compte n'a pas encore été activé par son titulaire.");
          }
          const leavingAdmin =
            target.role === 'admin' && target.status === 'active' && (newRole !== 'admin' || newStatus !== 'active');
          if (leavingAdmin) {
            const otherActiveAdmins = locked.filter((r) => r.id !== id && r.role === 'admin' && r.status === 'active');
            if (otherActiveAdmins.length === 0) {
              throw new ConflictError('last_admin', 'Il doit rester au moins un administrateur actif.');
            }
          }

          const set: Partial<typeof users.$inferInsert> = {};
          if (patch.role !== undefined) set.role = patch.role;
          if (patch.status !== undefined) set.status = patch.status;
          if (Object.keys(set).length > 0) await tx.update(users).set(set).where(eq(users.id, id));
          // Un compte désactivé ne doit pas retrouver d'anciens liens valides à sa réactivation.
          if (patch.status === 'disabled') {
            await tx
              .update(invitations)
              .set({ usedAt: clock() })
              .where(and(eq(invitations.userId, id), isNull(invitations.usedAt)));
          }
          const rows = await tx.select().from(users).where(eq(users.id, id)).limit(1);
          await audit(tx, {
            actorUserId: actor.userId,
            action: 'user_updated',
            targetType: 'user',
            targetId: id,
            details: { from: { role: target.role, status: target.status }, to: { role: newRole, status: newStatus } },
          });
          return rows[0]!;
        }),
      );

      if (patch.status === 'disabled') await destroyUserSessions(db, id);
      return toPublicUser(updated);
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
