import { expect, test } from 'vitest';
import { BRAND_COLORS, brandColor } from '../src/modules/catalog/brand-colors.js';
import { BRAND_COLORS as WEB_BRAND_COLORS, brandColor as webBrandColor } from '../../web/src/lib/brand-colors.js';

test('table du serveur identique à celle du client (couleur proposée = couleur enregistrée)', () => {
  const plain = (list: typeof BRAND_COLORS) => list.map((b) => [b.brand, b.model.source, b.model.flags, b.host.source, b.color]);
  expect(plain(BRAND_COLORS)).toEqual(plain(WEB_BRAND_COLORS));
});

test.each([
  ['claude-sonnet-5-5', '', undefined, '#D97757'],
  ['anthropic/claude-opus-5-5', 'Anthropic: Claude Opus 5.5', 'https://openrouter.ai/api/v1', '#D97757'],
  ['gpt-5', '', undefined, '#10A37F'],
  ['openai/o4-mini', '', 'https://openrouter.ai/api/v1', '#10A37F'],
  ['mistral-large-latest', '', undefined, '#FA520F'],
  ['codestral-2508', '', undefined, '#FA520F'],
  ['deepseek-r1-distill-llama-70b', '', undefined, '#4D6BFE'],
  ['moonshotai/kimi-k2', '', undefined, '#007CFF'],
  ['z-ai/glm-4.6', '', undefined, '#004D40'],
  ['gemini-2.5-pro', '', undefined, '#4285F4'],
  ['meta-llama/llama-4-maverick', '', undefined, '#0081FB'],
  // Modèle sans marque reconnaissable : l'hôte de l'API du fournisseur décide.
  ['mon-modele-maison', '', 'https://api.anthropic.com', '#D97757'],
  ['mon-modele-maison', '', 'https://api.mistral.ai/v1', '#FA520F'],
  ['mon-modele-maison', '', 'https://openrouter.ai/api/v1', null],
  ['qwen3-max', 'Qwen3 Max', undefined, null],
  ['', '', 'pas une url', null],
])('%s (%s, %s) → %s', (id, name, baseUrl, color) => {
  expect(brandColor(id, name, baseUrl)).toBe(color);
  expect(webBrandColor(id, name, baseUrl)).toBe(color);
});

test('le modèle prime sur l’hôte : un Llama servi par l’API Mistral garde la couleur de Meta', () => {
  expect(brandColor('llama-3.3-70b', '', 'https://api.mistral.ai/v1')).toBe('#0081FB');
});
