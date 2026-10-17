import { expect, test } from 'vitest';
import { messageFor, messageForError, messageForScoreError } from './messages';

const CODES = [
  'unauthorized', 'forbidden', 'validation', 'rate_limited', 'invitation_invalid', 'invalid_password', 'weak_password',
  'email_taken', 'user_not_active', 'user_not_invited', 'user_not_activated', 'last_admin', 'internal', 'not_found',
  'run_too_large', 'test_archived',
];

test('série trop grande : message de la limite de 5 000 appels', () => {
  expect(messageFor('run_too_large')).toBe('Série trop grande : 5 000 appels au plus.');
});

test('chaque code d’erreur de l’API a un message français dédié', () => {
  const fallback = messageFor('code_inconnu');
  for (const code of CODES) expect(messageFor(code), code).not.toBe(fallback);
});

test('une erreur interne affiche la référence', () => {
  expect(messageForError({ code: 'internal', reference: 'E-1' })).toContain('E-1');
});

test('notation manuelle : le refus de validation du serveur est conservé, le reste retombe sur le message du code', () => {
  expect(messageForScoreError({ code: 'validation', message: 'Notez toutes les réponses de la question' })).toBe(
    'Notez toutes les réponses de la question',
  );
  expect(messageForScoreError({ code: 'not_found', message: 'Question introuvable' })).toBe(messageFor('not_found'));
  expect(messageForScoreError(new Error('x'))).toBe(messageForError(new Error('x')));
});
