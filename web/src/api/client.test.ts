import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, apiFetch, setUnauthorizedHandler } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'aic_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

type Init = RequestInit & { headers: Record<string, string> };

/** Options de la dernière requête envoyée. */
function initOf(f: ReturnType<typeof vi.fn>): Init {
  return f.mock.calls.at(-1)![1] as Init;
}

test('ajoute le jeton CSRF aux requêtes modifiantes', async () => {
  document.cookie = 'aic_csrf=abc';
  const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', f);
  await apiFetch('/api/auth/logout', { method: 'POST' });
  expect(initOf(f).headers['x-csrf-token']).toBe('abc');
});

test("n'ajoute pas le jeton CSRF aux lectures, envoie les cookies du même site", async () => {
  document.cookie = 'aic_csrf=abc';
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: null }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  await apiFetch('/api/auth/me');
  expect(initOf(f).headers['x-csrf-token']).toBeUndefined();
  expect(initOf(f).credentials).toBe('same-origin');
});

test('envoie le corps en JSON et renvoie la réponse décodée', async () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  const res = await apiFetch<{ user: { id: string } }>('/api/auth/login', {
    method: 'POST',
    body: { email: 'a@b.fr' },
  });
  expect(res.user.id).toBe('u1');
  expect(initOf(f).body).toBe(JSON.stringify({ email: 'a@b.fr' }));
  expect(initOf(f).headers['content-type']).toBe('application/json');
});

test('sans cookie CSRF, en obtient un avant la requête modifiante', async () => {
  const f = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/api/auth/me') document.cookie = 'aic_csrf=neuf';
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', f);
  await apiFetch('/api/auth/logout', { method: 'POST' });
  expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/auth/me', '/api/auth/logout']);
  expect(initOf(f).headers['x-csrf-token']).toBe('neuf');
});

test('204 → undefined', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  await expect(apiFetch('/api/auth/password/forgot', { method: 'POST', body: { email: 'x' } })).resolves.toBeUndefined();
});

test('transforme une erreur API en ApiError', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'x' } }), { status: 401 }),
    ),
  );
  const p = apiFetch('/api/auth/login', { method: 'POST', body: {} });
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await expect(p).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
});

test('réponse d’erreur non JSON → ApiError générique', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })));
  await expect(apiFetch('/api/auth/me')).rejects.toMatchObject({ code: 'http_error', status: 502 });
});

test('401 → prévient le gestionnaire de session expirée', async () => {
  const handler = vi.fn();
  setUnauthorizedHandler(handler);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 })),
  );
  await expect(apiFetch('/api/auth/me')).rejects.toMatchObject({ status: 401 });
  expect(handler).toHaveBeenCalledOnce();
  setUnauthorizedHandler(null);
});

test('panne réseau → ApiError network', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(apiFetch('/api/auth/me')).rejects.toMatchObject({ code: 'network', status: 0 });
});

test('la référence d’une erreur interne est portée par l’ApiError', async () => {
  const body = { error: { code: 'internal', message: 'x', reference: 'E-12345' } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 500 })));
  const err = await apiFetch('/api/x').catch((e: unknown) => e);
  expect((err as ApiError).reference).toBe('E-12345');
});
