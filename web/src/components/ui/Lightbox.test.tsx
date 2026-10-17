import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { expect, test } from 'vitest';
import { AttachmentGallery } from './AttachmentGallery';
import type { LightboxItem } from './Lightbox';

const items: LightboxItem[] = [
  { name: 'schéma.png', mime: 'image/png', viewUrl: '/f/1?inline=1', downloadUrl: '/f/1' },
  { name: 'énoncé.pdf', mime: 'application/pdf', viewUrl: '/f/2?inline=1', downloadUrl: '/f/2', pages: 3 },
  { name: 'photo.jpg', mime: 'image/jpeg', viewUrl: '/f/3?inline=1', downloadUrl: '/f/3' },
];

function setup(list = items) {
  const user = userEvent.setup();
  render(<AttachmentGallery items={list} />);
  return user;
}

const dialog = () => screen.getByRole('dialog');

test('vignettes : image affichée, tuile PDF avec ses pages, nom en lien de téléchargement', () => {
  setup();
  const gallery = screen.getByRole('list', { name: 'Pièces jointes' });
  expect(within(gallery).getAllByRole('button')).toHaveLength(3);
  expect(within(gallery).getByRole('button', { name: 'Afficher énoncé.pdf' })).toHaveTextContent('PDF3 pages');
  const link = within(gallery).getByRole('link', { name: 'schéma.png' });
  expect(link).toHaveAttribute('href', '/f/1');
  expect(link).toHaveAttribute('download', 'schéma.png');
});

test('ouverture : image en grand, nom, position et bouton Télécharger sans inline', async () => {
  const user = setup();
  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  expect(within(dialog()).getByRole('heading', { name: 'schéma.png' })).toBeInTheDocument();
  expect(within(dialog()).getByRole('img', { name: 'schéma.png' })).toHaveAttribute('src', '/f/1?inline=1');
  expect(within(dialog()).getByText('1 / 3')).toBeInTheDocument();
  const download = within(dialog()).getByRole('link', { name: 'Télécharger' });
  expect(download).toHaveAttribute('href', '/f/1');
  expect(download).toHaveAttribute('download', 'schéma.png');
});

test('navigation : boutons et flèches du clavier, en boucle ; PDF dans une iframe inline', async () => {
  const user = setup();
  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  await user.click(within(dialog()).getByRole('button', { name: 'Pièce suivante' }));
  const frame = dialog().querySelector('iframe');
  expect(frame).toHaveAttribute('title', 'énoncé.pdf');
  expect(frame).toHaveAttribute('src', '/f/2?inline=1');
  expect(within(dialog()).queryByRole('img')).toBeNull();
  expect(within(dialog()).getByText('2 / 3')).toBeInTheDocument();
  await user.keyboard('{ArrowRight}');
  expect(within(dialog()).getByRole('heading', { name: 'photo.jpg' })).toBeInTheDocument();
  await user.keyboard('{ArrowRight}');
  expect(within(dialog()).getByRole('heading', { name: 'schéma.png' })).toBeInTheDocument();
  await user.keyboard('{ArrowLeft}');
  expect(within(dialog()).getByRole('heading', { name: 'photo.jpg' })).toBeInTheDocument();
  await user.click(within(dialog()).getByRole('button', { name: 'Pièce précédente' }));
  expect(within(dialog()).getByRole('heading', { name: 'énoncé.pdf' })).toBeInTheDocument();
});

test('Échap ferme et rend le focus à la vignette qui a ouvert', async () => {
  const user = setup();
  const thumb = screen.getByRole('button', { name: 'Afficher énoncé.pdf' });
  await user.click(thumb);
  expect(dialog()).toBeInTheDocument();
  expect(dialog()).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(thumb).toHaveFocus();
});

test('fermeture par le bouton Fermer et par un clic sur le fond, pas par un clic sur la pièce', async () => {
  const user = setup();
  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  await user.click(within(dialog()).getByRole('img', { name: 'schéma.png' }));
  expect(screen.queryByRole('dialog')).not.toBeNull();
  await user.click(within(dialog()).getByRole('button', { name: 'Fermer' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  const stage = within(dialog()).getByRole('img', { name: 'schéma.png' }).parentElement!;
  await user.click(stage);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('une seule pièce : ni position ni boutons de navigation', async () => {
  const user = setup([items[0]!]);
  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  expect(within(dialog()).queryByRole('button', { name: 'Pièce suivante' })).toBeNull();
  expect(within(dialog()).queryByText('1 / 1')).toBeNull();
  await user.keyboard('{ArrowRight}');
  expect(within(dialog()).getByRole('heading', { name: 'schéma.png' })).toBeInTheDocument();
});

test('aucune pièce : rien n’est rendu', () => {
  const { container } = render(<AttachmentGallery items={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('StrictMode (comme l’application) : Échap rend toujours le focus à la vignette', async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <AttachmentGallery items={items} />
    </StrictMode>,
  );
  const thumb = screen.getByRole('button', { name: 'Afficher photo.jpg' });
  await user.click(thumb);
  await user.keyboard('{ArrowLeft}');
  expect(within(dialog()).getByRole('heading', { name: 'énoncé.pdf' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(thumb).toHaveFocus();
});

test('image ajustée à la zone : un clic dans les bandes vides autour de l’image ferme, un clic sur l’image non', async () => {
  const user = setup([items[0]!]);
  await user.click(screen.getByRole('button', { name: 'Afficher schéma.png' }));
  const img = within(dialog()).getByRole('img', { name: 'schéma.png' }) as HTMLImageElement;
  // Image 640 × 400 dans une zone 1000 × 400 : rendue sur 640 de large, bandes vides de 180 à gauche et à droite.
  Object.defineProperty(img, 'naturalWidth', { value: 640 });
  Object.defineProperty(img, 'naturalHeight', { value: 400 });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 400, right: 1000, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  await user.pointer({ keys: '[MouseLeft]', target: img, coords: { clientX: 500, clientY: 200 } });
  expect(screen.queryByRole('dialog')).not.toBeNull();
  await user.pointer({ keys: '[MouseLeft]', target: img, coords: { clientX: 90, clientY: 200 } });
  expect(screen.queryByRole('dialog')).toBeNull();
});
