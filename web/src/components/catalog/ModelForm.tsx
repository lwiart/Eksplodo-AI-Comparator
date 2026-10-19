import { useEffect, useId, useState } from 'react';
import { checkCapabilities, type CapabilityCheck, type CapabilityResult, type ModelInput, type PriceSource, type PublicModel, type RemoteModelView } from '../../api/catalog';
import { messageForError } from '../../api/messages';
import { brandColor } from '../../lib/brand-colors';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { InfoTip } from '../ui/InfoTip';

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
  /** Couleur encore choisie par défaut : elle suit la marque reconnue tant que l'Admin ne l'a pas changée. */
  colorAuto?: boolean;
};

const PALETTE = ['#3FA2E0', '#F0631F', '#4FD1A5', '#B58CFF', '#FFB48A', '#7CC4EF', '#FF7A7A', '#E6C84F'];

const text = (n: number | null) => (n === null ? '' : String(n));

/** Couleur de marque si elle est connue, sinon une couleur de la palette. */
const defaultColor = (index: number, apiModelId = '', displayName = '', providerBaseUrl?: string) =>
  brandColor(apiModelId, displayName, providerBaseUrl) ?? PALETTE[index % PALETTE.length]!;

export function emptyDraft(index = 0, providerBaseUrl?: string): ModelDraft {
  return {
    apiModelId: '',
    displayName: '',
    color: defaultColor(index, '', '', providerBaseUrl),
    colorAuto: true,
    inputPricePerM: '',
    outputPricePerM: '',
    supportsVision: false,
    supportsPdf: false,
    contextWindow: '',
  };
}

