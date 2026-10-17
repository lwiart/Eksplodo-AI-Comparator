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

test('le repli affiche une note entière sur 100, sans « / 10 »', () => {
  render(<FanoutFallback />);
  const svg = screen.getByTestId('fanout-fallback');
  expect(svg.textContent).not.toContain('/ 10');
  const scores = Array.from(svg.querySelectorAll('text'))
    .map((t) => t.textContent?.trim() ?? '')
    .filter((t) => /^\d+(\.\d+)?$/.test(t));
  expect(scores).toEqual(['87']);
  expect(Number.isInteger(Number(scores[0]))).toBe(true);
});
