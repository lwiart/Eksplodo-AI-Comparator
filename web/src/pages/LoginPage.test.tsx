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
  expect(screen.getByTestId('fanout-fallback')).toBeInTheDocument();
  expect(screen.getByText('ACCÈS SUR INVITATION UNIQUEMENT')).toBeInTheDocument();
});

test('affiche le texte de présentation et la légende du bandeau', () => {
  setup(vi.fn());
  expect(screen.getByText(/Le banc d'essai des IA/)).toHaveTextContent(/qualité, leur vitesse, leur coût et leur fiabilité/);
  expect(screen.getByText('TOUT MODÈLE ACCESSIBLE PAR API')).toBeInTheDocument();
  expect(screen.getByText('Testé · chronométré · noté')).toBeInTheDocument();
});

test('le bandeau défilant ne charge rien d externe', () => {
  setup(vi.fn());
  const imgs = Array.from(screen.getByTestId('provider-ticker').querySelectorAll('img'));
  expect(imgs.length).toBe(48); // 24 fournisseurs, liste doublée pour la boucle
  imgs.forEach((img) => expect(img.getAttribute('src')).not.toMatch(/^(https?:)?\/\//));
  expect(screen.getByTestId('provider-ticker').innerHTML).not.toMatch(/(src|href)="(https?:)?\/\//);
});
