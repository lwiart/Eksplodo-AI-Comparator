import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { originLabel } from '../../api/errors';
import { ErrorLogPage } from './ErrorLogPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const NOW = new Date('2026-10-16T10:00:00Z');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function event(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reference: 'E-ABC23',
    severity: 'grave',
    source: 'job',
    origin: 'error_digest',
    code: 'claude_auth',
    httpStatus: 401,
    message: 'Clé Claude refusée',
    stack: 'Error: refusée\n    at ligne 1',
    userId: null,
    userName: null,
    target: { type: 'document', id: 'd-1' },
    occurrences: 3,
    firstSeenAt: '2026-10-15T08:00:00.000Z',
    lastSeenAt: '2026-10-16T09:30:00.000Z',
    resolvedAt: null,
    notifiedAt: null,
    ...over,
  };
}

const E2 = event({
  id: '22222222-2222-4222-8222-222222222222',
  reference: 'E-DEF45',
  severity: 'normale',
  source: 'request',
  origin: 'POST /api/documents',
  code: 'internal',
  httpStatus: 500,
  message: 'Échec',
  target: null,
  occurrences: 1,
  stack: null,
});
const E3 = event({
  id: '33333333-3333-4333-8333-333333333333',
  reference: 'E-GHJ67',
  severity: 'normale',
  source: 'external',
  origin: 'mystere',
  target: null,
  resolvedAt: '2026-10-16T09:50:00.000Z',
});

const summary = {
  last24h: { total: 4, grave: 2 },
  last7d: { total: 12, grave: 5 },
  topOrigins: [
    { origin: 'error_digest', count: 6 },
    { origin: 'smtp', count: 3 },
    { origin: 'POST /api/x', count: 2 },
  ],
  unresolvedGrave: 2,
};

let mode = 'daily';
function route(path: string, init?: { method?: string; body?: unknown }) {
  if (path.startsWith('/api/admin/errors/summary')) return Promise.resolve(summary);
  if (path.startsWith('/api/admin/errors/by-reference/')) {
    return path.toUpperCase().endsWith('E-ABC23') ? Promise.resolve({ item: event() }) : Promise.reject(new ApiError('not_found', 404, 'Introuvable'));
  }
  if (path === '/api/admin/errors/resolve') return Promise.resolve({ updated: 1 });
  if (path.startsWith('/api/admin/errors')) return Promise.resolve({ items: [event(), E2, E3], total: 3, page: 1, pageSize: 50 });
  if (path === '/api/admin/settings/notifications') {
    if (init?.method === 'PUT') mode = (init.body as { errorAlerts: string }).errorAlerts;
    return Promise.resolve({ errorAlerts: mode });
  }
  return Promise.reject(new Error(`appel inattendu ${path}`));
}

beforeEach(() => {
  mode = 'daily';
  apiFetch.mockReset();
  apiFetch.mockImplementation(route);
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

function renderPage(entry = '/admin/erreurs') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ErrorLogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const listCalls = () => apiFetch.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith('/api/admin/errors?'));
const lastList = () => new URLSearchParams(listCalls().at(-1)!.split('?')[1]);

test('en-tête en événements et liste avec origines en clair et pastilles', async () => {
  renderPage();
  const table = await screen.findByRole('table');
  expect(await screen.findByText(/12 événements/)).toBeTruthy();
  expect(screen.getByText(/dont 5 graves/)).toBeTruthy();
  expect(screen.getByText(/4 événements/)).toBeTruthy();
  expect(screen.queryByText(/erreurs survenues/)).toBeNull();
  const top = screen.getByLabelText('Origines les plus fréquentes sur 7 jours');
  expect(within(top).getByText('Récapitulatif des erreurs')).toBeTruthy();
  expect(within(top).getByText('E-mail')).toBeTruthy();
  expect(within(top).getByText('Page / API POST /api/x')).toBeTruthy();

  const rows = within(table).getAllByRole('row').slice(1);
  expect(within(rows[0]!).getByText('Grave')).toBeTruthy();
  expect(within(rows[0]!).getByText('Récapitulatif des erreurs')).toBeTruthy();
  expect(within(rows[0]!).getByText('E-ABC23')).toBeTruthy();
  expect(within(rows[1]!).getByText('Normale')).toBeTruthy();
  expect(within(rows[1]!).getByText('Page / API POST /api/documents')).toBeTruthy();
  expect(within(rows[2]!).getByText('mystere')).toBeTruthy();
});

test('un seul appel au résumé et paramètres par défaut de la liste', async () => {
  renderPage();
  await screen.findByRole('table');
  const p = lastList();
  expect(p.get('from')).toMatch(/^2026-10-09T10:00:0[0-9]/); // 7 jours
  expect(p.get('includeResolved')).toBe('0');
  expect(p.get('page')).toBe('1');
  expect(p.has('severity')).toBe(false);
  expect(apiFetch.mock.calls.filter(([p2]) => String(p2).startsWith('/api/admin/errors/summary'))).toHaveLength(1);
});

test('les filtres envoient les bons paramètres', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.selectOptions(screen.getByLabelText('Gravité'), 'grave');
  await vi.waitFor(() => expect(lastList().get('severity')).toBe('grave'));
  await user.selectOptions(screen.getByLabelText('Origine'), 'smtp');
  await vi.waitFor(() => expect(lastList().get('origin')).toBe('smtp'));
  await user.selectOptions(screen.getByLabelText('Période'), '24h');
  await vi.waitFor(() => expect(lastList().get('from')).toMatch(/^2026-10-15T10:00:0[0-9]/));
  await user.click(screen.getByLabelText('Afficher les traitées'));
  await vi.waitFor(() => expect(lastList().get('includeResolved')).toBe('1'));
});

