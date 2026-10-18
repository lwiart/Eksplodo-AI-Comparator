import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { runModels, runs } from '../../db/schema/runs.js';
import { shareLinks, type ShareVerdict } from '../../db/schema/sharing.js';
import { NotFoundError, ValidationError } from '../../errors.js';
import type { Actor } from '../auth/actor.js';
import { audit } from '../audit/audit.js';
import { readValue, writeValue } from '../settings/settings.repo.js';
import { newShareToken } from './token.js';

const AUDIT_URL_KEY = 'sharing.audit_url';
export const DEFAULT_AUDIT_URL = 'https://eksplodo.fr';

/** URL du bouton « Audit gratuit » de la page publique. */
export async function getAuditUrl(db: Db): Promise<string> {
  const value = await readValue(db, AUDIT_URL_KEY);
  return typeof value === 'string' && value !== '' ? value : DEFAULT_AUDIT_URL;
}

/** Enregistre l'URL « Audit gratuit » : `https://` obligatoire, 300 caractères au plus. */
export async function setAuditUrl(db: Db, actor: Actor, raw: string): Promise<string> {
  const auditUrl = raw.trim();
  let valid = auditUrl.length > 0 && auditUrl.length <= 300 && auditUrl.startsWith('https://');
  if (valid) {
    try {
      const url = new URL(auditUrl);
      valid = url.protocol === 'https:' && url.hostname !== '';
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new ValidationError('invalid_audit_url', 'L’URL doit commencer par https:// et tenir en 300 caractères');
  }
  await db.transaction(async (tx) => {
    await writeValue(tx as unknown as Db, AUDIT_URL_KEY, auditUrl);
    await audit(tx, {
      actorUserId: actor.userId,
      action: 'audit_url_changed',
      targetType: 'setting',
      targetId: AUDIT_URL_KEY,
      details: { auditUrl },
    });
  });
  return auditUrl;
}

const verdictSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    modelId: z.string().uuid().nullable(),
    text: z.string().max(500),
    auto: z.enum(['global', 'quality', 'cost']).optional(),
  })
  .strict();

const editableFields = {
  title: z.string().trim().min(1).max(120),
  intro: z.string().max(2000).nullish(),
  verdicts: z.array(verdictSchema).max(6),
  showCosts: z.boolean(),
  showResponses: z.boolean(),
};

export const createShareLinkBody = z.object({ runId: z.string().uuid(), ...editableFields }).strict();
export const updateShareLinkBody = z.object({ ...editableFields, active: z.boolean() }).strict();
export type CreateShareLinkInput = z.infer<typeof createShareLinkBody>;
export type UpdateShareLinkInput = z.infer<typeof updateShareLinkBody>;

