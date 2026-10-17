import { expect, test } from 'vitest';
import { magnetOffset, pickNearest, springStep, type Vec3 } from './fanout-physics';

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const K = 70;
const C = 6.5;

test('ressort : converge vers la cible et la dépasse au moins une fois (rebond)', () => {
  const pos = v(0, 0, 0);
  const vel = v();
  const target = v(2, -1, 0);
  let overshoot = false;
  for (let i = 0; i < 60 * 6; i++) {
    springStep(pos, vel, target, K, C, 1 / 60);
    if (pos.x > target.x + 1e-3) overshoot = true;
  }
  expect(overshoot).toBe(true);
  expect(pos.x).toBeCloseTo(2, 2);
  expect(pos.y).toBeCloseTo(-1, 2);
  expect(Math.hypot(vel.x, vel.y)).toBeLessThan(1e-2);
});

test('ressort : immobile quand il est déjà sur la cible', () => {
  const pos = v(1, 1, 0);
  const vel = v();
  springStep(pos, vel, v(1, 1, 0), K, C, 1 / 60);
  expect(pos).toEqual(v(1, 1, 0));
});

test('aimant : nul hors du rayon et sur la souris elle-même', () => {
  expect(magnetOffset(v(0, 0), v(2, 0), 1.6, 0.35)).toEqual(v());
  expect(magnetOffset(v(0, 0), v(1.6, 0), 1.6, 0.35)).toEqual(v());
  expect(magnetOffset(v(1, 1), v(1, 1), 1.6, 0.35)).toEqual(v());
});

test('aimant : dirigé vers la souris et sans jamais la dépasser', () => {
  for (let d = 0.01; d < 1.6; d += 0.01) {
    const o = magnetOffset(v(0, 0), v(d, 0), 1.6, 0.35);
    expect(o.x).toBeGreaterThan(0);
    expect(o.y).toBeCloseTo(0, 9);
    expect(o.x).toBeLessThanOrEqual(d + 1e-9);
  }
  // en diagonale : même longueur, bonne direction
  const o = magnetOffset(v(0, 0), v(0.3, 0.4), 1.6, 0.35);
  expect(Math.hypot(o.x, o.y)).toBeCloseTo(Math.min(0.5, 0.35 * (1 - 0.5 / 1.6)), 9);
  expect(o.x / o.y).toBeCloseTo(0.75, 9);
});

test("aimant : s'annule au bord du rayon", () => {
  const o = magnetOffset(v(0, 0), v(1.6 - 1e-6, 0), 1.6, 0.35);
  expect(Math.hypot(o.x, o.y)).toBeLessThan(1e-5);
});

test('pickNearest : le plus proche dans le rayon, sinon -1', () => {
  const pts = [v(0, 0), v(3, 0), v(1, 0)];
  expect(pickNearest(pts, v(0.9, 0.1), 0.6)).toBe(2);
  expect(pickNearest(pts, v(0.2, 0), 0.6)).toBe(0);
  expect(pickNearest(pts, v(5, 5), 0.6)).toBe(-1);
  expect(pickNearest([], v(0, 0), 0.6)).toBe(-1);
});
