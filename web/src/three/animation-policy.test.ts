import { afterEach, expect, test, vi } from 'vitest';
import { cappedPixelRatio, hasWebGL, resetWebGLProbe, shouldAnimate } from './animation-policy';

test.each([
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: true }, true],
  [{ reducedMotion: true, userPreference: true, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: false, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: false, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: false }, false],
])('shouldAnimate(%o) = %s', (s, expected) => {
  expect(shouldAnimate(s)).toBe(expected);
});

afterEach(() => {
  resetWebGLProbe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('hasWebGL renvoie false sans WebGL (jsdom), sans lever d’erreur', () => {
  expect(hasWebGL()).toBe(false);
});

test('hasWebGL libère le contexte de sonde et mémorise le résultat', () => {
  vi.stubGlobal('WebGLRenderingContext', class {});
  const loseContext = vi.fn();
  const getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation((() => ({ getExtension: () => ({ loseContext }) })) as never);
  expect(hasWebGL()).toBe(true);
  expect(hasWebGL()).toBe(true);
  expect(loseContext).toHaveBeenCalledTimes(1);
  expect(getContextSpy).toHaveBeenCalledTimes(1);
});

test.each([
  [1, 1],
  [2, 2],
  [3, 2],
  [0, 1],
  [NaN, 1],
])('cappedPixelRatio(%s) = %s', (input, expected) => {
  expect(cappedPixelRatio(input)).toBe(expected);
});
