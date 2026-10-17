import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QuickTryPanel } from './QuickTryPanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const model = (id: string, displayName: string, available: boolean) => ({ id, displayName, available, providerName: 'Fake' });
const MODELS = [model('m1', 'Modèle A', true), model('m2', 'Modèle indisponible', false)];

const OUTCOME = {
  status: 'done',
  text: '<b>Bonjour</b> <img src=x onerror=alert(1)>',
  finishReason: 'stop',
  inputTokens: 120,
  outputTokens: 480,
  reasoningTokens: null,
  tokensEstimated: false,
  ttftMs: 420,
  totalMs: 5200,
  tokensPerS: 100.4,
  costUsd: 0.0012,
  costSource: 'computed',
  errorCode: null,
  errorMessage: null,
  modelName: 'Modèle A',
  score: null,
};

let polls: unknown[];
beforeEach(() => {
  // Le temps réel continue de s'écouler (les attentes de la bibliothèque de test et de react-query en dépendent).
  vi.useFakeTimers({ shouldAdvanceTime: true });
  polls = [{ status: 'queued' }, { status: 'running' }, { status: 'done', outcome: OUTCOME }];
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/models') return Promise.resolve({ models: MODELS });
    if (path === '/api/tests/try') return Promise.resolve({ jobId: 'j1' });
    if (path === '/api/tests/try/j1') return Promise.resolve(polls.shift());
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.useRealTimers());

function renderPanel(props: Partial<ComponentProps<typeof QuickTryPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ensureSaved = vi.fn().mockResolvedValue('t1');
  const view = render(
    <QueryClientProvider client={client}>
      <QuickTryPanel dirty={false} ensureSaved={ensureSaved} {...props} />
    </QueryClientProvider>,
  );
  return { ensureSaved, ...view };
}
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const pollCount = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/tests/try/j1').length;

test('essai rapide : enregistre, lance, interroge toutes les 2 s, affiche réponse, premier token, débit, coût', async () => {
  const user = userEvent.setup({ delay: null });
  const { ensureSaved } = renderPanel({ dirty: true });
  await user.selectOptions(await screen.findByLabelText('Modèle'), 'm1');
  await user.click(screen.getByRole('button', { name: 'Enregistrer et essayer' }));

  expect(ensureSaved).toHaveBeenCalledTimes(1);
  await screen.findByText(/en file|en cours/i);
  expect(apiFetch).toHaveBeenCalledWith('/api/tests/try', { method: 'POST', body: { testId: 't1', modelId: 'm1' } });
  expect(pollCount()).toBe(0);
  await tick(2000);
  expect(pollCount()).toBe(1);
  await tick(1500);
  expect(pollCount()).toBe(1);
  await tick(600);
  expect(pollCount()).toBe(2);
  await tick(2000);
  expect(pollCount()).toBe(3);

  // Texte échappé : aucune balise interprétée.
  expect(await screen.findByText(OUTCOME.text)).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('420 ms')).toBeInTheDocument();
  expect(screen.getByText('5,2 s')).toBeInTheDocument();
  expect(screen.getByText('100,4 tokens/s')).toBeInTheDocument();
  expect(screen.getByText(/480/)).toBeInTheDocument();
  expect(screen.getByText('0,0012 $')).toBeInTheDocument();

  // Terminé : plus d'interrogation.
  await tick(10_000);
  expect(pollCount()).toBe(3);
});

test('essai rapide : sans modification, le bouton s’appelle « Essayer »', async () => {
  renderPanel();
  expect(await screen.findByRole('button', { name: 'Essayer' })).toBeInTheDocument();
});

test('essai rapide : modèles non disponibles absents de la liste', async () => {
  renderPanel();
  const select = await screen.findByLabelText('Modèle');
  expect(select).toHaveTextContent('Modèle A');
  expect(select).not.toHaveTextContent('Modèle indisponible');
});

