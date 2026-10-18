import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { parseScore, ScoreInput } from './ScoreInput';

const slider = () => screen.getByRole('slider', { name: 'Note de la réponse A' });
const field = () => screen.getByRole('textbox', { name: 'Note de la réponse A, saisie au clavier' });

/** Parent contrôlé, comme la page de notation. */
function Harness({ onChange }: { onChange: (n: number) => void }) {
  const [value, setValue] = useState<number | null>(null);
  return (
    <ScoreInput
      label="réponse A"
      value={value}
      onChange={(n) => {
        setValue(n);
        onChange(n);
      }}
    />
  );
}

test('sans note : curseur estompé au milieu, « non notée », champ vide', () => {
  render(<ScoreInput label="réponse A" value={null} onChange={() => {}} />);
  expect(slider()).toHaveClass('opacity-40');
  expect(slider()).toHaveValue('50');
  expect(slider()).toHaveAttribute('aria-valuetext', 'non notée');
  expect(slider()).toHaveAttribute('step', '5');
  expect(field()).toHaveValue('');
  expect(field()).toHaveAttribute('inputmode', 'numeric');
  expect(field()).toHaveAttribute('maxlength', '3');
  expect(field()).toHaveAttribute('aria-invalid', 'false');
});

test('curseur : règle la note par pas de 5, n’est plus estompé, le champ suit', () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.change(slider(), { target: { value: '70' } });
  expect(onChange).toHaveBeenCalledWith(70);
  expect(slider()).not.toHaveClass('opacity-40');
  expect(slider()).toHaveAttribute('aria-valuetext', '70 sur 100');
  expect(field()).toHaveValue('70');
});

test('saisie au clavier : « 73 » appelle onChange(73) et le curseur suit', async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  await userEvent.type(field(), '73');
  expect(onChange).toHaveBeenLastCalledWith(73);
  expect(slider()).toHaveAttribute('aria-valuetext', '73 sur 100');
  expect(field()).toHaveAttribute('aria-invalid', 'false');
  expect(screen.queryByText('Nombre entier entre 0 et 100.')).toBeNull();
});

test('saisie « 150 » : invalide, message affiché, onChange jamais appelé avec 150', async () => {
  const onChange = vi.fn();
  render(<ScoreInput label="réponse A" value={null} onChange={onChange} />);
  await userEvent.type(field(), '150');
  expect(field()).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Nombre entier entre 0 et 100.')).toBeInTheDocument();
  // L'état intermédiaire « 15 » est valide et a pu partir ; jamais « 150 ».
  expect(onChange).not.toHaveBeenCalledWith(150);
});

test('saisie « 7,5 » : invalide, message affiché, onChange jamais appelé avec 7,5', async () => {
  const onChange = vi.fn();
  render(<ScoreInput label="réponse A" value={null} onChange={onChange} />);
  await userEvent.type(field(), '7,5');
  expect(field()).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Nombre entier entre 0 et 100.')).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalledWith(7.5);
  expect(onChange).not.toHaveBeenCalledWith(75);
});

test('parseScore : entiers de 0 à 100 seulement', () => {
  expect(parseScore('0')).toBe(0);
  expect(parseScore('73')).toBe(73);
  expect(parseScore(' 100 ')).toBe(100);
  expect(parseScore('101')).toBeNull();
  expect(parseScore('150')).toBeNull();
  expect(parseScore('7,5')).toBeNull();
  expect(parseScore('7.5')).toBeNull();
  expect(parseScore('-1')).toBeNull();
  expect(parseScore('abc')).toBeNull();
  expect(parseScore('')).toBeNull();
});

test('sans note : un clic sur le curseur resté au milieu choisit 50', () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.click(slider());
  expect(onChange).toHaveBeenCalledWith(50);
  expect(slider()).toHaveAttribute('aria-valuetext', '50 sur 100');
  expect(field()).toHaveValue('50');
  // Une fois noté, un clic sans mouvement ne renvoie plus rien.
  fireEvent.click(slider());
  expect(onChange).toHaveBeenCalledTimes(1);
});
