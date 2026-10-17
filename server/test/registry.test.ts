import { describe, expect, test } from 'vitest';
import { decryptSecret } from '../src/lib/crypto.js';
import {
  createProviderRegistry,
  KeyMissingError,
  KeyUnreadableError,
  sealApiKey,
  type ProviderLike,
} from '../src/modules/providers/registry.js';
import { fakeFetch } from './helpers/fake-fetch.js';

const key = Buffer.alloc(32, 7);
const sig = new AbortController().signal;
const json = (body: unknown) => () => Response.json(body);

function row(over: Partial<ProviderLike> = {}): ProviderLike {
  return { id: 'p1', name: 'Test', type: 'openai_compatible', baseUrl: 'https://x.test/v1', apiKeyEncrypted: null, apiKeyLast4: null, ...over };
}

describe('sealApiKey', () => {
  test('chiffre, garde les 4 derniers caractères, refuse les clés invalides', () => {
    const s = sealApiKey('  sk-test-0123456789abcd  ', key);
    expect(s.apiKeyEncrypted).not.toContain('0123456789');
    expect(decryptSecret(s.apiKeyEncrypted, key)).toBe('sk-test-0123456789abcd');
    expect(s.apiKeyLast4).toBe('abcd');
    expect(sealApiKey('court-1234', key).apiKeyLast4).toBeNull();
    for (const bad of ['', '   ', 'abc', 'sk-avec espace-123', 'sk-ligne\n-12345', 'é'.repeat(10), 'a'.repeat(501)]) {
      expect(() => sealApiKey(bad, key)).toThrow(/Clé API invalide/);
    }
    expect(() => sealApiKey('abc', key)).toThrow(expect.objectContaining({ code: 'validation', status: 400 }));
  });
});

describe('registre', () => {
  test('états de clé : missing, stored, unreadable', () => {
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x' });
    expect(r.keyStatus({ apiKeyEncrypted: null, apiKeyLast4: null })).toEqual({ state: 'missing', last4: null, usable: false, fake: false });
    expect(r.keyStatus(sealApiKey('sk-test-0123456789abcd', key))).toEqual({ state: 'stored', last4: 'abcd', usable: true, fake: false });
    expect(r.keyStatus(sealApiKey('sk-test-0123456789abcd', Buffer.alloc(32, 9)))).toMatchObject({ state: 'unreadable', usable: false });
  });

  test('adapterFor : key_missing et key_unreadable (409), sans appel réseau', () => {
    const f = fakeFetch({});
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    expect(() => r.adapterFor(row())).toThrow(KeyMissingError);
    expect(() => r.adapterFor(row())).toThrow(expect.objectContaining({ code: 'key_missing', status: 409 }));
    const foreign = sealApiKey('sk-test-0123456789abcd', Buffer.alloc(32, 9));
    expect(() => r.adapterFor(row(foreign))).toThrow(KeyUnreadableError);
    expect(() => r.adapterFor(row(foreign))).toThrow(expect.objectContaining({ code: 'key_unreadable', status: 409 }));
    expect(f.calls).toHaveLength(0);
  });

  test('type → adaptateur, clé déchiffrée transmise', async () => {
    const plain = 'sk-test-0123456789abcd';
    const sealed = sealApiKey(plain, key);
    const f = fakeFetch({
      'GET https://o.test/v1/models': json({ data: [{ id: 'm1' }] }),
      'GET https://a.test/v1/models': json({ data: [], has_more: false }),
      'GET https://g.test/v1beta/models?pageSize=1000': json({ models: [] }),
    });
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    await r.adapterFor(row({ ...sealed, type: 'openai_compatible', baseUrl: 'https://o.test/v1' })).listModels(sig);
    await r.adapterFor(row({ ...sealed, type: 'anthropic', baseUrl: 'https://a.test' })).listModels(sig);
    await r.adapterFor(row({ ...sealed, type: 'google', baseUrl: 'https://g.test/v1beta' })).listModels(sig);
    expect(f.calls[0]!.headers.get('authorization')).toBe(`Bearer ${plain}`);
    expect(f.calls[1]!.headers.get('x-api-key')).toBe(plain);
    expect(f.calls[2]!.headers.get('x-goog-api-key')).toBe(plain);
    expect(f.calls[2]!.url).not.toContain(plain);
  });

  test('aucun cache : chaque appel reconstruit la configuration', async () => {
    const f = fakeFetch({ 'GET https://o.test/v1/models': json({ data: [] }) });
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    const base = { type: 'openai_compatible' as const, baseUrl: 'https://o.test/v1' };
    await r.adapterFor(row({ ...base, ...sealApiKey('sk-premiere-cle-1', key) })).listModels(sig);
    await r.adapterFor(row({ ...base, ...sealApiKey('sk-seconde-cle-22', key) })).listModels(sig);
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer sk-premiere-cle-1');
    expect(f.calls[1]!.headers.get('authorization')).toBe('Bearer sk-seconde-cle-22');
  });

  test('mode faux : tout fournisseur utilisable, même sans clé', async () => {
    const rf = createProviderRegistry({ encryptionKey: key, fakeLlm: true, appBaseUrl: 'http://x' });
    expect(rf.keyStatus({ apiKeyEncrypted: null, apiKeyLast4: null })).toEqual({ state: 'missing', last4: null, usable: true, fake: true });
    expect(rf.keyStatus(sealApiKey('sk-test-0123456789abcd', key))).toMatchObject({ state: 'stored', last4: 'abcd', usable: true, fake: true });
    expect((await rf.adapterFor(row()).listModels(sig))[0]!.id).toMatch(/^fake-/);
  });
});
