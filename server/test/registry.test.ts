import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { decryptSecret } from '../src/lib/crypto.js';
import {
  createProviderRegistry,
  KeyMissingError,
  KeyUnreadableError,
  keyContext,
  sealApiKey,
  type KeyOwner,
  type ProviderLike,
} from '../src/modules/providers/registry.js';
import { fakeFetch } from './helpers/fake-fetch.js';

const key = Buffer.alloc(32, 7);
const sig = new AbortController().signal;
const json = (body: unknown) => () => Response.json(body);
const owner: KeyOwner = { id: 'p1', baseUrl: 'https://x.test/v1' };

function row(over: Partial<ProviderLike> = {}): ProviderLike {
  return { id: 'p1', name: 'Test', type: 'openai_compatible', baseUrl: 'https://x.test/v1', apiKeyEncrypted: null, apiKeyLast4: null, ...over };
}

/** Chiffré à l'ancien format v1 (sans contexte), tel qu'écrit avant la liaison au fournisseur. */
function legacySeal(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

describe('sealApiKey', () => {
  test('chiffre, garde les 4 derniers caractères, refuse les clés invalides', () => {
    const s = sealApiKey('  sk-test-0123456789abcd  ', key, owner);
    expect(s.apiKeyEncrypted).not.toContain('0123456789');
    expect(decryptSecret(s.apiKeyEncrypted, key, keyContext(owner))).toBe('sk-test-0123456789abcd');
    expect(s.apiKeyLast4).toBe('abcd');
    expect(sealApiKey('court-1234', key, owner).apiKeyLast4).toBeNull();
    for (const bad of ['', '   ', 'abc', 'sk-avec espace-123', 'sk-ligne\n-12345', 'é'.repeat(10), 'a'.repeat(501)]) {
      expect(() => sealApiKey(bad, key, owner)).toThrow(/Clé API invalide/);
    }
    expect(() => sealApiKey('abc', key, owner)).toThrow(expect.objectContaining({ code: 'validation', status: 400 }));
  });

  test('contexte : identifiant et hôte (casse ignorée), pas le chemin', () => {
    expect(keyContext({ id: 'p1', baseUrl: 'https://X.test/v1' })).toBe(keyContext({ id: 'p1', baseUrl: 'https://x.test/autre' }));
    expect(keyContext({ id: 'p1', baseUrl: 'https://x.test/v1' })).not.toBe(keyContext({ id: 'p1', baseUrl: 'https://y.test/v1' }));
    expect(keyContext({ id: 'p1', baseUrl: 'https://x.test/v1' })).not.toBe(keyContext({ id: 'p2', baseUrl: 'https://x.test/v1' }));
    expect(keyContext({ id: 'p1', baseUrl: 'https://x.test/v1' })).not.toBe(keyContext({ id: 'p1', baseUrl: 'https://x.test:8443/v1' }));
  });
});

describe('registre', () => {
  test('états de clé : missing, stored, unreadable', () => {
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x' });
    expect(r.keyStatus(row())).toEqual({ state: 'missing', last4: null, usable: false, fake: false });
    expect(r.keyStatus(row(sealApiKey('sk-test-0123456789abcd', key, owner)))).toEqual({ state: 'stored', last4: 'abcd', usable: true, fake: false });
    expect(r.keyStatus(row(sealApiKey('sk-test-0123456789abcd', Buffer.alloc(32, 9), owner)))).toMatchObject({ state: 'unreadable', usable: false });
  });

  test('adapterFor : key_missing et key_unreadable (409), sans appel réseau', () => {
    const f = fakeFetch({});
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    expect(() => r.adapterFor(row())).toThrow(KeyMissingError);
    expect(() => r.adapterFor(row())).toThrow(expect.objectContaining({ code: 'key_missing', status: 409 }));
    const foreign = sealApiKey('sk-test-0123456789abcd', Buffer.alloc(32, 9), owner);
    expect(() => r.adapterFor(row(foreign))).toThrow(KeyUnreadableError);
    expect(() => r.adapterFor(row(foreign))).toThrow(expect.objectContaining({ code: 'key_unreadable', status: 409 }));
    expect(f.calls).toHaveLength(0);
  });

  test('base modifiée hors application : la clé n’est jamais envoyée vers un autre hôte', () => {
    const f = fakeFetch({});
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    const sealed = sealApiKey('sk-test-0123456789abcd', key, owner);
    // `base_url` réécrit en SQL vers un serveur tiers : clé illisible, aucun appel.
    const hijacked = row({ ...sealed, baseUrl: 'https://attaquant.example/v1' });
    expect(r.keyStatus(hijacked)).toMatchObject({ state: 'unreadable', usable: false });
    expect(() => r.adapterFor(hijacked)).toThrow(KeyUnreadableError);
    // Chiffré recopié sur un autre fournisseur (même hôte compris) : illisible aussi.
    const copied = row({ ...sealed, id: 'p2' });
    expect(() => r.adapterFor(copied)).toThrow(KeyUnreadableError);
    expect(f.calls).toHaveLength(0);
  });

  test('ancien format v1 : refusé par le registre (converti au démarrage)', () => {
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x' });
    const legacy = row({ apiKeyEncrypted: legacySeal('sk-test-0123456789abcd', key), apiKeyLast4: 'abcd' });
    expect(r.keyStatus(legacy)).toMatchObject({ state: 'unreadable', usable: false });
  });

  test('type → adaptateur, clé déchiffrée transmise', async () => {
    const plain = 'sk-test-0123456789abcd';
    const f = fakeFetch({
      'GET https://o.test/v1/models': json({ data: [{ id: 'm1' }] }),
      'GET https://a.test/v1/models': json({ data: [], has_more: false }),
      'GET https://g.test/v1beta/models?pageSize=1000': json({ models: [] }),
    });
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    const provider = (type: ProviderLike['type'], baseUrl: string) =>
      row({ ...sealApiKey(plain, key, { id: 'p1', baseUrl }), type, baseUrl });
    await r.adapterFor(provider('openai_compatible', 'https://o.test/v1')).listModels(sig);
    await r.adapterFor(provider('anthropic', 'https://a.test')).listModels(sig);
    await r.adapterFor(provider('google', 'https://g.test/v1beta')).listModels(sig);
    expect(f.calls[0]!.headers.get('authorization')).toBe(`Bearer ${plain}`);
    expect(f.calls[1]!.headers.get('x-api-key')).toBe(plain);
    expect(f.calls[2]!.headers.get('x-goog-api-key')).toBe(plain);
    expect(f.calls[2]!.url).not.toContain(plain);
  });

  test('aucun cache : chaque appel reconstruit la configuration', async () => {
    const f = fakeFetch({ 'GET https://o.test/v1/models': json({ data: [] }) });
    const r = createProviderRegistry({ encryptionKey: key, fakeLlm: false, appBaseUrl: 'http://x', fetch: f });
    const o = { id: 'p1', baseUrl: 'https://o.test/v1' };
    const base = { type: 'openai_compatible' as const, baseUrl: o.baseUrl };
    await r.adapterFor(row({ ...base, ...sealApiKey('sk-premiere-cle-1', key, o) })).listModels(sig);
    await r.adapterFor(row({ ...base, ...sealApiKey('sk-seconde-cle-22', key, o) })).listModels(sig);
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer sk-premiere-cle-1');
    expect(f.calls[1]!.headers.get('authorization')).toBe('Bearer sk-seconde-cle-22');
  });

  test('mode faux : tout fournisseur utilisable, même sans clé', async () => {
    const rf = createProviderRegistry({ encryptionKey: key, fakeLlm: true, appBaseUrl: 'http://x' });
    expect(rf.keyStatus(row())).toEqual({ state: 'missing', last4: null, usable: true, fake: true });
    expect(rf.keyStatus(row(sealApiKey('sk-test-0123456789abcd', key, owner)))).toMatchObject({ state: 'stored', last4: 'abcd', usable: true, fake: true });
    expect((await rf.adapterFor(row()).listModels(sig))[0]!.id).toMatch(/^fake-/);
  });
});
