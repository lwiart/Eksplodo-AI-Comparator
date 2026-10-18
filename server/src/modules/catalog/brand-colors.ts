// Couleur principale de la marque d'un modèle, appliquée quand la création ne précise pas de couleur. Copie conforme de
// web/src/lib/brand-colors.ts (un test serveur vérifie que les deux tables restent identiques).

/** Marque, motif reconnu dans l'identifiant ou le nom du modèle, motif reconnu dans l'hôte de l'API, couleur. */
export const BRAND_COLORS: { brand: string; model: RegExp; host: RegExp; color: string }[] = [
  { brand: 'Anthropic', model: /claude|anthropic/i, host: /(^|\.)anthropic\.com$/i, color: '#D97757' },
  { brand: 'OpenAI', model: /openai|chatgpt|gpt|(^|\/)o\d/i, host: /(^|\.)openai\.com$/i, color: '#10A37F' },
  { brand: 'Mistral', model: /mistral|mixtral|codestral|magistral|pixtral|ministral|devstral/i, host: /(^|\.)mistral\.ai$/i, color: '#FA520F' },
  { brand: 'DeepSeek', model: /deepseek/i, host: /(^|\.)deepseek\.com$/i, color: '#4D6BFE' },
  { brand: 'Kimi', model: /kimi|moonshot/i, host: /(^|\.)moonshot\.(ai|cn)$/i, color: '#007CFF' },
  { brand: 'GLM', model: /glm|zhipu|z-ai/i, host: /(^|\.)(bigmodel\.cn|z\.ai)$/i, color: '#004D40' },
  { brand: 'Google', model: /gemini|gemma|google/i, host: /(^|\.)googleapis\.com$/i, color: '#4285F4' },
  { brand: 'Meta', model: /llama|meta-/i, host: /(^|\.)llama\.com$/i, color: '#0081FB' },
];

function hostOf(baseUrl: string | undefined): string {
  try {
    return baseUrl ? new URL(baseUrl).hostname : '';
  } catch {
    return '';
  }
}

/**
 * Couleur de marque du modèle, `null` si la marque est inconnue. Le modèle prime (un agrégateur sert plusieurs marques),
 * puis l'hôte de l'API du fournisseur (modèle ajouté à la main chez Anthropic, Mistral…).
 */
export function brandColor(apiModelId: string, displayName = '', providerBaseUrl?: string): string | null {
  const text = `${apiModelId} ${displayName}`;
  const byModel = BRAND_COLORS.find((b) => b.model.test(text));
  if (byModel) return byModel.color;
  const host = hostOf(providerBaseUrl);
  return BRAND_COLORS.find((b) => host !== '' && b.host.test(host))?.color ?? null;
}
