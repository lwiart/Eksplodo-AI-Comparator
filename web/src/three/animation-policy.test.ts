import { expect, test } from 'vitest';
import { hasWebGL, shouldAnimate } from './animation-policy';

test.each([
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: true }, true],
  [{ reducedMotion: true, userPreference: true, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: false, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: false, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: false }, false],
])('shouldAnimate(%o) = %s', (s, expected) => {
  expect(shouldAnimate(s)).toBe(expected);
});

test('hasWebGL renvoie false sans WebGL (jsdom), sans lever d’erreur', () => {
  expect(hasWebGL()).toBe(false);
});
