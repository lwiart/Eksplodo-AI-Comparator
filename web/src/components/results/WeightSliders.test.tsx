import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, expect, test, vi } from 'vitest';
import type { Weights } from '../../api/runs';
import { WeightSliders } from './WeightSliders';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

function Harness({ onChange }: { onChange(w: Weights): void }) {
  const [w, setW] = useState<Weights>({ quality: 50, speed: 20, cost: 20, reliability: 10 });
  return (
    <WeightSliders
      value={w}
      onChange={(next) => {
        setW(next);
        onChange(next);
      }}
    />
  );
}

test('curseurs : changer la qualité réajuste les autres pour garder 100', async () => {
  const user = userEvent.setup();
  const seen: Weights[] = [];
  render(<Harness onChange={(w) => seen.push(w)} />);
  screen.getByRole('slider', { name: 'Qualité' }).focus();
  await user.keyboard('{ArrowRight>10/}');
  expect(seen.at(-1)).toEqual({ quality: 60, speed: 16, cost: 16, reliability: 8 });
  for (const w of seen) expect(w.quality + w.speed + w.cost + w.reliability).toBe(100);
  expect(screen.getByRole('slider', { name: 'Vitesse' })).toHaveAttribute('aria-valuenow', '16');
  expect(screen.getByText('60 %')).toBeInTheDocument();
});

test('second geste sur le même curseur : repart des poids après le premier geste', async () => {
  const user = userEvent.setup();
  const seen: Weights[] = [];
  render(<Harness onChange={(w) => seen.push(w)} />);
  const quality = screen.getByRole('slider', { name: 'Qualité' });
  quality.focus();
  await user.keyboard('{ArrowRight>10/}'); // 60 / 16 / 16 / 8
  await user.keyboard('{Tab}');
  quality.focus();
  await user.keyboard('{ArrowRight>10/}'); // 70 depuis 60/16/16/8 : 12 / 12 / 6
  expect(seen.at(-1)).toEqual({ quality: 70, speed: 12, cost: 12, reliability: 6 });
});

test('retour depuis 100 : le reste est partagé à parts égales', async () => {
  const user = userEvent.setup();
  const seen: Weights[] = [];
  render(<Harness onChange={(w) => seen.push(w)} />);
  const quality = screen.getByRole('slider', { name: 'Qualité' });
  quality.focus();
  await user.keyboard('{End}');
  expect(seen.at(-1)).toEqual({ quality: 100, speed: 0, cost: 0, reliability: 0 });
  // Dans le même geste, revenir en arrière retrouve les proportions de départ.
  await user.keyboard('{ArrowLeft>40/}');
  expect(seen.at(-1)).toEqual({ quality: 60, speed: 16, cost: 16, reliability: 8 });
  // Nouveau geste depuis 100 : parts égales.
  await user.keyboard('{End}');
  await user.keyboard('{Tab}');
  quality.focus();
  await user.keyboard('{ArrowLeft>40/}');
  expect(seen.at(-1)).toEqual({ quality: 60, speed: 14, cost: 13, reliability: 13 });
});
