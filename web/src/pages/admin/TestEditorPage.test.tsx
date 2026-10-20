import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { TestEditorPage } from './TestEditorPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
  csrfToken: () => Promise.resolve('jeton'),
}));

const SAVED = {
  id: 't1',
  name: 'Résumer un CCTP',
  category: 'Rédaction',
  tags: ['marchés'],
  systemPrompt: null,
  userPrompt: 'Résume le CCTP',
  temperature: 0.2,
  maxTokens: 1000,
  scoringMethod: 'manual',
  scoringConfig: {},
  archivedAt: null,
  attachments: [],
  usedInRuns: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

type Call = { path: string; init?: { method?: string; body?: unknown } };
const writes = () => apiFetch.mock.calls.filter((c) => c[1]?.method === 'POST' || c[1]?.method === 'PUT');

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: Call['init']) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: ['Rédaction'], tags: ['marchés'] });
    if (path === '/api/models') return Promise.resolve({ models: [] });
    if (path === '/api/tests/t1' && !init?.method) return Promise.resolve({ test: SAVED });
    if (path === '/api/tests' && init?.method === 'POST') return Promise.resolve({ test: { ...SAVED, ...(init.body as object) } });
    if (path === '/api/tests/t1' && init?.method === 'PUT') return Promise.resolve({ test: { ...SAVED, ...(init.body as object) } });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/tests/nouveau" element={<TestEditorPage />} />
          <Route path="/admin/tests/:id" element={<TestEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Nom'), 'Nouveau test');
  await user.type(screen.getByLabelText('Catégorie'), 'Rédaction');
  await user.type(screen.getByLabelText('Prompt utilisateur'), 'Bonjour');
}

test('éditeur : valeurs par défaut 0,2 et 1 000 ; max tokens 50 001 refusé avant envoi', async () => {
  const user = userEvent.setup();
  renderAt('/admin/tests/nouveau');
  expect(await screen.findByLabelText('Température')).toHaveValue('0,2');
  const max = screen.getByLabelText('Max tokens');
  expect(max).toHaveValue('1 000');

  await fillRequired(user);
  await user.clear(max);
  await user.type(max, '50001');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByText(/entre 1 et 50 000/)).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('éditeur : la virgule décimale est acceptée et le test créé est envoyé', async () => {
  const user = userEvent.setup();
  renderAt('/admin/tests/nouveau');
  await fillRequired(user);
  const temp = screen.getByLabelText('Température');
  await user.clear(temp);
  await user.type(temp, '0,7');
  await user.type(screen.getByLabelText('Tags'), 'marchés, pdf , ');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual([
    '/api/tests',
    {
      method: 'POST',
      body: {
        name: 'Nouveau test',
        category: 'Rédaction',
        tags: ['marchés', 'pdf'],
        systemPrompt: null,
        userPrompt: 'Bonjour',
        temperature: 0.7,
        maxTokens: 1000,
        scoringMethod: 'manual',
        scoringConfig: {},
      },
    },
  ]);
});

test('méthode « Réponse attendue » : modes exact / contient / regex ; regex invalide signalée', async () => {
  const user = userEvent.setup();
  renderAt('/admin/tests/nouveau');
  await fillRequired(user);
  await user.click(screen.getByRole('radio', { name: 'Réponse attendue' }));

  // Texte exact (défaut).
  await user.type(screen.getByLabelText('Texte attendu'), 'Paris');
  // Contient.
  await user.click(screen.getByRole('radio', { name: 'Contient' }));
  await user.type(screen.getByLabelText('Éléments attendus (un par ligne)'), 'objet{enter}durée');
  // Expression régulière invalide.
  await user.click(screen.getByRole('radio', { name: 'Expression régulière' }));
  // Type d'expression attendu précisé sous les champs, et petite documentation dans une aide « ? ».
  expect(screen.getByText(/Expression régulière JavaScript, écrite sans les barres obliques autour/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aide : Écrire une expression régulière' })).toHaveAccessibleDescription(/1957 seul, pas 19570/);
  await user.type(screen.getByLabelText('Motif'), '([[');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByText('Expression régulière invalide')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);

  // Motif corrigé.
  const motif = screen.getByLabelText('Motif');
  await user.clear(motif);
  await user.type(motif, '^\\d+$');
  await user.type(screen.getByLabelText('Drapeaux'), 'i');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = (writes()[0]![1] as { body: { scoringMethod: string; scoringConfig: unknown } }).body;
  expect(body.scoringMethod).toBe('expected');
  expect(body.scoringConfig).toEqual({ mode: 'regex', pattern: '^\\d+$', flags: 'i' });
});

test('méthode « Réponse attendue » : mode « contient » envoie un élément par ligne', async () => {
  const user = userEvent.setup();
  renderAt('/admin/tests/nouveau');
  await fillRequired(user);
  await user.click(screen.getByRole('radio', { name: 'Réponse attendue' }));
  await user.click(screen.getByRole('radio', { name: 'Contient' }));
  await user.type(screen.getByLabelText('Éléments attendus (un par ligne)'), 'objet{enter}{enter}durée');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = (writes()[0]![1] as { body: { scoringConfig: unknown } }).body;
  expect(body.scoringConfig).toEqual({ mode: 'contains', items: ['objet', 'durée'], ignoreCase: true });
});

test('méthode « IA-juge » : critères obligatoires, référence facultative', async () => {
  const user = userEvent.setup();
  renderAt('/admin/tests/nouveau');
  await fillRequired(user);
  await user.click(screen.getByRole('radio', { name: 'IA-juge' }));
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByText('Les critères du juge sont obligatoires.')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);

  await user.type(screen.getByLabelText('Critères pour le juge'), 'Exactitude (5 pts)');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = (writes()[0]![1] as { body: { scoringMethod: string; scoringConfig: unknown } }).body;
  expect(body.scoringMethod).toBe('judge');
  expect(body.scoringConfig).toEqual({ criteria: 'Exactitude (5 pts)' });
});

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';
  headers: Record<string, string> = {};
  method = '';
  url = '';
  body: unknown;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  finish(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}

test('pièces jointes : dépôt par glisser-déposer, barre de progression, refus 415 affiché en français', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  FakeXhr.instances = [];
  renderAt('/admin/tests/t1');
  const zone = await screen.findByRole('region', { name: 'Zone de dépôt des pièces jointes' });

  const png = new File(['x'], 'schema.png', { type: 'image/png' });
  fireEvent.drop(zone, { dataTransfer: { files: [png] } });
  await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
  const xhr = FakeXhr.instances[0]!;
  expect(xhr.method).toBe('POST');
  expect(xhr.url).toBe('/api/tests/t1/attachments');
  expect(xhr.headers['x-csrf-token']).toBe('jeton');
  expect((xhr.body as FormData).get('file')).toBe(png);

  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
  const bar = await screen.findByRole('progressbar', { name: 'Envoi de schema.png' });
  await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '50'));

  xhr.finish(201, { attachment: { id: 'a1', originalName: 'schema.png', mime: 'image/png', size: 2048, pages: null, sha256: 'ab' } });
  expect(await screen.findByRole('link', { name: /schema\.png/ })).toHaveAttribute('href', '/api/tests/t1/attachments/a1/download');
  expect(screen.queryByRole('progressbar')).toBeNull();

  const exe = new File(['MZ'], 'virus.exe', { type: 'application/pdf' });
  fireEvent.drop(zone, { dataTransfer: { files: [exe] } });
  await waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
  FakeXhr.instances[1]!.finish(415, { error: { code: 'unsupported_file_type', message: 'Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF' } });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('virus.exe');
  expect(alert).toHaveTextContent('Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF.');
});

