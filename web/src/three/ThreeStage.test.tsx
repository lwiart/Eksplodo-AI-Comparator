import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { resetWebGLProbe } from './animation-policy';
import type { SceneFactory } from './useThreeScene';
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

function stubWebGL() {
  vi.stubGlobal('WebGLRenderingContext', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ getExtension: () => null })) as never);
}

afterEach(() => {
  resetWebGLProbe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeScene() {
  const scene = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn(), setData: vi.fn() };
  const factory: SceneFactory = () => scene;
  return { scene, factory };
}

test('perte du contexte WebGL → repli 2D', async () => {
  stubWebGL();
  const { scene, factory } = fakeScene();
  render(<ThreeStage factory={factory} fallback={<div data-testid="repli" />} />);
  await waitFor(() => expect(scene.render).toHaveBeenCalled());
  const canvas = document.querySelector('canvas')!;
  const event = new Event('webglcontextlost', { cancelable: true });
  act(() => {
    canvas.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(screen.getByTestId('repli')).toBeInTheDocument());
  expect(scene.dispose).toHaveBeenCalled();
});

test('setData reçoit les données initiales puis chaque mise à jour', async () => {
  stubWebGL();
  const { scene, factory } = fakeScene();
  const { rerender } = render(<ThreeStage factory={factory} fallback={null} data={{ n: 1 }} />);
  await waitFor(() => expect(scene.setData).toHaveBeenCalledWith({ n: 1 }));
  rerender(<ThreeStage factory={factory} fallback={null} data={{ n: 2 }} />);
  await waitFor(() => expect(scene.setData).toHaveBeenLastCalledWith({ n: 2 }));
  expect(scene.setData).toHaveBeenCalledTimes(2);
});
