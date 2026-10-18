import { useEffect, useState } from 'react';

export const SCORE_STEP = 5;

type Props = {
  /** Nom de la réponse notée (ex. « réponse A ») : sert aux libellés accessibles. */
  label: string;
  value: number | null;
  onChange(value: number): void;
};

/** Entier de 0 à 100 saisi au clavier, sinon `null` (vide, décimale, hors bornes). */
export function parseScore(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n <= 100 ? n : null;
}

/**
 * Note sur 100 : curseur par pas de 5 pour aller vite, champ pour saisir n'importe quel entier de 0 à 100.
 * Tant que rien n'est choisi, le curseur reste au milieu, estompé, et le champ est vide ; un clic sur place choisit 50.
 */
export function ScoreInput({ label, value, onChange }: Props) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  // La note change par le curseur (ou par une relecture) : le champ suit.
  useEffect(() => setRaw(value === null ? '' : String(value)), [value]);
  const invalid = raw !== '' && parseScore(raw) === null;

  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={SCORE_STEP}
          value={value ?? 50}
          aria-label={`Note de la ${label}`}
          aria-valuetext={value === null ? 'non notée' : `${value} sur 100`}
          onChange={(e) => onChange(Number(e.target.value))}
          // Sans note, le curseur attend au milieu : un clic sur place n'émet aucun `change`, il vaut pourtant un choix de 50.
          onClick={(e) => {
            if (value === null) onChange(Number(e.currentTarget.value));
          }}
          className={`h-2 flex-1 cursor-pointer accent-orange ${value === null ? 'opacity-40' : ''}`}
        />
        <input
          type="text"
          inputMode="numeric"
          maxLength={3}
          value={raw}
          aria-label={`Note de la ${label}, saisie au clavier`}
          aria-invalid={invalid}
          onChange={(e) => {
            setRaw(e.target.value);
            const n = parseScore(e.target.value);
            if (n !== null) onChange(n);
          }}
          className={`w-14 rounded-lg border bg-night-2/50 px-2 py-1.5 text-center font-mono text-sm font-bold text-white ${
            invalid ? 'border-bad' : value === null ? 'border-line' : 'border-orange'
          }`}
        />
        <span className="font-mono text-xs text-mute">/ 100</span>
      </div>
      {invalid ? <p className="m-0 text-xs text-bad">Nombre entier entre 0 et 100.</p> : null}
    </div>
  );
}
