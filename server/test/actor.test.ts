import { expect, test } from 'vitest';
import { ForbiddenError } from '../src/errors.js';
import { assertRole, normalizeEmail, type Actor } from '../src/modules/auth/actor.js';

const user: Actor = { userId: 'u1', role: 'user', email: 'u@x.fr', name: 'U' };
const admin: Actor = { userId: 'u0', role: 'admin', email: 'a@x.fr', name: 'A' };

test('assertRole : le rôle autorisé passe, l’autre lève ForbiddenError', () => {
  expect(() => assertRole(admin, 'admin')).not.toThrow();
  expect(() => assertRole(user, 'user', 'admin')).not.toThrow();
  expect(() => assertRole(user, 'admin')).toThrow(ForbiddenError);
});

test('normalizeEmail', () => {
  expect(normalizeEmail('  Laurent@Eksplodo.FR ')).toBe('laurent@eksplodo.fr');
});
