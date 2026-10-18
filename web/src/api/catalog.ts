import { apiFetch } from './client';

// Types miroirs de server/src/modules/catalog/catalog.service.ts (les clés ne transitent jamais : seul `keyLast4`).
export type ProviderType = 'openai_compatible' | 'anthropic' | 'google';
export type KeyState = 'missing' | 'stored' | 'unreadable';
export type PriceSource = 'manual' | 'openrouter';

export type PublicProvider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  maxConcurrency: number;
  enabled: boolean;
  keyState: KeyState;
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
  priceSource: PriceSource;
  supportsVision: boolean;
  supportsPdf: boolean;
  contextWindow: number | null;
  enabled: boolean;
  available: boolean;
  createdAt: string;
};

export type RemoteModelView = {
  id: string;
  name: string;
  contextWindow: number | null;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  supportsVision: boolean | null;
  supportsPdf: boolean | null;
  alreadyAdded: boolean;
};

export type ConnectionTest =
  | { ok: true; modelCount: number; latencyMs: number }
  | { ok: false; code: string; message: string; detail?: string };

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

export type ProviderInput = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  maxConcurrency?: number;
  apiKey?: string;
};
/** `apiKey: string` remplace la clé, `apiKey: null` la supprime. */
export type ProviderPatch = Partial<Omit<ProviderInput, 'apiKey'>> & { enabled?: boolean; apiKey?: string | null };

export type ModelInput = {
  providerId: string;
  apiModelId: string;
  displayName: string;
  color?: string;
  inputPricePerM?: number;
  outputPricePerM?: number;
  priceSource?: PriceSource;
  supportsVision?: boolean;
  supportsPdf?: boolean;
  contextWindow?: number | null;
  enabled?: boolean;
};
/** Un changement de prix sans `priceSource` bascule la source sur `manual` côté serveur. */
export type ModelPatch = Partial<Omit<ModelInput, 'providerId' | 'apiModelId'>>;

// Types miroirs de server/src/modules/catalog/model-stats.ts.
export type Rank = { rank: number; of: number };

export type ModelStats = {
  quality: number | null;
  medianTtftMs: number | null;
  ttftRank: Rank | null;
  medianTokensPerS: number | null;
  tpsRank: Rank | null;
  reliability: number | null;
  radar: { category: string; model: number | null; average: number | null }[];
  history: { runId: string; runName: string; completedAt: string; rank: number | null; of: number; quality: number | null; global: number | null }[];
};

export const PROVIDERS_KEY = ['providers'] as const;
export const MODELS_KEY = ['models'] as const;
export const NEW_MODELS_KEY = ['models', 'new'] as const;

const enc = encodeURIComponent;

export async function listProviders(): Promise<PublicProvider[]> {
  return (await apiFetch<{ providers: PublicProvider[] }>('/api/providers')).providers;
}

export async function createProvider(body: ProviderInput): Promise<PublicProvider> {
  return (await apiFetch<{ provider: PublicProvider }>('/api/providers', { method: 'POST', body })).provider;
}

export async function updateProvider(id: string, patch: ProviderPatch): Promise<PublicProvider> {
  return (await apiFetch<{ provider: PublicProvider }>(`/api/providers/${enc(id)}`, { method: 'PATCH', body: patch })).provider;
}

export function testProvider(id: string): Promise<ConnectionTest> {
  return apiFetch(`/api/providers/${enc(id)}/test`, { method: 'POST' });
}

/** `supported` : `true` accepté, `false` refusé par le fournisseur, `null` indéterminé (clé, délai, indisponibilité). */
export type CapabilityResult = { supported: boolean | null; message: string };
export type CapabilityCheck = { vision: CapabilityResult; pdf: CapabilityResult };

/** Trois tout petits appels réels (texte seul, image, PDF) pour savoir ce que le modèle accepte. */
export async function checkCapabilities(providerId: string, apiModelId: string): Promise<CapabilityCheck> {
  return (await apiFetch<{ capabilities: CapabilityCheck }>(`/api/providers/${enc(providerId)}/check-capabilities`, { method: 'POST', body: { apiModelId } }))
    .capabilities;
}

export async function listRemoteModels(id: string): Promise<RemoteModelView[]> {
  return (await apiFetch<{ models: RemoteModelView[] }>(`/api/providers/${enc(id)}/remote-models`)).models;
}

export async function listModels(): Promise<PublicModel[]> {
  return (await apiFetch<{ models: PublicModel[] }>('/api/models')).models;
}

export async function getModel(id: string): Promise<PublicModel & { provider: PublicProvider }> {
  return (await apiFetch<{ model: PublicModel & { provider: PublicProvider } }>(`/api/models/${enc(id)}`)).model;
}

export async function createModel(body: ModelInput): Promise<PublicModel> {
  return (await apiFetch<{ model: PublicModel }>('/api/models', { method: 'POST', body })).model;
}

export async function updateModel(id: string, patch: ModelPatch): Promise<PublicModel> {
  return (await apiFetch<{ model: PublicModel }>(`/api/models/${enc(id)}`, { method: 'PATCH', body: patch })).model;
}

export function listNewModels(): Promise<{ models: NewModel[]; openRouterProviderId: string | null }> {
  return apiFetch('/api/catalog/new');
}

export function dismissNewModel(id: string): Promise<void> {
  return apiFetch(`/api/catalog/${enc(id)}/dismiss`, { method: 'POST' });
}

export const modelStatsKey = (id: string) => [...MODELS_KEY, id, 'stats'] as const;

export async function getModelStats(id: string): Promise<ModelStats> {
  return (await apiFetch<{ stats: ModelStats }>(`/api/models/${encodeURIComponent(id)}/stats`)).stats;
}
