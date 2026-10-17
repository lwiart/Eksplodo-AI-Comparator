import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { openrouterCatalog } from '../../db/schema/catalog.js';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { AppError, ConflictError, NotFoundError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import { isOpenRouter } from '../providers/openrouter.js';
import { ProviderError } from '../providers/errors.js';
import { KeyMissingError, KeyUnreadableError, sealApiKey, type KeyState, type Registry } from '../providers/registry.js';
import type { RemoteModel } from '../providers/types.js';
import { KNOWN_PRICES } from './known-prices.js';
import { createModelsRepo, type ModelPatch, type ModelRow } from './models.repo.js';
import { createProvidersRepo, type ProviderPatch, type ProviderRow } from './providers.repo.js';

export type ProviderType = ProviderRow['type'];

export type PublicProvider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  maxConcurrency: number;
  enabled: boolean;
  keyState: KeyState;
  /** Les 4 derniers caractères de la clé : réservés à l'Admin (`null` pour un Utilisateur). */
  keyLast4: string | null;
  usable: boolean;
  fake: boolean;
  modelCount: number;
};

export type PublicModel = {
  id: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  apiModelId: string;
  displayName: string;
  color: string;
  inputPricePerM: number;
  outputPricePerM: number;
  priceSource: ModelRow['priceSource'];
  supportsVision: boolean;
  supportsPdf: boolean;
  contextWindow: number | null;
  enabled: boolean;
  /** Modèle et fournisseur actifs et fournisseur utilisable : seul critère de sélection d'un modèle. */
  available: boolean;
  createdAt: string;
};

export type NewModel = {
  id: string;
  openrouterId: string;
  name: string;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  supportsVision: boolean;
  supportsPdf: boolean;
  contextWindow: number | null;
  firstSeenAt: string;
};

export type RemoteModelView = RemoteModel & { alreadyAdded: boolean };

export type ConnectionTest =
  | { ok: true; modelCount: number; latencyMs: number }
  | { ok: false; code: string; message: string };

export type ProviderInput = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  maxConcurrency?: number;
  apiKey?: string;
};
/** `apiKey: string` remplace la clé, `apiKey: null` la supprime. */
export type ProviderUpdate = Partial<Omit<ProviderInput, 'apiKey'>> & { enabled?: boolean; apiKey?: string | null };

export type ModelInput = {
  providerId: string;
  apiModelId: string;
  displayName: string;
  color?: string;
  inputPricePerM?: number;
  outputPricePerM?: number;
  priceSource?: ModelRow['priceSource'];
  supportsVision?: boolean;
  supportsPdf?: boolean;
  contextWindow?: number | null;
  enabled?: boolean;
};
export type ModelUpdate = ModelPatch;  // `priceSource` : voir `updateModel`

export type CatalogServiceDeps = {
  db: Db;
  registry: Registry;
  clock: Clock;
  config: Pick<AppConfig, 'encryptionKey'>;
};

const ER_DUP_ENTRY = 1062;
const LIST_MODELS_TIMEOUT_MS = 15_000;
/** Une nouveauté du catalogue OpenRouter reste signalée 30 jours après sa première apparition. */
const NEW_MODEL_WINDOW_MS = 30 * 24 * 3_600_000;

/** Palette des modèles : la couleur par défaut en est tirée par hachage de l'identifiant API. */
const MODEL_PALETTE = [
  '#6EA8FE', '#F59E0B', '#34D399', '#F472B6', '#A78BFA', '#22D3EE',
  '#FB7185', '#A3E635', '#FBBF24', '#60A5FA', '#E879F9', '#2DD4BF',
] as const;

function defaultColor(apiModelId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < apiModelId.length; i++) {
    h ^= apiModelId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return MODEL_PALETTE[(h >>> 0) % MODEL_PALETTE.length]!;
}

function errnoOf(err: unknown): number | undefined {
  const e = err as { errno?: number; cause?: { errno?: number } };
  return e.errno ?? e.cause?.errno;
}

const nameTaken = () => new ConflictError('provider_name_taken', 'Un fournisseur porte déjà ce nom');
const modelExists = () => new ConflictError('model_exists', 'Ce modèle existe déjà pour ce fournisseur');
const providerNotFound = () => new NotFoundError('Fournisseur introuvable');
const modelNotFound = () => new NotFoundError('Modèle introuvable');

function withKnownPrices(m: RemoteModel): RemoteModel {
  const known = KNOWN_PRICES[m.id];
  if (!known) return m;
  return { ...m, inputPricePerM: m.inputPricePerM ?? known.input, outputPricePerM: m.outputPricePerM ?? known.output };
}

