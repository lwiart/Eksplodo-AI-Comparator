import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client.js';
import { providers } from '../../db/schema/catalog.js';
import { readValue, writeValue } from '../settings/settings.repo.js';

export const SEEDED_SETTING = 'catalog.seeded_at';

type PresetProvider = { name: string; type: 'openai_compatible' | 'anthropic' | 'google'; baseUrl: string };

/** Fournisseurs préconfigurés à la première installation, sans clé (l'Admin la saisit dans l'interface). */
export const PRESET_PROVIDERS: readonly PresetProvider[] = [
  { name: 'OpenRouter', type: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'OpenAI', type: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { name: 'Google', type: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Mistral', type: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1' },
  { name: 'DeepSeek', type: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Requesty', type: 'openai_compatible', baseUrl: 'https://router.requesty.ai/v1' },
  { name: 'Eden AI', type: 'openai_compatible', baseUrl: 'https://api.edenai.run/v3' },
];

/**
 * Insère les fournisseurs préconfigurés une seule fois dans la vie de la base (réglage `catalog.seeded_at`) :
 * un fournisseur supprimé ensuite par l'Admin n'est pas recréé. Un fournisseur de même nom n'est jamais écrasé.
 * Appelé sous le verrou de démarrage ; `INSERT IGNORE` (nom unique) le rend sûr même hors verrou.
 */
export async function seedProviders(db: Db, now: Date): Promise<'seeded' | 'skipped'> {
  if ((await readValue(db, SEEDED_SETTING)) !== undefined) return 'skipped';
  await db
    .insert(providers)
    .ignore()
    .values(PRESET_PROVIDERS.map((p) => ({ id: randomUUID(), ...p })));
  await writeValue(db, SEEDED_SETTING, now.toISOString());
  return 'seeded';
}
