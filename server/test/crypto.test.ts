import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../src/lib/crypto.js';

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
});
