import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { Dialog } from './Dialog';

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Partager la série">
      <p>Contenu</p>
    </Dialog>
  );
}

test('pas de croix : Échap ferme la fenêtre', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByRole('dialog', { name: 'Partager la série' })).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});
