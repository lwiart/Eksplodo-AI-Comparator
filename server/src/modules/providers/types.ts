// Types communs à tous les adaptateurs de fournisseurs (spec §6.1).

export type GenerateRequest = {
  model: string;
  system?: string;
  prompt: string;
  attachments: { mime: string; base64: string; filename: string }[];
  temperature?: number;
  maxTokens: number;
};

export type GenerateEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { type: 'finish'; reason: 'stop' | 'length' | 'refusal' | 'content_filter' | 'other' };

/** `null` = inconnu : l'Admin complète à l'ajout du modèle. */
export type RemoteModel = {
  id: string;
  name: string;
  contextWindow: number | null;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  supportsVision: boolean | null;
  supportsPdf: boolean | null;
};

export interface ProviderAdapter {
  /** Les erreurs sont levées sous forme de `ProviderError`. Aucune nouvelle tentative réseau ici. */
  generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent>;
  /** Le `signal` porte le délai de 15 s de l'interrogation. */
  listModels(signal: AbortSignal): Promise<RemoteModel[]>;
}

export type ProviderConfig = {
  id: string;
  type: 'openai_compatible' | 'anthropic' | 'google';
  baseUrl: string;
  apiKey: string | null;
  appBaseUrl: string;
  /** Injectable pour les tests. */
  fetch?: typeof fetch;
};
