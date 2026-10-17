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

test('Markdown : une image distante n’est pas rendue en <img> (texte alternatif à la place)', () => {
  const { container } = render(<Markdown text="![schéma](https://tiers.example/pixel.png)" />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.innerHTML).not.toContain('tiers.example');
  expect(screen.getByText('schéma')).toBeInTheDocument();
});

test('Markdown : un lien javascript: n’aboutit pas à un href exécutable', () => {
  const { container } = render(<Markdown text="[clic](javascript:alert(1))" />);
  expect(container.innerHTML.toLowerCase()).not.toContain('javascript:');
});

test('Markdown : sur la page publique, un lien relatif est rendu comme du texte, un lien externe reste un lien', () => {
  render(<Markdown relativeLinksAsText text="[admin](/admin) et [exemple](https://example.test/page)" />);
  expect(screen.queryByRole('link', { name: 'admin' })).toBeNull();
  expect(screen.getByText('admin')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'exemple' })).toHaveAttribute('href', 'https://example.test/page');
});

test('Markdown : hors page publique, un lien relatif reste un lien', () => {
  render(<Markdown text="[admin](/admin)" />);
  expect(screen.getByRole('link', { name: 'admin' })).toHaveAttribute('href', '/admin');
});