test('recherche par référence : ouvre l’événement, sinon message', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.type(screen.getByLabelText('Référence'), 'e-abc23');
  await user.click(screen.getByRole('button', { name: 'Ouvrir' }));
  const found = await screen.findByRole('region', { name: 'Événement trouvé' });
  expect(within(found).getByText('Clé Claude refusée')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/by-reference/e-abc23');
  await user.clear(screen.getByLabelText('Référence'));
  await user.type(screen.getByLabelText('Référence'), 'E-ZZZZ9');
  await user.click(screen.getByRole('button', { name: 'Ouvrir' }));
  expect(await screen.findByText('Aucune erreur avec cette référence.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Événement trouvé' })).toBeNull();
});

test('détail déplié : code, HTTP, pile et dates', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  const toggle = screen.getByRole('button', { name: /Détail E-ABC23/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(/at ligne 1/)).toBeNull();
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('claude_auth')).toBeTruthy();
  expect(screen.getByText('401')).toBeTruthy();
  expect(screen.getByText(/at ligne 1/).closest('pre')).toBeTruthy();
});

test('marquer comme traitée puis rouvrir', async () => {
  renderPage();
  const user = userEvent.setup();
  const table = await screen.findByRole('table');
  const rows = within(table).getAllByRole('row').slice(1);
  await user.click(within(rows[0]!).getByRole('button', { name: 'Marquer comme traitée' }));
  await vi.waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/resolve', {
      method: 'POST',
      body: { ids: ['11111111-1111-4111-8111-111111111111'], resolved: true },
    }),
  );
  await user.click(within(rows[2]!).getByRole('button', { name: 'Rouvrir' }));
  await vi.waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/resolve', {
      method: 'POST',
      body: { ids: ['33333333-3333-4333-8333-333333333333'], resolved: false },
    }),
  );
});

test('sélection multiple : marquer la sélection comme traitée', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  expect((screen.getByRole('button', { name: 'Marquer la sélection comme traitée' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByLabelText('Sélectionner E-ABC23'));
  await user.click(screen.getByLabelText('Sélectionner E-DEF45'));
  await user.click(screen.getByRole('button', { name: 'Marquer la sélection comme traitée' }));
  await vi.waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/resolve', {
      method: 'POST',
      body: { ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], resolved: true },
    }),
  );
});

