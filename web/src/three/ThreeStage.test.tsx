import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FanoutFallback } from './FanoutFallback';
import { fanoutScene } from './fanout-scene';
import { ThreeStage } from './ThreeStage';

test('sans WebGL : le repli SVG est rendu, sans canevas', () => {
  render(<ThreeStage factory={fanoutScene} fallback={<FanoutFallback />} />);
  expect(screen.getByTestId('fanout-fallback')).toBeInTheDocument();
  expect(document.querySelector('canvas')).toBeNull();
});

test('le repli montre les huit logos, sans URL externe', () => {
  render(<FanoutFallback />);
  const images = Array.from(document.querySelectorAll('image'));
  expect(images).toHaveLength(8);
  images.forEach((img) => expect(img.getAttribute('href')).not.toMatch(/^https?:/));
});
