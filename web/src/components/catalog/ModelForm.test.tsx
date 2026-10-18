import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiFetch }));
import type { RemoteModelView } from '../../api/catalog';
import { ColorField, draftFromRemote, emptyDraft, ModelForm, parseHex, type ModelDraft } from './ModelForm';

const remote = (id: string, name: string): RemoteModelView =>
  ({ id, name, contextWindow: null, inputPricePerM: null, outputPricePerM: null, supportsVision: null, supportsPdf: null, alreadyAdded: false }) as RemoteModelView;

function Harness({ initial, baseUrl, spy, providerId }: { initial: ModelDraft; baseUrl?: string; spy?: (d: ModelDraft) => void; providerId?: string }) {
  const [draft, setDraft] = useState(initial);
  return (
    <ModelForm
      idEditable
      providerBaseUrl={baseUrl}
      providerId={providerId}
      value={draft}
      onChange={(d) => {
        setDraft(d);
        spy?.(d);
      }}
    />
  );
}

const hexField = () => screen.getByRole('textbox', { name: 'Couleur (HEX)' });

test('parseHex : #RRGGBB, # facultatif, mis en majuscules ; le reste refusé', () => {
  expect(parseHex('#d97757')).toBe('#D97757');
  expect(parseHex('10a37f')).toBe('#10A37F');
  expect(parseHex(' #FA520F ')).toBe('#FA520F');
  for (const bad of ['', '#fff', '#12345', '#1234567', 'rouge', '#GGGGGG']) expect(parseHex(bad)).toBeNull();
});

test('couleur : le code HEX vient en premier, la pastille reste disponible et suit le code', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  function Field() {
    const [color, setColor] = useState('#3FA2E0');
    return (
      <ColorField
        value={color}
        onChange={(c) => {
          setColor(c);
          onChange(c);
        }}
      />
    );
  }
  render(<Field />);
  const [first] = screen.getAllByRole('textbox');
  expect(first).toBe(hexField());
  expect(hexField()).toHaveValue('#3FA2E0');
  await user.clear(hexField());
  await user.type(hexField(), '#d97757');
  expect(onChange).toHaveBeenLastCalledWith('#D97757');
  expect(screen.getByLabelText('Choisir la couleur dans la palette')).toHaveValue('#d97757');
  // Code incomplet : signalé, rien n'est envoyé.
  onChange.mockClear();
  await user.clear(hexField());
  await user.type(hexField(), '#12');
  expect(hexField()).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Code attendu : #RRGGBB')).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  // La pastille (sélecteur du navigateur) met le code à jour.
  fireEvent.change(screen.getByLabelText('Choisir la couleur dans la palette'), { target: { value: '#10a37f' } });
  expect(onChange).toHaveBeenLastCalledWith('#10A37F');
  expect(hexField()).toHaveValue('#10A37F');
});

test('modèle distant : couleur de la marque si elle est connue, sinon la palette', () => {
  expect(draftFromRemote(remote('claude-sonnet-5-5', 'Claude Sonnet 5.5'), 0).color).toBe('#D97757');
  expect(draftFromRemote(remote('deepseek-chat', 'DeepSeek V3'), 3).color).toBe('#4D6BFE');
  expect(draftFromRemote(remote('modele-inconnu', 'Inconnu'), 1).color).toBe('#F0631F');
  expect(draftFromRemote(remote('modele-inconnu', 'Inconnu'), 0, 'https://api.mistral.ai/v1').color).toBe('#FA520F');
});

test('ajout à la main : la couleur suit la marque saisie tant qu’elle n’a pas été choisie', async () => {
  const user = userEvent.setup();
  render(<Harness initial={emptyDraft(0, 'https://openrouter.ai/api/v1')} baseUrl="https://openrouter.ai/api/v1" />);
  expect(hexField()).toHaveValue('#3FA2E0');
  await user.type(screen.getByLabelText('Identifiant API'), 'moonshotai/kimi-k2');
  expect(hexField()).toHaveValue('#007CFF');
  // Couleur choisie par l'Admin : elle ne bouge plus.
  await user.clear(hexField());
  await user.type(hexField(), '#123456');
  await user.clear(screen.getByLabelText('Identifiant API'));
  await user.type(screen.getByLabelText('Identifiant API'), 'gpt-5');
  expect(hexField()).toHaveValue('#123456');
});

test('ajout à la main chez un fournisseur de marque : sa couleur d’emblée', () => {
  expect(emptyDraft(2, 'https://api.anthropic.com').color).toBe('#D97757');
  expect(emptyDraft(2).color).toBe('#4FD1A5');
});

test('« Vérifier les capacités » : cases suivant la réponse du fournisseur, indéterminé laissé tel quel, aide « ? »', async () => {
  const user = userEvent.setup();
  apiFetch.mockResolvedValueOnce({
    capabilities: {
      vision: { supported: true, message: 'Image acceptée par le modèle.' },
      pdf: { supported: false, message: 'PDF refusé : file must have a file_id or file_data' },
    },
  });
  render(<Harness initial={{ ...emptyDraft(0), apiModelId: 'deepseek-flash', supportsPdf: true }} providerId="p1" />);
  expect(screen.getByRole('button', { name: 'Aide : Vérifier les capacités' })).toHaveAccessibleDescription(/trois très petits appels réels/);
  await user.click(screen.getByRole('button', { name: 'Vérifier les capacités' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/providers/p1/check-capabilities', { method: 'POST', body: { apiModelId: 'deepseek-flash' } });
  const result = await screen.findByRole('list', { name: 'Résultat de la vérification' });
  expect(result).toHaveTextContent('Vision : Image acceptée par le modèle.');
  expect(result).toHaveTextContent('PDF : PDF refusé : file must have a file_id or file_data');
  expect(screen.getByRole('checkbox', { name: 'Vision (images)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'PDF' })).not.toBeChecked();

  // Indéterminé (clé refusée…) : les cases ne bougent pas.
  apiFetch.mockResolvedValueOnce({
    capabilities: { vision: { supported: null, message: 'Indéterminé : clé refusée' }, pdf: { supported: null, message: 'Indéterminé : clé refusée' } },
  });
  await user.click(screen.getByRole('button', { name: 'Vérifier les capacités' }));
  await screen.findByText('Vision : Indéterminé : clé refusée');
  expect(screen.getByRole('checkbox', { name: 'Vision (images)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'PDF' })).not.toBeChecked();
});

test('« Vérifier les capacités » absent sans fournisseur, désactivé sans identifiant API', () => {
  const { unmount } = render(<Harness initial={emptyDraft(0)} />);
  expect(screen.queryByRole('button', { name: 'Vérifier les capacités' })).toBeNull();
  unmount();
  render(<Harness initial={emptyDraft(0)} providerId="p1" />);
  expect(screen.getByRole('button', { name: 'Vérifier les capacités' })).toBeDisabled();
});
