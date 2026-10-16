import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { BurstFallback } from './BurstFallback';
import { burstScene } from './burst-scene';
import { ThreeStage } from './ThreeStage';

test('sans WebGL : le repli SVG est rendu, sans canevas', () => {
  render(<ThreeStage factory={burstScene} fallback={<BurstFallback />} />);
  expect(screen.getByTestId('burst-fallback')).toBeInTheDocument();
  expect(document.querySelector('canvas')).toBeNull();
});
