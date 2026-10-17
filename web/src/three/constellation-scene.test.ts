import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, test } from 'vitest';
import { ConstellationFallback } from './ConstellationFallback';
import {
  FIRST_ORBIT,
  MAX_ORBIT,
  MAX_RADIUS,
  MAX_SPEED,
  MIN_RADIUS,
  MIN_SPEED,
  UNRATED_COLOR,
  UNRATED_RADIUS,
  astreColor,
  astreRadius,
  flowCount,
  orbitPosition,
  orbitRadius,
  orbitSpeed,
  starCount,
} from './constellation-scene';
import { ThreeStage } from './ThreeStage';
import { constellationScene } from './constellation-scene';

test('tailles proportionnelles à la qualité, astre gris pour un modèle non noté', () => {
  expect(astreRadius(0)).toBeCloseTo(MIN_RADIUS);
  expect(astreRadius(10)).toBeCloseTo(MAX_RADIUS);
  expect(astreRadius(5)).toBeCloseTo((MIN_RADIUS + MAX_RADIUS) / 2);
  expect(astreRadius(8)).toBeGreaterThan(astreRadius(6));
  // Bornée : une note hors échelle ne dépasse pas.
  expect(astreRadius(42)).toBeCloseTo(MAX_RADIUS);
  expect(astreRadius(-3)).toBeCloseTo(MIN_RADIUS);
  // Non noté : le plus petit de tous, gris.
  expect(astreRadius(null)).toBe(UNRATED_RADIUS);
  expect(UNRATED_RADIUS).toBeLessThan(astreRadius(0));
  expect(astreColor('#F0631F', null)).toBe(UNRATED_COLOR);
  expect(astreColor('#F0631F', 0)).toBe('#F0631F');
});

test('vitesse d’orbite croissante avec le débit, bornée', () => {
  expect(orbitSpeed(null, 100)).toBe(MIN_SPEED);
  expect(orbitSpeed(0, 100)).toBe(MIN_SPEED);
  expect(orbitSpeed(50, 0)).toBe(MIN_SPEED);
  expect(orbitSpeed(100, 100)).toBeCloseTo(MAX_SPEED);
  expect(orbitSpeed(500, 100)).toBeCloseTo(MAX_SPEED);
  expect(orbitSpeed(80, 100)).toBeGreaterThan(orbitSpeed(40, 100));
  expect(orbitSpeed(40, 100)).toBeGreaterThan(MIN_SPEED);
});

test('orbites : régulières, plafonnées, positions sur le cercle ; particules et étoiles réduites sur mobile', () => {
  expect(orbitRadius(0, 1)).toBe(FIRST_ORBIT);
  expect(orbitRadius(3, 4)).toBeGreaterThan(orbitRadius(2, 4));
  expect(orbitRadius(39, 40)).toBeCloseTo(MAX_ORBIT);
  const p = orbitPosition(3, 0.4, 1.1, 5);
  expect(Math.hypot(p.x, p.z)).toBeCloseTo(3);
  expect(Math.abs(p.y)).toBeLessThanOrEqual(0.08);
  expect(flowCount(true)).toBe(flowCount(false) / 2);
  expect(starCount(true)).toBe(starCount(false) / 2);
});

test('sans WebGL : repli SVG avec un astre par modèle', async () => {
  const data = {
    models: [
      { id: 'a', color: '#F0631F', quality: 9, tokensPerS: 60 },
      { id: 'b', color: '#3FA2E0', quality: null, tokensPerS: null },
    ],
  };
  render(
    createElement(ThreeStage, {
      factory: constellationScene,
      fallback: createElement(ConstellationFallback, { data }),
      data,
    }),
  );
  expect(document.querySelector('canvas')).toBeNull();
  const astres = screen.getAllByTestId('constellation-astre');
  expect(astres).toHaveLength(2);
  const fills = astres.map((g) => g.querySelectorAll('circle')[1]!.getAttribute('fill'));
  expect(fills).toEqual(['#F0631F', UNRATED_COLOR]);
});
