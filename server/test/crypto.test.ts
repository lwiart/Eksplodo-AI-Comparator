import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { decryptSecret, encryptSecret, generateToken, hashPassword, hashToken, verifyPassword } from '../src/lib/crypto.js';

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
    const a = encryptSecret('sk-test', key), b = encryptSecret('sk-test', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('sk-test');
    expect(() => decryptSecret(a, randomBytes(32))).toThrow();
    // Altération déterministe : un bit du contenu chiffré inversé (XOR), puis un bit de l'étiquette.
    const parts = a.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = (data[0] ?? 0) ^ 0x01;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], data.toString('base64url')].join('.'), key)).toThrow();
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    expect(() => decryptSecret([parts[0], parts[1], tag.toString('base64url'), parts[3]].join('.'), key)).toThrow();
  });

  test('secret : format v1 à 4 segments, IV de 12 octets', () => {
    const key = randomBytes(32);
    const parts = encryptSecret('x', key).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
  });

  test('secret : rejette un format malformé', () => {
    const key = randomBytes(32);
    const a = encryptSecret('x', key);
    expect(() => decryptSecret('v2' + a.slice(2), key)).toThrow();
    expect(() => decryptSecret(a.split('.').slice(0, 3).join('.'), key)).toThrow();
    expect(() => decryptSecret('', key)).toThrow();
  });

  test('secret : clé de mauvaise longueur refusée', () => {
    expect(() => encryptSecret('x', randomBytes(16))).toThrow(/32 octets/);
    const a = encryptSecret('x', randomBytes(32));
    expect(() => decryptSecret(a, randomBytes(16))).toThrow(/32 octets/);
  });
});
