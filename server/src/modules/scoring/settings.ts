import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { settings } from '../../db/schema/core.js';
import { models } from '../../db/schema/catalog.js';
import { ValidationError } from '../../errors.js';
import type { Actor } from '../auth/actor.js';
import { audit } from '../audit/audit.js';
import { readValue, writeValue } from '../settings/settings.repo.js';

const DEFAULT_JUDGE_KEY = 'scoring.default_judge_model_id';

/** Modèle juge proposé par défaut à l'assistant de lancement, ou `null`. */
export async function getDefaultJudge(db: Db): Promise<string | null> {
  const value = await readValue(db, DEFAULT_JUDGE_KEY);
  return typeof value === 'string' ? value : null;
}

/** Définit (ou retire avec `null`) le juge par défaut ; le modèle doit exister et être actif. */
export async function setDefaultJudge(db: Db, actor: Actor, modelId: string | null): Promise<string | null> {
  if (modelId !== null) {
    const [model] = await db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.id, modelId), eq(models.enabled, true)));
    if (!model) throw new ValidationError('model_not_found', 'Modèle introuvable ou désactivé');
  }
  // Colonne JSON non nulle : retirer le juge supprime le réglage.
  if (modelId === null) await db.delete(settings).where(eq(settings.key, DEFAULT_JUDGE_KEY));
  else await writeValue(db, DEFAULT_JUDGE_KEY, modelId);
  await audit(db, {
    actorUserId: actor.userId,
    action: 'default_judge_changed',
    targetType: 'setting',
    targetId: DEFAULT_JUDGE_KEY,
    details: { modelId },
  });
  return modelId;
}
