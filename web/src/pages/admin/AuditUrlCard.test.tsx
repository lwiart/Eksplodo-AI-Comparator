import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { AuditUrlCard } from './AuditUrlCard';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

let current: string;
beforeEach(() => {
  current = 'https://eksplodo.fr';
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: { auditUrl: string } }) => {
    if (path !== '/api/settings/sharing') return Promise.reject(new Error(`appel inattendu ${path}`));
    if (init?.method === 'PUT') {
      current = init.body!.auditUrl;
      return Promise.resolve({ auditUrl: current });
    }
    return Promise.resolve({ auditUrl: current });
  });
});

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuditUrlCard />
    </QueryClientProvider>,
  );
}

test('URL « Audit gratuit » : http:// refusé avec message français ; https:// enregistré', async () => {
  const user = userEvent.setup();
  renderCard();
  const field = (await screen.findByLabelText('URL de destination')) as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe('https://eksplodo.fr'));
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

  await user.clear(field);
  await user.type(field, 'http://audit.example.test');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('L’URL doit commencer par https://');
  expect(apiFetch.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);

  await user.clear(field);
  await user.type(field, 'https://audit.example.test/gratuit');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/settings/sharing', { method: 'PUT', body: { auditUrl: 'https://audit.example.test/gratuit' } }),
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled());
  expect(screen.queryByRole('alert')).toBeNull();
});
