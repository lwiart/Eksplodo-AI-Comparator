import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, openrouterCatalog, providers } from '../../db/schema/catalog.js';
import type { JobHandler } from '../jobs/queue.js';
import { isOpenRouter, parseOpenRouterModels } from '../providers/openrouter.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type RefreshDeps = { db: Db; fetch?: typeof fetch; now: Date; signal?: AbortSignal };
export type RefreshResult = { added: number; updated: number; initial: boolean; localPricesUpdated: number };

async function download(deps: RefreshDeps) {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const res = await (deps.fetch ?? fetch)(OPENROUTER_MODELS_URL, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue OpenRouter : réponse HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('Catalogue OpenRouter : réponse illisible (JSON attendu)');
  }
  // Une réponse sans tableau `data` (ou vide) n'est jamais prise pour un catalogue valide.
  const data = typeof json === 'object' && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error('Catalogue OpenRouter : réponse inattendue (tableau « data » absent)');
  const parsed = parseOpenRouterModels(json);
  if (parsed.length === 0) throw new Error('Catalogue OpenRouter : aucun modèle exploitable dans la réponse');
  return parsed;
}

/**
 * Synchronise le catalogue public d'OpenRouter. Toute erreur (réseau, HTTP, réponse invalide) est levée avant la moindre
 * écriture : la file réessaie et une première synchronisation échouée ne compte pas comme faite.
 */
export async function refreshOpenRouterCatalog(deps: RefreshDeps): Promise<RefreshResult> {
  const remote = await download(deps);
  const byId = new Map(remote.map((m) => [m.id, m]));
  const { now } = deps;

  return deps.db.transaction(async (tx) => {
    const known = new Map(
      (await tx.select({ id: openrouterCatalog.id, openrouterId: openrouterCatalog.openrouterId }).from(openrouterCatalog)).map((r) => [
        r.openrouterId,
        r.id,
      ]),
    );
    const initial = known.size === 0;
    let added = 0;
    let updated = 0;

    for (const m of byId.values()) {
      // Modalités reconstituées des deux indicateurs retenus : texte toujours, image et fichier si annoncés.
      const inputModalities = ['text', ...(m.supportsVision ? ['image'] : []), ...(m.supportsPdf ? ['file'] : [])];
      const values = {
        name: m.name.slice(0, 300),
        inputPricePerM: m.inputPricePerM,
        outputPricePerM: m.outputPricePerM,
        inputModalities,
        contextWindow: m.contextWindow,
        lastSeenAt: now,
      };
      const existingId = known.get(m.id);
      if (existingId) {
        await tx.update(openrouterCatalog).set(values).where(eq(openrouterCatalog.id, existingId));
        updated++;
      } else {
        await tx
          .insert(openrouterCatalog)
          .values({ id: randomUUID(), openrouterId: m.id, ...values, initialSync: initial, firstSeenAt: now });
        added++;
      }
    }

    // Prix des modèles locaux des fournisseurs OpenRouter dont la source est « openrouter » (jamais ceux saisis à la main).
    const orProviders = (await tx.select({ id: providers.id, baseUrl: providers.baseUrl }).from(providers))
      .filter((p) => isOpenRouter(p.baseUrl))
      .map((p) => p.id);
    let localPricesUpdated = 0;
    if (orProviders.length > 0) {
      const locals = await tx
        .select()
        .from(models)
        .where(and(inArray(models.providerId, orProviders), eq(models.priceSource, 'openrouter')));
      for (const local of locals) {
        const m = byId.get(local.apiModelId);
        if (!m) continue;
        const patch: { inputPricePerM?: number; outputPricePerM?: number } = {};
        if (m.inputPricePerM !== null && m.inputPricePerM !== local.inputPricePerM) patch.inputPricePerM = m.inputPricePerM;
        if (m.outputPricePerM !== null && m.outputPricePerM !== local.outputPricePerM) patch.outputPricePerM = m.outputPricePerM;
        if (Object.keys(patch).length === 0) continue;
        await tx.update(models).set(patch).where(eq(models.id, local.id));
        localPricesUpdated++;
      }
    }

    return { added, updated, initial, localPricesUpdated };
  });
}

/** Gestionnaire de la tâche quotidienne `catalog_refresh`. */
export function createCatalogRefreshHandler(deps: { fetch?: typeof fetch }): JobHandler {
  return async (_job, ctx) => {
    await refreshOpenRouterCatalog({ db: ctx.db, ...(deps.fetch ? { fetch: deps.fetch } : {}), now: ctx.now(), signal: ctx.signal });
  };
}