test('alertes par e-mail : textes, choix actuel et enregistrement (PUT)', async () => {
  renderPage();
  const user = userEvent.setup();
  const daily = (await screen.findByRole('radio', { name: /Récapitulatif quotidien/ })) as HTMLInputElement;
  await vi.waitFor(() => expect(daily.checked).toBe(true));
  expect(screen.getByText('Vous consultez le journal des erreurs quand vous le souhaitez.')).toBeTruthy();
  expect(
    screen.getByText(
      "Un e-mail à 7 h 30, seulement s'il y a eu des erreurs depuis le récapitulatif précédent : nombre d'erreurs par gravité et par origine, les 10 plus fréquentes, lien vers le journal.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Un e-mail dès qu'une erreur grave survient (au plus un par type d'erreur et par heure ; les suivantes sont comptées dans l'e-mail suivant), plus le récapitulatif quotidien pour toutes les erreurs.",
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole('radio', { name: /Immédiat pour les erreurs graves/ }));
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await vi.waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/settings/notifications', { method: 'PUT', body: { errorAlerts: 'immediate' } }),
  );
  expect(await screen.findByText('Réglage enregistré.')).toBeTruthy();
});

function paged(resolvedYet: () => boolean) {
  return (path: string, init?: { method?: string; body?: unknown }) => {
    if (path.startsWith('/api/admin/errors?')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      if (resolvedYet()) return Promise.resolve({ items: [event()], total: 50, page: 1, pageSize: 50 });
      return Promise.resolve(
        page === 2
          ? { items: [E2], total: 51, page: 2, pageSize: 50 }
          : { items: [event()], total: 51, page: 1, pageSize: 50 },
      );
    }
    return route(path, init);
  };
}

test('pagination : page suivante envoie page=2 et vide la sélection', async () => {
  apiFetch.mockImplementation(paged(() => false));
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.click(screen.getByLabelText('Sélectionner E-ABC23'));
  expect((screen.getByLabelText('Sélectionner E-ABC23') as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Page suivante' }));
  await vi.waitFor(() => expect(lastList().get('page')).toBe('2'));
  await screen.findByText('E-DEF45');
  expect((screen.getByLabelText('Sélectionner E-DEF45') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: 'Marquer la sélection comme traitée' }) as HTMLButtonElement).disabled).toBe(true);
});

test('dernière page vidée par un traitement : retour à la dernière page existante', async () => {
  let done = false;
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/admin/errors/resolve') {
      done = true;
      return Promise.resolve({ updated: 1 });
    }
    return paged(() => done)(path, init);
  });
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'Page suivante' }));
  await screen.findByText('E-DEF45');
  await user.click(screen.getByLabelText('Sélectionner E-DEF45'));
  await user.click(screen.getByRole('button', { name: 'Marquer la sélection comme traitée' }));
  await vi.waitFor(() => expect(lastList().get('page')).toBe('1'));
  expect(await screen.findByText('E-ABC23')).toBeTruthy();
  expect(screen.queryByText('Page 2 sur 2')).toBeNull();
  expect((screen.getByRole('button', { name: 'Marquer la sélection comme traitée' }) as HTMLButtonElement).disabled).toBe(true);
});

test('filtre « Page / API » : paramètre source=request, sans origine', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.selectOptions(screen.getByLabelText('Origine'), 'Page / API');
  await vi.waitFor(() => expect(lastList().get('source')).toBe('request'));
  expect(lastList().has('origin')).toBe(false);
  await user.selectOptions(screen.getByLabelText('Origine'), 'Récapitulatif des erreurs');
  await vi.waitFor(() => expect(lastList().get('origin')).toBe('error_digest'));
  expect(lastList().has('source')).toBe(false);
});

test('libellés et options de filtre des tâches de fond', () => {
  const expected: Record<string, string> = {
    error_alert: 'Alerte d’erreur',
    error_digest: 'Récapitulatif des erreurs',
    errors_purge: 'Purge du journal',
  };
  for (const [origin, label] of Object.entries(expected)) expect(originLabel('job', origin)).toBe(label);
});

test('options du filtre d’origine : toutes les tâches de fond', async () => {
  renderPage();
  await screen.findByRole('table');
  const select = screen.getByLabelText('Origine');
  for (const label of ['Alerte d’erreur', 'Récapitulatif des erreurs', 'Purge du journal']) {
    expect(within(select).getByRole('option', { name: label })).toBeTruthy();
  }
});

test('?ref= ouvre directement l’événement', async () => {
  renderPage('/admin/erreurs?ref=E-ABC23');
  const found = await screen.findByRole('region', { name: 'Événement trouvé' });
  expect(within(found).getByText('Clé Claude refusée')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/by-reference/E-ABC23');
});
