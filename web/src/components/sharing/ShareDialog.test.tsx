import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { MODELS, RANKING } from '../results/ranking.fixtures';
import { ShareDialog } from './ShareDialog';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const TOKEN = 'a'.repeat(32);
const link = { id: 'l1', runId: 'r1', runName: 'Polyvalence octobre', title: 'x', intro: null, verdicts: [], showCosts: false, showResponses: false, active: true, viewCount: 0, createdAt: '2026-10-17T12:00:00.000Z', updatedAt: '2026-10-17T12:00:00.000Z' };

// Bravo est le moins cher ; Alpha a le meilleur score global et la meilleure qualité.
const ranking = {
  ...RANKING,
  models: MODELS.map((m) => (m.modelId === 'b' ? { ...m, raw: { ...m.raw, meanCostUsd: 0.001 } } : m)),
};

let rankingBody: unknown;
let resultsBody: unknown;
let postError: ApiError | null;
beforeEach(() => {
  rankingBody = ranking;
  resultsBody = [];
  postError = null;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/runs/r1/ranking') return Promise.resolve(rankingBody);
    if (path === '/api/runs/r1/results') return Promise.resolve({ results: resultsBody });
    if (path === '/api/share-links' && init?.method === 'POST') return postError ? Promise.reject(postError) : Promise.resolve({ link, token: TOKEN });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderDialog() {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShareDialog open runId="r1" runName="Polyvalence octobre" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

test('Partager : verdicts proposés à partir du classement, modifiables ; création → lien affiché avec « Copier », retrouvable ensuite', async () => {
  const user = userEvent.setup();
  renderDialog();
  const title = await screen.findByLabelText('Titre de la page');
  expect(title).toHaveValue('Polyvalence octobre');

  // Coûts masqués par défaut : « Le moins cher » n'est pas proposé.
  const groups = screen.getAllByRole('group', { name: /^Verdict / });
  expect(groups).toHaveLength(2);
  const labels = groups.map((g) => within(g).getByLabelText('Titre du verdict') as HTMLInputElement);
  expect(labels.map((l) => l.value)).toEqual(['Meilleur compromis', 'Meilleure qualité']);
  const models = groups.map((g) => (within(g).getByLabelText('Modèle') as HTMLSelectElement).selectedOptions[0]!.textContent);
  expect(models).toEqual(['Alpha', 'Alpha']);

  // Modifier un titre, ajouter puis retirer un verdict libre.
  await user.clear(labels[0]!);
  await user.type(labels[0]!, 'Notre choix');
  await user.click(screen.getByRole('button', { name: 'Ajouter un verdict' }));
  expect(screen.getAllByRole('group', { name: /^Verdict / })).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Supprimer le verdict 3' }));

  // Afficher les coûts propose alors « Le moins cher » ; on le retire.
  await user.click(screen.getByRole('checkbox', { name: 'Afficher les coûts' }));
  expect(screen.getAllByRole('group', { name: /^Verdict / })).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Supprimer le verdict 3' }));
  await user.click(screen.getByRole('button', { name: 'Créer le lien' }));

  const post = apiFetch.mock.calls.find((c) => c[1]?.method === 'POST')!;
  expect(post[0]).toBe('/api/share-links');
  expect(post[1].body).toMatchObject({
    runId: 'r1',
    title: 'Polyvalence octobre',
    intro: null,
    showCosts: true,
    showResponses: false,
    verdicts: [
      { label: 'Notre choix', modelId: 'a' },
      { label: 'Meilleure qualité', modelId: 'a' },
    ],
  });

  const url = (await screen.findByLabelText('Lien de la page publique')) as HTMLInputElement;
  expect(url.value).toBe(`${location.origin}/p/${TOKEN}`);
  expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument();
  expect(screen.getByText(/retrouver à tout moment dans Admin → Liens de partage/)).toBeInTheDocument();
});

test('verdicts proposés marqués « auto » (recalculés à l’affichage) ; changer la phrase les fige, changer le titre non', async () => {
  const user = userEvent.setup();
  renderDialog();
  await screen.findByLabelText('Titre de la page');
  const [first, second] = screen.getAllByRole('group', { name: /^Verdict / });
  await user.type(within(first!).getByLabelText('Titre du verdict'), ' !');
  const phrase = within(second!).getByRole('textbox', { name: /Phrase/ });
  await user.clear(phrase);
  await user.type(phrase, 'Alpha, de loin.');
  await user.click(screen.getByRole('button', { name: 'Créer le lien' }));
  const post = await waitFor(() => apiFetch.mock.calls.find((c) => c[1]?.method === 'POST')!);
  const [global, quality] = post[1].body.verdicts;
  expect(global).toMatchObject({ label: 'Meilleur compromis !', auto: 'global' });
  expect(quality).toEqual({ label: 'Meilleure qualité', modelId: 'a', text: 'Alpha, de loin.' });
});

test('« Le moins cher » n’est pas proposé sans aucun coût, même coûts affichés', async () => {
  rankingBody = { ...ranking, models: ranking.models.map((m) => ({ ...m, raw: { ...m.raw, meanCostUsd: null } })) };
  const user = userEvent.setup();
  renderDialog();
  await screen.findByLabelText('Titre de la page');
  await user.click(screen.getByRole('checkbox', { name: 'Afficher les coûts' }));
  const labels = screen.getAllByLabelText('Titre du verdict').map((l) => (l as HTMLInputElement).value);
  expect(labels).toEqual(['Meilleur compromis', 'Meilleure qualité']);
});

test('refus du serveur : message en français et lien non affiché', async () => {
  postError = new ApiError('verdict_model_not_in_run', 400, 'x');
  const user = userEvent.setup();
  renderDialog();
  await user.click(await screen.findByRole('button', { name: 'Créer le lien' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ne fait pas partie de cette série');
  await waitFor(() => expect(screen.queryByLabelText('Lien de la page publique')).toBeNull());
});

test('« Le moins cher » : proposé en cochant les coûts ; décocher avec ce verdict présent affiche une remarque', async () => {
  const user = userEvent.setup();
  renderDialog();
  await screen.findByLabelText('Titre de la page');
  expect(screen.getAllByLabelText('Titre du verdict')).toHaveLength(2);
  await user.click(screen.getByRole('checkbox', { name: 'Afficher les coûts' }));
  expect(screen.getAllByLabelText('Titre du verdict').map((l) => (l as HTMLInputElement).value)).toContain('Le moins cher');
  expect(screen.queryByText(/révèle l’ordre des coûts/)).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Afficher les coûts' }));
  expect(screen.getByText(/révèle l’ordre des coûts/)).toBeInTheDocument();
});

test('questions manuelles : avertissement sous « Afficher les réponses »', async () => {
  resultsBody = [{ id: 'x', scoreStatus: 'awaiting_manual', hiddenUntilScored: true }];
  renderDialog();
  expect(await screen.findByText(/lève l’aveugle/)).toBeInTheDocument();
});

test('sans question manuelle : pas d’avertissement', async () => {
  resultsBody = [{ id: 'x', scoreStatus: 'done', hiddenUntilScored: false }];
  renderDialog();
  await screen.findByLabelText('Titre de la page');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/results'));
  expect(screen.queryByText(/lève l’aveugle/)).toBeNull();
});

test('lien affiché : Échap ne ferme pas la fenêtre, seul « Fermer » la ferme ; un seul titre accessible', async () => {
  const user = userEvent.setup();
  const onClose = renderDialog();
  await user.click(await screen.findByRole('button', { name: 'Créer le lien' }));
  await screen.findByLabelText('Lien de la page publique');
  expect(screen.getByRole('dialog', { name: 'Lien de partage créé' })).not.toHaveAttribute('aria-describedby');
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Lien de la page publique')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('envoi en cours : Échap ignoré', async () => {
  let release!: (v: unknown) => void;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/runs/r1/ranking') return Promise.resolve(rankingBody);
    if (path === '/api/runs/r1/results') return Promise.resolve({ results: [] });
    if (path === '/api/share-links' && init?.method === 'POST') return new Promise((r) => (release = r));
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  const user = userEvent.setup();
  const onClose = renderDialog();
  await user.click(await screen.findByRole('button', { name: 'Créer le lien' }));
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  release({ link, token: TOKEN });
  await screen.findByLabelText('Lien de la page publique');
});