/** Brouillon prérempli depuis un modèle distant ; les valeurs inconnues restent vides pour que l'Admin les complète. */
export function draftFromRemote(m: RemoteModelView, index: number, providerBaseUrl?: string): ModelDraft {
  return {
    apiModelId: m.id,
    displayName: m.name,
    color: defaultColor(index, m.id, m.name, providerBaseUrl),
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

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** `#RRGGBB` (le # est facultatif à la saisie), en majuscules ; `null` sinon. */
export function parseHex(raw: string): string | null {
  const t = raw.trim();
  const hex = t.startsWith('#') ? t : `#${t}`;
  return HEX.test(hex) ? hex.toUpperCase() : null;
}

/** Couleur saisie d'abord en HEX ; la pastille ouvre le sélecteur du navigateur pour qui préfère choisir à l'œil. */
export function ColorField({ value, onChange }: { value: string; onChange(color: string): void }) {
  const [raw, setRaw] = useState(value.toUpperCase());
  useEffect(() => setRaw(value.toUpperCase()), [value]);
  const invalid = parseHex(raw) === null;
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">
      <label htmlFor={id}>Couleur (HEX)</label>
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={raw}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          placeholder="#RRGGBB"
          onChange={(e) => {
            setRaw(e.target.value);
            const hex = parseHex(e.target.value);
            if (hex !== null) onChange(hex);
          }}
          className={`h-[42px] min-w-0 flex-1 rounded-xl border bg-night-0/60 px-3 font-mono text-sm text-white uppercase ${invalid ? 'border-bad' : 'border-line-strong'}`}
        />
        <input
          type="color"
          aria-label="Choisir la couleur dans la palette"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="block h-[42px] w-[42px] shrink-0 cursor-pointer rounded-xl border border-line-strong bg-night-0/60 p-1"
        />
      </span>
      {invalid ? <span className="text-xs text-bad">Code attendu : #RRGGBB</span> : null}
    </div>
  );
}

type CheckState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: CapabilityCheck } | { status: 'failed'; message: string };

const verdictTone = (r: CapabilityResult) => (r.supported === true ? 'text-good' : r.supported === false ? 'text-bad' : 'text-mute');

/**
 * « Vérifier les capacités » : trois tout petits appels réels (texte seul, image, PDF). Les cases suivent la réponse du
 * fournisseur ; un résultat indéterminé (clé, délai, indisponibilité) les laisse telles quelles.
 */
function CapabilityCheckButton({ providerId, apiModelId, onResult }: { providerId: string; apiModelId: string; onResult(r: CapabilityCheck): void }) {
  const [state, setState] = useState<CheckState>({ status: 'idle' });
  const run = async () => {
    setState({ status: 'running' });
    try {
      const result = await checkCapabilities(providerId, apiModelId.trim());
      onResult(result);
      setState({ status: 'done', result });
    } catch (err) {
      setState({ status: 'failed', message: messageForError(err) });
    }
  };
  return (
    <div className="col-span-full flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={apiModelId.trim() === '' || state.status === 'running'} onClick={() => void run()}>
          {state.status === 'running' ? 'Vérification…' : 'Vérifier les capacités'}
        </Button>
        <InfoTip label="Vérifier les capacités" width="w-80">
          Envoie au modèle trois très petits appels réels, avec la clé du fournisseur : un message sans pièce jointe (contrôle), une
          image de 32 × 32 pixels et un PDF d’une page. Si le fournisseur accepte la pièce jointe, la case est cochée ; s’il la
          refuse, elle est décochée et son message s’affiche. Si rien ne peut être conclu (clé refusée, délai dépassé, fournisseur
          indisponible), les cases ne changent pas. La fenêtre de contexte est lue dans la liste des modèles du fournisseur, sans coût, quand il
          la publie. Coût : quelques tokens ; durée : 20 secondes au plus.
        </InfoTip>
      </div>
      {state.status === 'done' ? (
        <ul aria-label="Résultat de la vérification" className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs [overflow-wrap:anywhere]">
          <li className={verdictTone(state.result.vision)}>Vision : {state.result.vision.message}</li>
          <li className={verdictTone(state.result.pdf)}>PDF : {state.result.pdf.message}</li>
          <li className={state.result.contextWindow == null ? 'text-mute' : 'text-good'}>
            Contexte :{' '}
            {state.result.contextWindow == null
              ? 'non publié par le fournisseur, la valeur saisie reste.'
              : `${state.result.contextWindow.toLocaleString('fr-FR')} tokens (liste des modèles du fournisseur).`}
          </li>
        </ul>
      ) : null}
      {state.status === 'failed' ? (
        <p role="alert" className="m-0 text-xs text-bad">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

type Props = {
  value: ModelDraft;
  onChange(value: ModelDraft): void;
  /** Identifiant API modifiable : ajout à la main uniquement (il ne change plus après la création). */
  idEditable?: boolean;
  /** Adresse de l'API du fournisseur : sert à reconnaître la marque d'un modèle ajouté à la main. */
  providerBaseUrl?: string;
  /** Fournisseur du modèle : active « Vérifier les capacités ». */
  providerId?: string;
};

/** Formulaire compact d'un modèle : nom affiché, couleur, prix par million de tokens, capacités, contexte. */
export function ModelForm({ value, onChange, idEditable = false, providerBaseUrl, providerId }: Props) {
  const set = <K extends keyof ModelDraft>(key: K, v: ModelDraft[K]) => {
    const next = { ...value, [key]: v };
    // Couleur restée par défaut : elle suit la marque reconnue dans l'identifiant ou le nom saisis.
    if (value.colorAuto && (key === 'apiModelId' || key === 'displayName')) {
      next.color = brandColor(next.apiModelId, next.displayName, providerBaseUrl) ?? value.color;
    }
    onChange(next);
  };
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
      <ColorField value={value.color} onChange={(color) => onChange({ ...value, color, colorAuto: false })} />
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
      {providerId ? (
        <CapabilityCheckButton
          providerId={providerId}
          apiModelId={value.apiModelId}
          onResult={(r) =>
            onChange({
              ...value,
              supportsVision: r.vision.supported ?? value.supportsVision,
              supportsPdf: r.pdf.supported ?? value.supportsPdf,
              contextWindow: r.contextWindow == null ? value.contextWindow : String(r.contextWindow),
            })
          }
        />
      ) : null}
    </div>
  );
}
