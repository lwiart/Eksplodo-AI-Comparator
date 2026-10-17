import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { PublicAttachment } from '../../api/tests';
import { AttachmentsField } from './AttachmentsField';

const attachment = (over: Partial<PublicAttachment>): PublicAttachment =>
  ({ id: 'a1', originalName: 'plan.png', mime: 'image/png', size: 2048, pages: null, ...over }) as PublicAttachment;

const list = [attachment({}), attachment({ id: 'a2', originalName: 'cctp.pdf', mime: 'application/pdf', pages: 3 })];

test('éditeur : vignette qui ouvre la visionneuse, nom toujours en lien de téléchargement', async () => {
  const user = userEvent.setup();
  render(<AttachmentsField testId="t1" attachments={list} onAdded={vi.fn()} onRemoved={vi.fn()} />);
  expect(screen.getByRole('link', { name: /plan\.png/ })).toHaveAttribute('href', '/api/tests/t1/attachments/a1/download');
  expect(screen.getByRole('button', { name: 'Afficher plan.png' }).querySelector('img')).toHaveAttribute(
    'src',
    '/api/tests/t1/attachments/a1/download?inline=1',
  );

  await user.click(screen.getByRole('button', { name: 'Afficher cctp.pdf' }));
  const dialog = screen.getByRole('dialog', { name: 'cctp.pdf' });
  expect(dialog.querySelector('iframe')).toHaveAttribute('src', '/api/tests/t1/attachments/a2/download?inline=1');
  expect(within(dialog).getByRole('link', { name: 'Télécharger' })).toHaveAttribute('href', '/api/tests/t1/attachments/a2/download');
  expect(within(dialog).getByText('2 / 2')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Afficher cctp.pdf' })).toHaveFocus();
});
