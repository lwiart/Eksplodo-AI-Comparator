import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  decryptLegacySecret,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashPassword,
  hashToken,
  isLegacySecret,
  verifyPassword,
} from '../src/lib/crypto.js';

const CTX = 'aic:provider-key:p1:x.test';

describe('crypto', () => {
  test('mot de passe : aller-retour et rejet', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'autre chose')).toBe(false);
  });

  test('jeton : longueur et hachage', () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashToken(token)).toBe(hash);
  });

  test('secret : aller-retour, aléa, clé ou contenu altéré', () => {
    const key = randomBytes(32);
    const a = encryptSecret('sk-test', key, CTX), b = encryptSecret('sk-test', key, CTX);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key, CTX)).toBe('sk-test');
    expect(() => decryptSecret(a, randomBytes(32), CTX)).toThrow();
    // Altération déterministe : un bit du contenu chiffré inversé (XOR), puis un bit de l'étiquette.
    const parts = a.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = (data[0] ?? 0) ^ 0x01;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], data.toString('base64url')].join('.'), key, CTX)).toThrow();
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    expect(() => decryptSecret([parts[0], parts[1], tag.toString('base64url'), parts[3]].join('.'), key, CTX)).toThrow();
  });

  test('secret : lié à son contexte', () => {
    const key = randomBytes(32);
    const a = encryptSecret('sk-test', key, CTX);
    expect(() => decryptSecret(a, key, 'aic:provider-key:p1:attaquant.example')).toThrow();
    expect(() => decryptSecret(a, key, '')).toThrow();
  });

  test('secret : format v2 à 4 segments, IV de 12 octets', () => {
    const key = randomBytes(32);
    const parts = encryptSecret('x', key, CTX).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v2');
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
  });

  test('secret : rejette un format malformé', () => {
    const key = randomBytes(32);
    const a = encryptSecret('x', key, CTX);
    expect(() => decryptSecret('v3' + a.slice(2), key, CTX)).toThrow();
    expect(() => decryptSecret(a.split('.').slice(0, 3).join('.'), key, CTX)).toThrow();
    expect(() => decryptSecret('', key, CTX)).toThrow();
  });

  test('ancien format v1 : refusé par decryptSecret, lu par decryptLegacySecret', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update('sk-ancienne', 'utf8'), cipher.final()]);
    const legacy = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    expect(isLegacySecret(legacy)).toBe(true);
    expect(isLegacySecret(encryptSecret('x', key, CTX))).toBe(false);
    expect(() => decryptSecret(legacy, key, CTX)).toThrow();
    expect(decryptLegacySecret(legacy, key)).toBe('sk-ancienne');
    expect(() => decryptLegacySecret(encryptSecret('x', key, CTX), key)).toThrow();
  });

  test('secret : clé de mauvaise longueur refusée', () => {
    expect(() => encryptSecret('x', randomBytes(16), CTX)).toThrow(/32 octets/);
    const a = encryptSecret('x', randomBytes(32), CTX);
    expect(() => decryptSecret(a, randomBytes(16), CTX)).toThrow(/32 octets/);
  });
});
