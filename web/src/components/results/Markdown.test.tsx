import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Markdown } from './Markdown';

test('Markdown : <script> et <img onerror> non interprétés', () => {
  const { container } = render(
    <Markdown text={'Bonjour <script>window.pwned = 1</script> <img src=x onerror="window.pwned = 2"> **fin**'} />,
  );
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(container.innerHTML).not.toContain('onerror');
  expect(screen.getByText('fin').tagName).toBe('STRONG');
});

test('Markdown : liens externes en nouvel onglet avec rel="noopener noreferrer"', () => {
  render(<Markdown text="[exemple](https://example.test/page)" />);
  const link = screen.getByRole('link', { name: 'exemple' });
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
