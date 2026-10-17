import { expect, test } from 'vitest';
import { httpError, thrownError, ProviderError } from '../src/modules/providers/errors.js';
import {
  acceptsTemperature,
  isTemperatureRejection,
  rememberNoTemperature,
  resetTemperatureMemory,
} from '../src/modules/providers/temperature.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sig = new AbortController().signal;

test.each([
  [401, '', 'auth_invalid', false], [403, '', 'auth_invalid', false], [404, '', 'model_not_found', false],
  [429, '', 'rate_limited', true], [500, '', 'provider_unavailable', true], [503, '', 'provider_unavailable', true],
  [529, '', 'provider_unavailable', true], [413, '', 'context_too_long', false], [408, '', 'timeout', true],
  [400, '{"error":{"code":"context_length_exceeded"}}', 'context_too_long', false],
  [400, 'prompt is too long: 250000 tokens > 200000 maximum', 'context_too_long', false],
  [400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 'auth_invalid', false],
  [400, '{"error":{"message":"unsupported value: temperature"}}', 'bad_request', false],
])('HTTP %i → %s', (status, body, code, retryable) => {
  const e = httpError(status, body, {}, []);
  expect(e.code).toBe(code); expect(e.retryable).toBe(retryable); expect(e.status).toBe(status);
});
test('Retry-After en secondes et en date HTTP', () => {
  expect(httpError(429, '', { 'retry-after': '7' }, []).retryAfterMs).toBe(7000);
  expect(httpError(429, '', { 'retry-after': new Date(Date.now() + 5000).toUTCString() }, []).retryAfterMs).toBeGreaterThan(3000);
  expect(httpError(429, '', new Headers({ 'Retry-After': '2' }), []).retryAfterMs).toBe(2000);
});
test('la clé recopiée par le fournisseur est masquée', () => {
  const key = 'zz-secret-0123456789';
  const e = httpError(401, `{"error":"bad key ${key}","headers":{"x-api-key":"${key}"}}`, {}, [key]);
  expect(e.detail).not.toContain(key); expect(e.message).toBe('Clé invalide ou sans droit sur ce modèle');
});
test('le détail est tronqué à 500 caractères', () => {
  expect(httpError(500, 'x'.repeat(2000), {}, []).detail.length).toBeLessThanOrEqual(500);
});
test('délai : signal annulé par AbortSignal.timeout → timeout, réessayable', async () => {
  const signal = AbortSignal.timeout(1); await sleep(5);
  const e = thrownError(new DOMException('aborted', 'AbortError'), signal, []);
  expect(e.code).toBe('timeout'); expect(e.retryable).toBe(true);
});
test('annulation par l’appelant : la raison d’origine est relancée', () => {
  const ctrl = new AbortController(); const reason = new Error('annulé');
  ctrl.abort(reason);
  expect(() => thrownError(new DOMException('aborted', 'AbortError'), ctrl.signal, [])).toThrow(reason);
});
test('coupure réseau (TypeError fetch failed) → provider_unavailable', () => {
  const e = thrownError(new TypeError('fetch failed'), new AbortController().signal, []);
  expect(e.code).toBe('provider_unavailable'); expect(e.retryable).toBe(true);
});
test('ProviderError déjà normalisée renvoyée telle quelle', () => {
  const e = httpError(404, '', {}, []); expect(thrownError(e, sig, [])).toBe(e);
  expect(e).toBeInstanceOf(ProviderError);
});
test('mémoire temperature', () => {
  resetTemperatureMemory();
  expect(acceptsTemperature('p1', 'm')).toBe(true); rememberNoTemperature('p1', 'm');
  expect(acceptsTemperature('p1', 'm')).toBe(false); expect(acceptsTemperature('p2', 'm')).toBe(true);
  resetTemperatureMemory();
  expect(acceptsTemperature('p1', 'm')).toBe(true);
});
test('rejet de temperature : 400 mentionnant temperature', () => {
  expect(isTemperatureRejection(httpError(400, '{"error":{"message":"unsupported value: temperature"}}', {}, []))).toBe(true);
  expect(isTemperatureRejection(httpError(400, 'autre chose', {}, []))).toBe(false);
  expect(isTemperatureRejection(httpError(500, 'temperature', {}, []))).toBe(false);
});
