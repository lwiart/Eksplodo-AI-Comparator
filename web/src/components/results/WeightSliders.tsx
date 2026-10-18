import * as Slider from '@radix-ui/react-slider';
import { useRef } from 'react';
import type { Weights } from '../../api/runs';
import { rebalance, sameWeights, type WeightKey } from '../../lib/ranking';
import { InfoTip } from '../ui/InfoTip';
import { DEFINITIONS } from './definitions';

const LABELS: [WeightKey, string][] = [
  ['quality', 'Qualité'],
  ['speed', 'Vitesse'],
  ['cost', 'Coût'],
  ['reliability', 'Fiabilité'],
];

/** Quatre curseurs de pondération dont la somme reste 100 : déplacer l'un ajuste les autres proportionnellement. */
export function WeightSliders({ value, onChange }: { value: Weights; onChange(next: Weights): void }) {
  // Tant qu'on déplace le même curseur, on repart des poids de départ : des arrondis successifs sur des entiers
  // déformeraient sinon les proportions des autres curseurs.
  const gesture = useRef<{ key: WeightKey; base: Weights; emitted: Weights } | null>(null);
  const move = (key: WeightKey, v: number) => {
    const g = gesture.current;
    const base = g !== null && g.key === key && sameWeights(g.emitted, value) ? g.base : value;
    const next = rebalance(base, key, v);
    gesture.current = { key, base, emitted: next };
    onChange(next);
  };
  // Le geste se termine au relâchement du pointeur ou quand le curseur perd le focus (clavier).
  const endGesture = () => {
    gesture.current = null;
  };
  return (
    <div role="group" aria-label="Pondération" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      {/* Bulles de la colonne de droite ouvertes vers la gauche pour rester dans la carte. */}
      {LABELS.map(([key, label], i) => (
        <div key={key} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-1 text-xs text-mute">
            <span className="inline-flex items-center gap-1.5">
              {label}
              <InfoTip label={label} align={i % 2 === 1 ? 'right' : 'left'}>
                {DEFINITIONS[key]}
              </InfoTip>
            </span>
            <b className="font-mono font-semibold whitespace-nowrap text-white">{value[key]} %</b>
          </div>
          <Slider.Root
            min={0}
            max={100}
            step={1}
            value={[value[key]]}
            onValueChange={([v]) => move(key, v ?? value[key])}
            onPointerUp={endGesture}
            className="relative flex h-5 w-full touch-none items-center select-none"
          >
            <Slider.Track className="relative h-1.5 grow rounded-full bg-white/10">
              <Slider.Range className="absolute h-full rounded-full bg-gradient-to-r from-orange to-peach" />
            </Slider.Track>
            <Slider.Thumb
              aria-label={label}
              onBlur={endGesture}
              className="block h-4 w-4 cursor-pointer rounded-full border-2 border-peach bg-night-0 shadow-[0_0_10px_rgba(240,99,31,0.6)]"
            />
          </Slider.Root>
        </div>
      ))}
    </div>
  );
}
