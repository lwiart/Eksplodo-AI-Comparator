import { Field } from '../ui/Field';
import { InfoTip } from '../ui/InfoTip';
import { TextArea } from '../ui/TextArea';
import type { ExpectedConfig, JudgeConfig, ScoringConfig, ScoringMethod } from '../../api/tests';

export type ExpectedMode = ExpectedConfig['mode'];

/** État du formulaire de notation : tous les champs des trois méthodes sont gardés pour qu'un changement d'onglet ne perde rien. */
export type ScoringDraft = {
  method: ScoringMethod;
  criteria: string;
  reference: string;
  mode: ExpectedMode;
  expected: string;
  /** Un élément par ligne. */
  items: string;
  ignoreCase: boolean;
  ignoreAccents: boolean;
  pattern: string;
  flags: string;
};

export type ScoringErrors = Partial<Record<'criteria' | 'expected' | 'items' | 'pattern' | 'flags', string>>;

export const EMPTY_SCORING: ScoringDraft = {
  method: 'manual',
  criteria: '',
  reference: '',
  mode: 'exact',
  expected: '',
  items: '',
  ignoreCase: true,
  ignoreAccents: false,
  pattern: '',
  flags: '',
};

/** Remplit le formulaire d'après la configuration enregistrée d'un test. */
export function draftFromTest(method: ScoringMethod, config: ScoringConfig): ScoringDraft {
  const draft: ScoringDraft = { ...EMPTY_SCORING, method };
  if (method === 'judge') {
    const c = config as JudgeConfig;
    return { ...draft, criteria: c.criteria ?? '', reference: c.reference ?? '' };
  }
  if (method === 'expected') {
    const c = config as ExpectedConfig;
    if (c.mode === 'exact') return { ...draft, mode: 'exact', expected: c.expected, ignoreCase: c.ignoreCase, ignoreAccents: c.ignoreAccents };
    if (c.mode === 'contains') return { ...draft, mode: 'contains', items: c.items.join('\n'), ignoreCase: c.ignoreCase };
    return { ...draft, mode: 'regex', pattern: c.pattern, flags: c.flags };
  }
  return draft;
}

/** Configuration à envoyer, ou les erreurs de saisie à afficher (mêmes règles que le serveur). */
export function buildScoring(d: ScoringDraft): { ok: true; config: ScoringConfig } | { ok: false; errors: ScoringErrors } {
  if (d.method === 'manual') return { ok: true, config: {} };

  if (d.method === 'judge') {
    const criteria = d.criteria.trim();
    if (criteria === '') return { ok: false, errors: { criteria: 'Les critères du juge sont obligatoires.' } };
    if (criteria.length > 5000) return { ok: false, errors: { criteria: 'Les critères ne doivent pas dépasser 5 000 caractères.' } };
    const reference = d.reference.trim();
    return { ok: true, config: reference === '' ? { criteria } : { criteria, reference } };
  }

  if (d.mode === 'exact') {
    if (d.expected.trim() === '') return { ok: false, errors: { expected: 'Le texte attendu est obligatoire.' } };
    return { ok: true, config: { mode: 'exact', expected: d.expected, ignoreCase: d.ignoreCase, ignoreAccents: d.ignoreAccents } };
  }

  if (d.mode === 'contains') {
    const items = d.items.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (items.length === 0) return { ok: false, errors: { items: 'Indiquez au moins un élément attendu.' } };
    if (items.length > 50) return { ok: false, errors: { items: '50 éléments au plus.' } };
    return { ok: true, config: { mode: 'contains', items, ignoreCase: d.ignoreCase } };
  }

  const errors: ScoringErrors = {};
  if (!/^[gimsuy]*$/.test(d.flags)) errors.flags = 'Drapeaux autorisés : g, i, m, s, u, y.';
  if (d.pattern === '') errors.pattern = 'Le motif est obligatoire.';
  else {
    try {
      new RegExp(d.pattern, errors.flags ? '' : d.flags);
    } catch {
      errors.pattern = 'Expression régulière invalide';
    }
  }
  if (errors.pattern || errors.flags) return { ok: false, errors };
  return { ok: true, config: { mode: 'regex', pattern: d.pattern, flags: d.flags } };
}

const METHODS: { value: ScoringMethod; label: string }[] = [
  { value: 'judge', label: 'IA-juge' },
  { value: 'expected', label: 'Réponse attendue' },
  { value: 'manual', label: 'Manuelle' },
];
const MODES: { value: ExpectedMode; label: string }[] = [
  { value: 'exact', label: 'Texte exact' },
  { value: 'contains', label: 'Contient' },
  { value: 'regex', label: 'Expression régulière' },
];

