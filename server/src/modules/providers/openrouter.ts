import type { RemoteModel } from './types.js';

export function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** Prix par token (chaîne ou nombre) → $ par million, arrondi à 4 décimales ; négatif, absent ou non numérique → `null`. */
function pricePerM(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return Math.round(perToken * 1_000_000 * 10_000) / 10_000;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lit la réponse de `GET /api/v1/models` d'OpenRouter ; les entrées sans `id` texte sont ignorées. */
export function parseOpenRouterModels(json: unknown): RemoteModel[] {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : [];
  const out: RemoteModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') continue;
    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    const modalities =
      isRecord(entry.architecture) && Array.isArray(entry.architecture.input_modalities)
        ? entry.architecture.input_modalities
        : null;
    out.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      contextWindow: typeof entry.context_length === 'number' ? entry.context_length : null,
      inputPricePerM: pricePerM(pricing.prompt),
      outputPricePerM: pricePerM(pricing.completion),
      supportsVision: modalities ? modalities.includes('image') : null,
      supportsPdf: modalities ? modalities.includes('file') : null,
    });
  }
  return out;
}
