import { expect, test, vi } from 'vitest';
import { createInteractionGate } from './interaction-gate';

function fakeMql(matches: boolean) {
  let handler: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches,
    addEventListener: vi.fn((_: string, h: (e: { matches: boolean }) => void) => (handler = h)),
    removeEventListener: vi.fn((_: string, h: unknown) => {
      if (handler === h) handler = null;
    }),
  };
  return {
    mql: mql as unknown as MediaQueryList,
    raw: mql,
    fire(m: boolean) {
      mql.matches = m;
      handler?.({ matches: m });
    },
  };
}

test('attache une seule fois quand la condition est déjà vraie', () => {
  const f = fakeMql(true);
  const hooks = { attach: vi.fn(), detach: vi.fn() };
  createInteractionGate(f.mql, hooks);
  expect(hooks.attach).toHaveBeenCalledTimes(1);
  f.fire(true);
  expect(hooks.attach).toHaveBeenCalledTimes(1);
  expect(hooks.detach).not.toHaveBeenCalled();
});

test("n'attache rien tant que la condition est fausse", () => {
  const f = fakeMql(false);
  const hooks = { attach: vi.fn(), detach: vi.fn() };
  createInteractionGate(f.mql, hooks);
  f.fire(false);
  expect(hooks.attach).not.toHaveBeenCalled();
  expect(hooks.detach).not.toHaveBeenCalled();
});

test('détache au passage à faux, rattache au retour à vrai', () => {
  const f = fakeMql(true);
  const hooks = { attach: vi.fn(), detach: vi.fn() };
  createInteractionGate(f.mql, hooks);
  f.fire(false);
  expect(hooks.detach).toHaveBeenCalledTimes(1);
  f.fire(false);
  expect(hooks.detach).toHaveBeenCalledTimes(1);
  f.fire(true);
  expect(hooks.attach).toHaveBeenCalledTimes(2);
});

test('plus aucun appel après dispose, et l’écouteur est retiré', () => {
  const f = fakeMql(false);
  const hooks = { attach: vi.fn(), detach: vi.fn() };
  const gate = createInteractionGate(f.mql, hooks);
  gate.dispose();
  expect(f.raw.removeEventListener).toHaveBeenCalledTimes(1);
  f.fire(true);
  f.fire(false);
  expect(hooks.attach).not.toHaveBeenCalled();
  expect(hooks.detach).not.toHaveBeenCalled();
});
