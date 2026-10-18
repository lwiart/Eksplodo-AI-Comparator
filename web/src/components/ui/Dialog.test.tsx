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

test('la croix en haut à droite ferme la fenêtre', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByRole('dialog', { name: 'Partager la série' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fermer la fenêtre' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
