import type { ModelInput, PriceSource, PublicModel, RemoteModelView } from '../../api/catalog';
import { Field } from '../ui/Field';

/** Brouillon de modèle : les nombres restent en texte tant que le formulaire est ouvert (saisie libre). */
export type ModelDraft = {
  apiModelId: string;
  displayName: string;
  color: string;
  inputPricePerM: string;
  outputPricePerM: string;
  supportsVision: boolean;
  supportsPdf: boolean;
  contextWindow: string;
};

const PALETTE = ['#3FA2E0', '#F0631F', '#4FD1A5', '#B58CFF', '#FFB48A', '#7CC4EF', '#FF7A7A', '#E6C84F'];

const text = (n: number | null) => (n === null ? '' : String(n));

export function emptyDraft(index = 0): ModelDraft {
  return {
    apiModelId: '',
    displayName: '',
    color: PALETTE[index % PALETTE.length]!,
    inputPricePerM: '',
    outputPricePerM: '',
    supportsVision: false,
    supportsPdf: false,
    contextWindow: '',
  };
}

/** Brouillon prérempli depuis un modèle distant ; les valeurs inconnues restent vides pour que l'Admin les complète. */
export function draftFromRemote(m: RemoteModelView, index: number): ModelDraft {
  return {
    apiModelId: m.id,
    displayName: m.name,
    color: PALETTE[index % PALETTE.length]!,
    inputPricePerM: text(m.inputPricePerM),
    outputPricePerM: text(m.outputPricePerM),
    supportsVision: m.supportsVision ?? false,
    supportsPdf: m.supportsPdf ?? false,
    contextWindow: text(m.contextWindow),
  };
}

export function draftFromModel(m: PublicModel): ModelDraft {
  return {
    apiModelId: m.apiModelId,
    displayName: m.displayName,
    color: m.color,
    inputPricePerM: text(m.inputPricePerM),
    outputPricePerM: text(m.outputPricePerM),
    supportsVision: m.supportsVision,
    supportsPdf: m.supportsPdf,
    contextWindow: text(m.contextWindow),
  };
}

/** Prix valide : nombre fini ≥ 0 avec 4 décimales au plus (jamais un prix vide lu comme « gratuit »). */
export function parsePrice(v: string): number | null {
  const t = v.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) return null;
  return Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6 ? n : null;
}

export function hasValidPrices(d: ModelDraft): boolean {
  return parsePrice(d.inputPricePerM) !== null && parsePrice(d.outputPricePerM) !== null;
}

function numberOrUndefined(v: string): number | undefined {
  const t = v.trim().replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Corps de création de modèle ; les champs vides sont omis (le serveur applique ses valeurs par défaut). */
export function draftToInput(providerId: string, d: ModelDraft, priceSource?: PriceSource): ModelInput {
  const input = numberOrUndefined(d.inputPricePerM);
  const output = numberOrUndefined(d.outputPricePerM);
  const context = numberOrUndefined(d.contextWindow);
  return {
    providerId,
    apiModelId: d.apiModelId.trim(),
    displayName: d.displayName.trim(),
    color: d.color,
    ...(input !== undefined ? { inputPricePerM: input } : {}),
    ...(output !== undefined ? { outputPricePerM: output } : {}),
    ...(priceSource ? { priceSource } : {}),
    supportsVision: d.supportsVision,
    supportsPdf: d.supportsPdf,
    ...(context !== undefined ? { contextWindow: Math.round(context) } : {}),
  };
}

type Props = {
  value: ModelDraft;
  onChange(value: ModelDraft): void;
  /** Identifiant API modifiable : ajout à la main uniquement (il ne change plus après la création). */
  idEditable?: boolean;
};

/** Formulaire compact d'un modèle : nom affiché, couleur, prix par million de tokens, capacités, contexte. */
export function ModelForm({ value, onChange, idEditable = false }: Props) {
  const set = <K extends keyof ModelDraft>(key: K, v: ModelDraft[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="grid grid-cols-2 gap-3 min-[640px]:grid-cols-4">
      {idEditable ? (
        <Field
          className="font-mono"
          label="Identifiant API"
          autoComplete="off"
          value={value.apiModelId}
          onChange={(e) => set('apiModelId', e.target.value)}
        />
      ) : null}
      <Field label="Nom affiché" autoComplete="off" value={value.displayName} onChange={(e) => set('displayName', e.target.value)} />
      <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">
        Couleur
        <input
          type="color"
          value={value.color}
          onChange={(e) => set('color', e.target.value)}
          className="block h-[42px] w-full cursor-pointer rounded-xl border border-line-strong bg-night-0/60 p-1"
        />
      </label>
      <Field label="Prix entrée ($/M)" inputMode="decimal" value={value.inputPricePerM} onChange={(e) => set('inputPricePerM', e.target.value)} />
      <Field label="Prix sortie ($/M)" inputMode="decimal" value={value.outputPricePerM} onChange={(e) => set('outputPricePerM', e.target.value)} />
      <Field label="Contexte (tokens)" inputMode="numeric" value={value.contextWindow} onChange={(e) => set('contextWindow', e.target.value)} />
      {!hasValidPrices(value) ? (
        <p className="col-span-full m-0 text-xs text-peach">Prix d&apos;entrée et de sortie requis</p>
      ) : null}
      <label className="flex items-center gap-2 self-end pb-2.5 text-[13px] text-ink">
        <input type="checkbox" checked={value.supportsVision} onChange={(e) => set('supportsVision', e.target.checked)} />
        Vision (images)
      </label>
      <label className="flex items-center gap-2 self-end pb-2.5 text-[13px] text-ink">
        <input type="checkbox" checked={value.supportsPdf} onChange={(e) => set('supportsPdf', e.target.checked)} />
        PDF
      </label>
    </div>
  );
}
