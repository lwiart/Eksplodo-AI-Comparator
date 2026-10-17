import { expect, test } from 'vitest';
import { isOpenRouter, parseOpenRouterModels } from '../src/modules/providers/openrouter.js';
import { fixtureText } from './helpers/fake-fetch.js';

const models = parseOpenRouterModels(JSON.parse(fixtureText('openrouter/models.json')));
const byId = (id: string) => models.find((m) => m.id === id)!;

test('entrées sans identifiant texte ignorées', () => {
  expect(models).toHaveLength(6);
  expect(parseOpenRouterModels({ data: [{ id: 3 }, null, 'x'] })).toEqual([]);
  expect(parseOpenRouterModels(null)).toEqual([]);
});

test('prix par token convertis en $ par million, capacités et contexte', () => {
  expect(byId('anthropic/claude-sonnet-5.5')).toEqual({
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Anthropic: Claude Sonnet 5.5',
    contextWindow: 1000000,
    inputPricePerM: 2,
    outputPricePerM: 10,
    supportsVision: true,
    supportsPdf: true,
  });
  expect(byId('mistralai/mistral-large')).toMatchObject({ supportsVision: false, supportsPdf: false });
});

test('prix "-1", absents ou non numériques → null', () => {
  expect(byId('openrouter/auto')).toMatchObject({ inputPricePerM: null, outputPricePerM: null });
  expect(byId('vendor/no-pricing')).toMatchObject({ inputPricePerM: null, outputPricePerM: null });
  const [m] = parseOpenRouterModels({ data: [{ id: 'x', pricing: { prompt: 'abc', completion: null } }] });
  expect(m).toMatchObject({ inputPricePerM: null, outputPricePerM: null });
});

test('prix zéro conservé (modèle gratuit)', () => {
  expect(byId('meta-llama/llama-free:free')).toMatchObject({ inputPricePerM: 0, outputPricePerM: 0 });
});

test('0.000003 par token → 3 $ par million (pas 2.9999…)', () => {
  expect(byId('mistralai/mistral-large').inputPricePerM).toBe(3);
  expect(byId('vendor/no-architecture').inputPricePerM).toBe(0.5);
});

test('entrée sans architecture : capacités null', () => {
  expect(byId('vendor/no-architecture')).toMatchObject({ supportsVision: null, supportsPdf: null });
});

test('isOpenRouter : hôte openrouter.ai uniquement', () => {
  expect(isOpenRouter('https://openrouter.ai/api/v1')).toBe(true);
  expect(isOpenRouter('https://api.openai.com/v1')).toBe(false);
  expect(isOpenRouter('https://evil.test/openrouter.ai')).toBe(false);
  expect(isOpenRouter('pas une url')).toBe(false);
});