/** Lien tel que vu par l'Admin : jamais l'empreinte du jeton. */
export interface ShareLinkView {
  id: string;
  runId: string;
  runName: string;
  title: string;
  intro: string | null;
  verdicts: ShareVerdict[];
  showCosts: boolean;
  showResponses: boolean;
  active: boolean;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

const notFound = () => new NotFoundError('Lien de partage introuvable');

export function createShareLinksService(deps: { db: Db }) {
  const { db } = deps;

  const select = () =>
    db.select({ link: shareLinks, runName: runs.name }).from(shareLinks).innerJoin(runs, eq(runs.id, shareLinks.runId));

  const toView = (row: { link: typeof shareLinks.$inferSelect; runName: string }): ShareLinkView => ({
    id: row.link.id,
    runId: row.link.runId,
    runName: row.runName,
    title: row.link.title,
    intro: row.link.intro,
    verdicts: row.link.verdicts,
    showCosts: row.link.showCosts,
    showResponses: row.link.showResponses,
    active: row.link.active,
    viewCount: row.link.viewCount,
    createdAt: row.link.createdAt.toISOString(),
    updatedAt: row.link.updatedAt.toISOString(),
  });

  async function view(id: string): Promise<ShareLinkView> {
    const [row] = await select().where(eq(shareLinks.id, id));
    if (!row) throw notFound();
    return toView(row);
  }

  /** Chaque verdict désignant un modèle doit viser un modèle de la série. */
  async function checkVerdicts(runId: string, verdicts: ShareVerdict[]): Promise<void> {
    const ids = [...new Set(verdicts.map((v) => v.modelId).filter((m): m is string => m !== null))];
    if (ids.length === 0) return;
    const rows = await db
      .select({ modelId: runModels.modelId })
      .from(runModels)
      .where(and(eq(runModels.runId, runId), inArray(runModels.modelId, ids)));
    if (rows.length !== ids.length) {
      throw new ValidationError('verdict_model_not_in_run', 'Le modèle du verdict ne fait pas partie de la série');
    }
  }

  return {
    async list(runId?: string): Promise<ShareLinkView[]> {
      const query = select();
      const rows = await (runId ? query.where(eq(shareLinks.runId, runId)) : query).orderBy(desc(shareLinks.createdAt));
      return rows.map(toView);
    },

    async create(actor: Actor, input: CreateShareLinkInput): Promise<{ link: ShareLinkView; token: string }> {
      const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, input.runId));
      if (!run) throw new NotFoundError('Série introuvable');
      await checkVerdicts(input.runId, input.verdicts);
      const id = randomUUID();
      const { token, hash } = newShareToken();
      await db.transaction(async (tx) => {
        await tx.insert(shareLinks).values({
          id,
          runId: input.runId,
          tokenHash: hash,
          title: input.title,
          intro: input.intro ? input.intro : null,
          verdicts: input.verdicts,
          showCosts: input.showCosts,
          showResponses: input.showResponses,
          createdBy: actor.userId,
        });
        await audit(tx, {
          actorUserId: actor.userId,
          action: 'share_link_created',
          targetType: 'share_link',
          targetId: id,
          details: { runId: input.runId, title: input.title },
        });
      });
      return { link: await view(id), token };
    },

    async update(actor: Actor, id: string, input: UpdateShareLinkInput): Promise<ShareLinkView> {
      const [existing] = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
      if (!existing) throw notFound();
      await checkVerdicts(existing.runId, input.verdicts);
      await db.transaction(async (tx) => {
        await tx
          .update(shareLinks)
          .set({
            title: input.title,
            intro: input.intro ? input.intro : null,
            verdicts: input.verdicts,
            showCosts: input.showCosts,
            showResponses: input.showResponses,
            active: input.active,
            updatedAt: new Date(),
          })
          .where(eq(shareLinks.id, id));
        await audit(tx, {
          actorUserId: actor.userId,
          action: 'share_link_updated',
          targetType: 'share_link',
          targetId: id,
          details: { active: input.active, showCosts: input.showCosts, showResponses: input.showResponses },
        });
      });
      return view(id);
    },

    /** Nouveau jeton : l'ancien lien cesse immédiatement de fonctionner. */
    async regenerate(actor: Actor, id: string): Promise<{ link: ShareLinkView; token: string }> {
      const [existing] = await db.select({ id: shareLinks.id }).from(shareLinks).where(eq(shareLinks.id, id));
      if (!existing) throw notFound();
      const { token, hash } = newShareToken();
      await db.transaction(async (tx) => {
        await tx.update(shareLinks).set({ tokenHash: hash, updatedAt: new Date() }).where(eq(shareLinks.id, id));
        await audit(tx, { actorUserId: actor.userId, action: 'share_link_regenerated', targetType: 'share_link', targetId: id });
      });
      return { link: await view(id), token };
    },

    async remove(actor: Actor, id: string): Promise<void> {
      const [existing] = await db
        .select({ id: shareLinks.id, title: shareLinks.title })
        .from(shareLinks)
        .where(eq(shareLinks.id, id));
      if (!existing) throw notFound();
      await db.transaction(async (tx) => {
        await tx.delete(shareLinks).where(eq(shareLinks.id, id));
        await audit(tx, {
          actorUserId: actor.userId,
          action: 'share_link_deleted',
          targetType: 'share_link',
          targetId: id,
          details: { title: existing.title },
        });
      });
    },
  };
}

export type ShareLinksService = ReturnType<typeof createShareLinksService>;
