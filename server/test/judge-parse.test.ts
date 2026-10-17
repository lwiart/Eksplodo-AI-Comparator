import { expect, test } from 'vitest';
import { parseJudgeReply } from '../src/modules/scoring/judge-parse.js';

test.each([
  ['{"score": 7.25, "rationale": "Bien"}', { ok: true, score: 7.3, rationale: 'Bien' }],
  ['```json\n{"score": 9, "rationale": "Très bien"}\n```', { ok: true, score: 9, rationale: 'Très bien' }],
  ['Voici : {"score": 4, "rationale": "Moyen"} merci', { ok: true, score: 4, rationale: 'Moyen' }],
  ['{"score": 5, "rationale": "Accolade } et { dans une chaîne \\" ok"}', { ok: true, score: 5, rationale: 'Accolade } et { dans une chaîne " ok' }],
  ['{"score": 6, "rationale": "Ok", "extra": {"a": 1}}', { ok: true, score: 6, rationale: 'Ok' }],
  ['{"score": 0, "rationale": "Nul"}', { ok: true, score: 0, rationale: 'Nul' }],
  ['{"score": 10, "rationale": "Parfait"}', { ok: true, score: 10, rationale: 'Parfait' }],
])('lecture valide %#', (t, r) => {
  expect(parseJudgeReply(t)).toEqual(r);
});

test.each([
  '10/10',
  '{"score": 11, "rationale": "x"}',
  '{"score": -1, "rationale": "x"}',
  '{"score": "9", "rationale": "x"}',
  '{"score": 9}',
  '{"score": 9, "rationale": ""}',
  '{"score": 9, "rationale": "x"',
  '',
])('lecture invalide %s', (t) => {
  const r = parseJudgeReply(t);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
});

test('la justification est tronquée à 2 000 caractères', () => {
  const r = parseJudgeReply(JSON.stringify({ score: 8, rationale: 'a'.repeat(2_500) }));
  expect(r).toMatchObject({ ok: true, score: 8 });
  if (r.ok) expect(r.rationale).toHaveLength(2_000);
});