test('essai rapide : tokens estimés signalés, erreur avec le message masqué', async () => {
  const user = userEvent.setup({ delay: null });
  polls = [
    {
      status: 'done',
      outcome: { ...OUTCOME, status: 'error', text: '', tokensEstimated: true, costUsd: null, tokensPerS: null, ttftMs: null, errorCode: 'auth_invalid', errorMessage: 'Clé refusée (sk-***)' },
    },
  ];
  renderPanel();
  await user.selectOptions(await screen.findByLabelText('Modèle'), 'm1');
  await user.click(screen.getByRole('button', { name: 'Essayer' }));
  await screen.findByText(/en file|en cours/i);
  await tick(2000);
  expect(await screen.findByRole('alert')).toHaveTextContent('Clé refusée (sk-***)');
  expect(screen.getByText(/estimé/)).toBeInTheDocument();
});

test('essai rapide : tâche en échec → message du serveur', async () => {
  const user = userEvent.setup({ delay: null });
  polls = [{ status: 'failed', message: "L'essai n'a pas pu être exécuté. Réessayez." }];
  renderPanel();
  await user.selectOptions(await screen.findByLabelText('Modèle'), 'm1');
  await user.click(screen.getByRole('button', { name: 'Essayer' }));
  await screen.findByText(/en file|en cours/i);
  await tick(2000);
  expect(await screen.findByRole('alert')).toHaveTextContent("L'essai n'a pas pu être exécuté");
});

test('essai rapide : l’interrogation s’arrête au démontage', async () => {
  const user = userEvent.setup({ delay: null });
  const { unmount } = renderPanel();
  await user.selectOptions(await screen.findByLabelText('Modèle'), 'm1');
  await user.click(screen.getByRole('button', { name: 'Essayer' }));
  await screen.findByText(/en file|en cours/i);
  await tick(2000);
  expect(pollCount()).toBe(1);
  unmount();
  await tick(10_000);
  expect(pollCount()).toBe(1);
});

async function tryOnce() {
  const user = userEvent.setup({ delay: null });
  renderPanel();
  await user.selectOptions(await screen.findByLabelText('Modèle'), 'm1');
  await user.click(screen.getByRole('button', { name: 'Essayer' }));
  await screen.findByText(/en file|en cours/i);
  await tick(2000);
}

test('essai rapide : note du juge, justification échappée et nom du juge', async () => {
  polls = [
    {
      status: 'done',
      outcome: { ...OUTCOME, score: { method: 'judge', score: 8, rationale: 'Clair <b>et</b> complet', judgeModelName: 'Juge 0', judgeCostUsd: 0.0004 } },
    },
  ];
  await tryOnce();
  expect(await screen.findByText('Note : 8/10')).toBeInTheDocument();
  expect(screen.getByText('Clair <b>et</b> complet')).toBeInTheDocument();
  expect(screen.getByText(/Juge 0/)).toBeInTheDocument();
});

test('essai rapide : note par réponse attendue sans nom de juge ; note absente → justification seule', async () => {
  polls = [{ status: 'done', outcome: { ...OUTCOME, score: { method: 'expected', score: 6.7, rationale: '2 éléments trouvés sur 3' } } }];
  await tryOnce();
  expect(await screen.findByText('Note : 6,7/10')).toBeInTheDocument();
  expect(screen.getByText('2 éléments trouvés sur 3')).toBeInTheDocument();
  expect(screen.queryByText(/Juge/)).toBeNull();
});

test('essai rapide : juge indisponible → pas de note, message affiché', async () => {
  polls = [{ status: 'done', outcome: { ...OUTCOME, score: { method: 'judge', score: null, rationale: 'Aucun juge par défaut disponible' } } }];
  await tryOnce();
  expect(await screen.findByText('Aucun juge par défaut disponible')).toBeInTheDocument();
  expect(screen.queryByText(/Note :/)).toBeNull();
});
