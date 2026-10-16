import { expect, test } from 'vitest';
import { messageFor, messageForError } from './messages';

const CODES = [
  'unauthorized', 'forbidden', 'validation', 'rate_limited', 'invitation_invalid', 'invalid_password', 'weak_password',
  'email_taken', 'user_not_active', 'user_not_invited', 'user_not_activated', 'last_admin', 'internal', 'not_found',
];

test('chaque code d’erreur de l’API a un message français dédié', () => {
  const fallback = messageFor('code_inconnu');
  for (const code of CODES) expect(messageFor(code), code).not.toBe(fallback);
});

test('une erreur interne affiche la référence', () => {
  expect(messageForError({ code: 'internal', reference: 'E-1' })).toContain('E-1');
});