test('pièces jointes : fichier de plus de 10 Mo refusé avant envoi', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  FakeXhr.instances = [];
  renderAt('/admin/tests/t1');
  const zone = await screen.findByRole('region', { name: 'Zone de dépôt des pièces jointes' });
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'gros.pdf', { type: 'application/pdf' });
  fireEvent.drop(zone, { dataTransfer: { files: [big] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('10 Mo');
  expect(FakeXhr.instances).toHaveLength(0);
});

test('pièces jointes : nouveau test → invitation à enregistrer d’abord', async () => {
  renderAt('/admin/tests/nouveau');
  expect(await screen.findByText(/Enregistrez le test pour joindre des fichiers/)).toBeInTheDocument();
});

test('enregistrement refusé par le serveur → message en français', async () => {
  const user = userEvent.setup();
  apiFetch.mockImplementation((path: string, init?: Call['init']) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: [], tags: [] });
    if (path === '/api/models') return Promise.resolve({ models: [] });
    if (init?.method === 'POST') return Promise.reject(new ApiError('validation', 400, 'x'));
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderAt('/admin/tests/nouveau');
  await fillRequired(user);
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Certaines informations sont invalides');
});

test('pièces jointes : après un dépôt, rouvrir le test affiche la pièce jointe (sans serveur à jour)', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  FakeXhr.instances = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = renderAt('/admin/tests/t1', client);
  const zone = await screen.findByRole('region', { name: 'Zone de dépôt des pièces jointes' });
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'cctp.pdf', { type: 'application/pdf' })] } });
  await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
  FakeXhr.instances[0]!.finish(201, { attachment: { id: 'a9', originalName: 'cctp.pdf', mime: 'application/pdf', size: 4096, pages: 3, sha256: 'cd' } });
  await screen.findByRole('link', { name: /cctp\.pdf/ });

  first.unmount();
  // Le serveur simulé renverrait encore l'ancienne liste : seul le cache à jour peut la montrer.
  renderAt('/admin/tests/t1', client);
  expect(await screen.findByRole('link', { name: /cctp\.pdf/ })).toBeInTheDocument();
});
