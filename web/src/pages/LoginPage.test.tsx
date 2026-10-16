import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type AuthValue } from '../auth/AuthProvider';
import { LoginPage } from './LoginPage';

function setup(login: AuthValue['login']) {
  const value: AuthValue = { user: null, loading: false, login, logout: vi.fn(), refresh: vi.fn() };
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/connexion']}>
        <Routes>
          <Route path="/connexion" element={<LoginPage />} />
          <Route path="/" element={<p>Tableau de bord</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

async function fill() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('E-mail'), 'a@example.test');
  await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-long');
  await user.click(screen.getByRole('button', { name: 'Se connecter' }));
}

test('connexion réussie → tableau de bord', async () => {
  const login = vi.fn().mockResolvedValue(undefined);
  setup(login);
  await fill();
  expect(login).toHaveBeenCalledWith('a@example.test', 'un-mot-de-passe-long');
  expect(await screen.findByText('Tableau de bord')).toBeInTheDocument();
});

test('identifiants faux → message générique en français', async () => {
  setup(vi.fn().mockRejectedValue(new ApiError('unauthorized', 401, 'x')));
  await fill();
  expect(await screen.findByRole('alert')).toHaveTextContent(/identifiants/i);
});

test('trop de tentatives → message dédié', async () => {
  setup(vi.fn().mockRejectedValue(new ApiError('rate_limited', 429, 'x')));
  await fill();
  expect(await screen.findByRole('alert')).toHaveTextContent(/trop de tentatives/i);
});

test('formulaire utilisable sans WebGL', () => {
  setup(vi.fn());
  expect(screen.getByLabelText('E-mail')).toBeEnabled();
  expect(screen.getByTestId('burst-fallback')).toBeInTheDocument();
  expect(screen.getByText('ACCÈS SUR INVITATION UNIQUEMENT')).toBeInTheDocument();
});