export function createCatalogService(deps: CatalogServiceDeps) {
  const { db, registry } = deps;
  const providersRepo = createProvidersRepo(db);
  const modelsRepo = createModelsRepo(db);
  const isAdmin = (actor: Actor) => actor.role === 'admin';

  function publicProvider(p: ProviderRow, actor: Actor, modelCount: number): PublicProvider {
    const status = registry.keyStatus(p);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      maxConcurrency: p.maxConcurrency,
      enabled: p.enabled,
      keyState: status.state,
      keyLast4: isAdmin(actor) ? status.last4 : null,
      usable: status.usable,
      fake: status.fake,
      modelCount,
    };
  }

  async function providerView(p: ProviderRow, actor: Actor): Promise<PublicProvider> {
    const counts = await providersRepo.modelCounts(!isAdmin(actor));
    return publicProvider(p, actor, counts.get(p.id) ?? 0);
  }

  function publicModel(m: ModelRow, p: ProviderRow): PublicModel {
    return {
      id: m.id,
      providerId: m.providerId,
      providerName: p.name,
      providerType: p.type,
      apiModelId: m.apiModelId,
      displayName: m.displayName,
      color: m.color,
      inputPricePerM: m.inputPricePerM,
      outputPricePerM: m.outputPricePerM,
      priceSource: m.priceSource,
      supportsVision: m.supportsVision,
      supportsPdf: m.supportsPdf,
      contextWindow: m.contextWindow,
      enabled: m.enabled,
      available: m.enabled && p.enabled && registry.keyStatus(p).usable,
      createdAt: m.createdAt.toISOString(),
    };
  }

  async function requireProvider(id: string): Promise<ProviderRow> {
    const p = await providersRepo.find(id);
    if (!p) throw providerNotFound();
    return p;
  }

  return {
    async listProviders(actor: Actor): Promise<PublicProvider[]> {
      const [rows, counts] = await Promise.all([providersRepo.list(), providersRepo.modelCounts(!isAdmin(actor))]);
      return rows.map((p) => publicProvider(p, actor, counts.get(p.id) ?? 0));
    },

    async createProvider(actor: Actor, input: ProviderInput): Promise<PublicProvider> {
      const sealed = input.apiKey === undefined ? {} : sealApiKey(input.apiKey, deps.config.encryptionKey);
      let row: ProviderRow;
      try {
        row = await providersRepo.insert({
          id: randomUUID(),
          name: input.name,
          type: input.type,
          baseUrl: input.baseUrl,
          ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
          ...sealed,
        });
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw nameTaken();
        throw err;
      }
      await audit(db, {
        actorUserId: actor.userId,
        action: 'provider_created',
        targetType: 'provider',
        targetId: row.id,
        details: { name: row.name, type: row.type, keyChanged: input.apiKey === undefined ? null : 'replaced' },
      });
      return providerView(row, actor);
    },

    async updateProvider(actor: Actor, id: string, patch: ProviderUpdate): Promise<PublicProvider> {
      await requireProvider(id);
      const { apiKey, ...rest } = patch;
      const columns: ProviderPatch = { ...rest };
      let keyChanged: 'replaced' | 'removed' | null = null;
      if (typeof apiKey === 'string') {
        Object.assign(columns, sealApiKey(apiKey, deps.config.encryptionKey));
        keyChanged = 'replaced';
      } else if (apiKey === null) {
        columns.apiKeyEncrypted = null;
        columns.apiKeyLast4 = null;
        keyChanged = 'removed';
      }
      let row: ProviderRow | undefined;
      try {
        row = await providersRepo.update(id, columns);
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw nameTaken();
        throw err;
      }
      if (!row) throw providerNotFound();
      // Noms des champs seulement : jamais la valeur de la clé.
      await audit(db, {
        actorUserId: actor.userId,
        action: 'provider_updated',
        targetType: 'provider',
        targetId: id,
        details: { fields: Object.keys(rest).sort(), keyChanged },
      });
      return providerView(row, actor);
    },

    async testConnection(id: string): Promise<ConnectionTest> {
      const p = await requireProvider(id);
      const started = Date.now();
      try {
        const list = await registry.adapterFor(p).listModels(AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS));
        return { ok: true, modelCount: list.length, latencyMs: Date.now() - started };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, code: err.code, message: err.message };
        if (err instanceof KeyMissingError || err instanceof KeyUnreadableError) {
          return { ok: false, code: err.code, message: err.message };
        }
        throw err;
      }
    },

    async remoteModels(id: string): Promise<RemoteModelView[]> {
      const p = await requireProvider(id);
      const adapter = registry.adapterFor(p); // lève key_missing / key_unreadable (409) avant tout appel réseau
      let list: RemoteModel[];
      try {
        list = await adapter.listModels(AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS));
      } catch (err) {
        if (err instanceof ProviderError) {
          throw new AppError('provider_error', 502, err.message, { providerCode: err.code });
        }
        throw err;
      }
      const added = await modelsRepo.apiModelIdsOf(id);
      return list
        .map(withKnownPrices)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((m) => ({ ...m, alreadyAdded: added.has(m.id) }));
    },

    async listModels(actor: Actor): Promise<PublicModel[]> {
      const [rows, provs] = await Promise.all([modelsRepo.list(!isAdmin(actor)), providersRepo.list()]);
      const byId = new Map(provs.map((p) => [p.id, p]));
      return rows.map((m) => publicModel(m, byId.get(m.providerId)!));
    },

    async getModel(actor: Actor, id: string): Promise<PublicModel & { provider: PublicProvider }> {
      const m = await modelsRepo.find(id);
      if (!m || (!isAdmin(actor) && !m.enabled)) throw modelNotFound();
      const p = await requireProvider(m.providerId);
      return { ...publicModel(m, p), provider: await providerView(p, actor) };
    },

    async createModel(actor: Actor, input: ModelInput): Promise<PublicModel> {
      const p = await requireProvider(input.providerId);
      let row: ModelRow;
      try {
        row = await modelsRepo.insert({
          id: randomUUID(),
          providerId: input.providerId,
          apiModelId: input.apiModelId,
          displayName: input.displayName,
          color: input.color ?? defaultColor(input.apiModelId),
          ...(input.inputPricePerM === undefined ? {} : { inputPricePerM: input.inputPricePerM }),
          ...(input.outputPricePerM === undefined ? {} : { outputPricePerM: input.outputPricePerM }),
          ...(input.priceSource === undefined ? {} : { priceSource: input.priceSource }),
          ...(input.supportsVision === undefined ? {} : { supportsVision: input.supportsVision }),
          ...(input.supportsPdf === undefined ? {} : { supportsPdf: input.supportsPdf }),
          ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        });
      } catch (err) {
        if (errnoOf(err) === ER_DUP_ENTRY) throw modelExists();
        throw err;
      }
      await audit(db, {
        actorUserId: actor.userId,
        action: 'model_created',
        targetType: 'model',
        targetId: row.id,
        details: { providerId: row.providerId, apiModelId: row.apiModelId },
      });
      return publicModel(row, p);
    },

    async updateModel(actor: Actor, id: string, patch: ModelUpdate): Promise<PublicModel> {
      if (!(await modelsRepo.find(id))) throw modelNotFound();
      // Un prix saisi à la main ne doit pas être écrasé par la synchronisation OpenRouter : il repasse en `manual`.
      const pricesChanged = patch.inputPricePerM !== undefined || patch.outputPricePerM !== undefined;
      const columns: ModelUpdate = pricesChanged && patch.priceSource === undefined ? { ...patch, priceSource: 'manual' } : patch;
      const row = await modelsRepo.update(id, columns);
      if (!row) throw modelNotFound();
      await audit(db, {
        actorUserId: actor.userId,
        action: 'model_updated',
        targetType: 'model',
        targetId: id,
        details: { fields: Object.keys(columns).sort() },
      });
      return publicModel(row, await requireProvider(row.providerId));
    },

    /** Modèles apparus dans le catalogue OpenRouter depuis moins de 30 jours (hors première synchronisation, écartés, ou déjà ajoutés). */
    async newModels(): Promise<NewModel[]> {
      const since = new Date(deps.clock().getTime() - NEW_MODEL_WINDOW_MS);
      const [rows, provs] = await Promise.all([
        db
          .select()
          .from(openrouterCatalog)
          .where(
            and(eq(openrouterCatalog.initialSync, false), isNull(openrouterCatalog.dismissedAt), gte(openrouterCatalog.firstSeenAt, since)),
          )
          .orderBy(desc(openrouterCatalog.firstSeenAt), openrouterCatalog.openrouterId),
        providersRepo.list(),
      ]);
      const local = new Set<string>();
      for (const p of provs.filter((x) => isOpenRouter(x.baseUrl))) {
        for (const id of await modelsRepo.apiModelIdsOf(p.id)) local.add(id);
      }
      return rows
        .filter((r) => !local.has(r.openrouterId))
        .map((r) => ({
          id: r.id,
          openrouterId: r.openrouterId,
          name: r.name,
          inputPricePerM: r.inputPricePerM,
          outputPricePerM: r.outputPricePerM,
          supportsVision: r.inputModalities.includes('image'),
          supportsPdf: r.inputModalities.includes('file'),
          contextWindow: r.contextWindow,
          firstSeenAt: r.firstSeenAt.toISOString(),
        }));
    },

    /** Écarte une nouveauté (elle ne sera plus proposée). */
    async dismissNew(actor: Actor, id: string): Promise<void> {
      const [row] = await db.select({ id: openrouterCatalog.id }).from(openrouterCatalog).where(eq(openrouterCatalog.id, id));
      if (!row) throw new NotFoundError('Nouveauté introuvable');
      await db.update(openrouterCatalog).set({ dismissedAt: deps.clock() }).where(eq(openrouterCatalog.id, id));
      await audit(db, { actorUserId: actor.userId, action: 'catalog_dismissed', targetType: 'openrouter_catalog', targetId: id });
    },

    /** Premier fournisseur OpenRouter actif (cible du bouton « Ajouter » des nouveautés). */
    async openRouterProviderId(): Promise<string | null> {
      const rows = await providersRepo.list(); // triés par nom
      return rows.find((p) => p.enabled && isOpenRouter(p.baseUrl))?.id ?? null;
    },

    /** Fournisseurs actifs dont la clé est utilisable (tous, en mode faux). */
    async configuredCount(): Promise<number> {
      const rows = await providersRepo.enabled();
      return rows.filter((p) => registry.keyStatus(p).usable).length;
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