/** Sélecteur segmenté : de vrais boutons radio, stylés selon l'état coché. */
function Segmented<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(v: T): void;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-full border border-line-strong bg-night-0/60 p-1">
        {options.map((o) => (
          <label
            key={o.value}
            className="cursor-pointer rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-mute transition-colors has-checked:bg-orange/15 has-checked:text-white has-checked:shadow-[inset_0_0_0_1px_rgba(240,99,31,0.55)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-sky"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-orange" />
      {label}
    </label>
  );
}

type Props = { value: ScoringDraft; onChange(next: ScoringDraft): void; errors: ScoringErrors };

/** Choix de la méthode de notation et de sa configuration. */
export function ScoringConfigForm({ value, onChange, errors }: Props) {
  const set = <K extends keyof ScoringDraft>(key: K, v: ScoringDraft[K]) => onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-col gap-4">
      <Segmented legend="Méthode de notation" name="scoring-method" options={METHODS} value={value.method} onChange={(m) => set('method', m)} />

      {value.method === 'manual' ? (
        <p className="m-0 text-sm text-mute">Les réponses seront notées à la main, à l'aveugle, par les évaluateurs.</p>
      ) : null}

      {value.method === 'judge' ? (
        <>
          <TextArea
            label="Critères pour le juge"
            rows={6}
            value={value.criteria}
            error={errors.criteria}
            hint="Un critère par ligne, avec son barème."
            onChange={(e) => set('criteria', e.target.value)}
          />
          <TextArea
            label="Réponse de référence (facultative)"
            rows={3}
            value={value.reference}
            placeholder="Aide le juge à calibrer sa note…"
            onChange={(e) => set('reference', e.target.value)}
          />
        </>
      ) : null}

      {value.method === 'expected' ? (
        <>
          <Segmented legend="Mode de comparaison" name="expected-mode" options={MODES} value={value.mode} onChange={(m) => set('mode', m)} />
          {value.mode === 'exact' ? (
            <>
              <TextArea label="Texte attendu" rows={3} value={value.expected} error={errors.expected} onChange={(e) => set('expected', e.target.value)} />
              <Check label="Ignorer la casse" checked={value.ignoreCase} onChange={(v) => set('ignoreCase', v)} />
              <Check label="Ignorer les accents" checked={value.ignoreAccents} onChange={(v) => set('ignoreAccents', v)} />
            </>
          ) : null}
          {value.mode === 'contains' ? (
            <>
              <TextArea
                label="Éléments attendus (un par ligne)"
                rows={4}
                value={value.items}
                error={errors.items}
                hint="La réponse doit contenir chacun de ces éléments."
                onChange={(e) => set('items', e.target.value)}
              />
              <Check label="Ignorer la casse" checked={value.ignoreCase} onChange={(v) => set('ignoreCase', v)} />
            </>
          ) : null}
          {value.mode === 'regex' ? (
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <Field
                label="Motif"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                value={value.pattern}
                error={errors.pattern}
                onChange={(e) => set('pattern', e.target.value)}
              />
              <Field
                label="Drapeaux"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                value={value.flags}
                error={errors.flags}
                hint="gimsuy"
                onChange={(e) => set('flags', e.target.value)}
              />
              <div className="col-span-full flex items-start gap-2 text-xs text-mute">
                <p className="m-0">
                  Expression régulière JavaScript, écrite sans les barres obliques autour (par exemple <code className="font-mono text-ink">^1$</code>, pas{' '}
                  <code className="font-mono text-ink">/^1$/</code>). Elle est cherchée dans toute la réponse (50 000 premiers caractères) : la note vaut 100
                  si elle trouve une correspondance, 0 sinon.
                </p>
                <InfoTip label="Écrire une expression régulière" width="w-80" align="right">
                  <span className="block font-semibold text-white">Exemples</span>
                  <span className="block font-mono">Paris</span>
                  <span className="mb-1 block">le mot, n’importe où dans la réponse</span>
                  <span className="block font-mono">^1$</span>
                  <span className="mb-1 block">la réponse entière vaut exactement 1 (avec le drapeau m : une ligne vaut 1)</span>
                  <span className="block font-mono">{String.raw`\b1957\b`}</span>
                  <span className="mb-1 block">le nombre 1957 seul, pas 19570</span>
                  <span className="block font-mono">(oui|yes)</span>
                  <span className="mb-1 block">l’un ou l’autre</span>
                  <span className="block font-mono">{String.raw`\d+ ?€`}</span>
                  <span className="mb-2 block">un nombre suivi de « € »</span>
                  <span className="block font-semibold text-white">À savoir</span>
                  <span className="block">
                    Caractères à précéder d’une barre oblique inverse pour les chercher tels quels : <code className="font-mono">{String.raw`. * + ? ( ) [ ] { } | ^ $ \ `}</code>
                  </span>
                  <span className="mt-1 block">
                    Drapeaux : i majuscules ignorées, m ^ et $ valent pour chaque ligne, s le point inclut les retours à la ligne, u Unicode.
                  </span>
                  <span className="mt-1 block">Une expression trop lente (plus d’une seconde) donne 0.</span>
                </InfoTip>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
