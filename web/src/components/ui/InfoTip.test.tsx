import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { InfoTip } from './InfoTip';

function renderTip() {
  render(
    <div data-testid="carte" style={{ overflow: 'hidden' }}>
      <InfoTip label="Qualité">Note moyenne sur 100.</InfoTip>
    </div>,
  );
  return { button: screen.getByRole('button', { name: 'Aide : Qualité' }), bubble: screen.getByRole('tooltip', { hidden: true }) };
}

test('bulle rendue hors de son conteneur (aucune carte ne peut la couper), reliée par aria-describedby', () => {
  const { button, bubble } = renderTip();
  expect(screen.getByTestId('carte')).not.toContainElement(bubble);
  expect(bubble.parentElement).toBe(document.body);
  expect(button).toHaveAccessibleDescription('Note moyenne sur 100.');
  expect(bubble).toHaveClass('fixed', 'invisible', 'no-print');
});

test('survol : ouverte, puis fermée au départ du pointeur', async () => {
  const user = userEvent.setup();
  const { button, bubble } = renderTip();
  await user.hover(button);
  expect(bubble).toHaveClass('visible');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await user.unhover(button);
  expect(bubble).toHaveClass('invisible');
});

test('clavier : ouverte au focus, fermée par Échap ou au départ du focus', async () => {
  const user = userEvent.setup();
  const { button, bubble } = renderTip();
  await user.tab();
  expect(button).toHaveFocus();
  expect(bubble).toHaveClass('visible');
  await user.keyboard('{Escape}');
  expect(bubble).toHaveClass('invisible');
  await user.tab({ shift: true });
  await user.tab();
  expect(bubble).toHaveClass('visible');
  await user.tab();
  expect(bubble).toHaveClass('invisible');
});
