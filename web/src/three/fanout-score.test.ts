import { expect, test } from 'vitest';
import { formatScore, podiumLabel, randomScore } from './fanout-score';

test('randomScore : entier entre 64 et 98', () => {
  expect(randomScore(() => 0)).toBe(64);
  expect(randomScore(() => 0.999999)).toBe(98);
  for (let i = 0; i < 200; i++) {
    const s = randomScore();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(64);
    expect(s).toBeLessThanOrEqual(98);
  }
});

test('formatScore : le nombre seul, sans « / 10 »', () => {
  expect(formatScore(87)).toBe('87');
  expect(formatScore(86.6)).toBe('87');
});

test('podiumLabel : médailles pour les trois premiers, nombre seul ensuite', () => {
  expect(podiumLabel(0, 87)).toBe('🥇 87');
  expect(podiumLabel(1, 85)).toBe('🥈 85');
  expect(podiumLabel(2, 82)).toBe('🥉 82');
  expect(podiumLabel(3, 80)).toBe('80');
});
