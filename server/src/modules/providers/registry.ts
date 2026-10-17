// Registre des fournisseurs : choisit l'adaptateur et déchiffre la clé au moment de l'appel.
// Rien n'est mis en cache : chaque `adapterFor` déchiffre la clé et construit une configuration neuve.
import { AppError, ValidationError } from '../../errors.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createFakeAdapter } from './fake.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter, ProviderConfig } from './types.js';

/** Une ligne de la table `providers` satisfait ce type. */
export type ProviderLike = {
  id: string;
  name: string;
  type: 'openai_compatible' | 'anthropic' | 'google';
  baseUrl: string;
  apiKeyEncrypted: string | null;
  apiKeyLast4: string | null;
};

export type KeyState = 'missing' | 'stored' | 'unreadable';
export type KeyStatus = { state: KeyState; last4: string | null; usable: boolean; fake: boolean };

export class KeyMissingError extends AppError {
  constructor() {
    super('key_missing', 409, "Aucune clé enregistrée pour ce fournisseur : saisissez-la dans l'écran Fournisseurs");
  }
}

export class KeyUnreadableError extends AppError {
  constructor() {
    super('key_unreadable', 409, "Clé illisible (APP_ENCRYPTION_KEY a changé) : ressaisissez-la dans l'écran Fournisseurs");
  }
}

const KEY_PATTERN = /^[\x21-\x7E]{8,500}$/;
const LAST4_MIN_LENGTH = 12;

/** Valide et chiffre une clé API saisie par l'Admin. */
export function sealApiKey(plain: string, encryptionKey: Buffer): { apiKeyEncrypted: string; apiKeyLast4: string | null } {
  const key = plain.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError('validation', 'Clé API invalide : 8 à 500 caractères imprimables, sans espace');
  }
  return {
    apiKeyEncrypted: encryptSecret(key, encryptionKey),
    apiKeyLast4: key.length >= LAST4_MIN_LENGTH ? key.slice(-4) : null,
  };
}

export function createProviderRegistry(deps: {
  encryptionKey: Buffer;
  fakeLlm: boolean;
  appBaseUrl: string;
  fetch?: typeof fetch;
  fakeSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  function decrypt(p: Pick<ProviderLike, 'apiKeyEncrypted'>): { state: KeyState; plain: string | null } {
    if (!p.apiKeyEncrypted) return { state: 'missing', plain: null };
    try {
      return { state: 'stored', plain: decryptSecret(p.apiKeyEncrypted, deps.encryptionKey) };
    } catch {
      return { state: 'unreadable', plain: null };
    }
  }

  function keyStatus(p: Pick<ProviderLike, 'apiKeyEncrypted' | 'apiKeyLast4'>): KeyStatus {
    const { state } = decrypt(p);
    return {
      state,
      last4: p.apiKeyLast4,
      usable: deps.fakeLlm || state === 'stored',
      fake: deps.fakeLlm,
    };
  }

  function adapterFor(p: ProviderLike): ProviderAdapter {
    if (deps.fakeLlm) return createFakeAdapter({ sleep: deps.fakeSleep });
    const { state, plain } = decrypt(p);
    if (state === 'missing') throw new KeyMissingError();
    if (state === 'unreadable' || plain === null) throw new KeyUnreadableError();
    const cfg: ProviderConfig = {
      id: p.id,
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey: plain,
      appBaseUrl: deps.appBaseUrl,
      fetch: deps.fetch,
    };
    switch (p.type) {
      case 'openai_compatible':
        return createOpenAiCompatibleAdapter(cfg);
      case 'anthropic':
        return createAnthropicAdapter(cfg);
      case 'google':
        return createGoogleAdapter(cfg);
    }
  }

  return { keyStatus, adapterFor };
}

export type Registry = ReturnType<typeof createProviderRegistry>;
