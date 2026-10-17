import { MAIN_PROVIDERS, MORE_PROVIDERS } from '../three/providers';

// Le nom d'un fournisseur du catalogue ne coïncide pas toujours avec celui de sa marque (Anthropic → Claude, Google → Gemini).
const LOGO_ALIASES: Record<string, string> = { anthropic: 'claude', google: 'gemini' };
const LOGOS = new Map<string, string>([...MAIN_PROVIDERS, ...MORE_PROVIDERS].map((p) => [p.name.toLowerCase(), p.icon] as const));

/** Logo de la marque d'un fournisseur, d'après son nom ; `undefined` si inconnu. */
export function logoFor(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  return LOGOS.get(key) ?? LOGOS.get(LOGO_ALIASES[key] ?? '');
}
