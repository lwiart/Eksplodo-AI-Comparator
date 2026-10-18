import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RankingModel } from '../../api/results';
import { ConstellationFallback } from '../../three/ConstellationFallback';
import {
  CONSTELLATION_HOVER_EVENT,
  UNRATED_COLOR,
  constellationScene,
  placeLabel,
  type ConstellationData,
  type ConstellationHover,
} from '../../three/constellation-scene';
import { ThreeStage } from '../../three/ThreeStage';
import { Card } from '../ui/Card';
import { InfoTip } from '../ui/InfoTip';
import { score, tokensPerSecond } from './format';

/** Mesures de l'étiquette de survol : « Qualité 87/100 · 54,2 tokens/s », ou « Pas encore noté ». */
export function hoverDetails(m: RankingModel): string {
  if (m.quality === null) return 'Pas encore noté';
  const parts = [`Qualité ${score(m.quality)}/100`];
  if (m.raw.medianTokensPerS !== null) parts.push(tokensPerSecond(m.raw.medianTokensPerS));
  return parts.join(' · ');
}

/**
 * Constellation des modèles : un astre par modèle, de sa couleur (gris et plus petit tant qu'il n'est pas noté).
 * Taille = qualité (note sur 100) ; distance au centre = débit médian en tokens par seconde : le plus rapide sur l'orbite
 * la plus proche du centre, puis par débit décroissant, les modèles sans débit à l'extérieur (voir `orbitRanks`). La
 * vitesse de rotation suit aussi le débit (les astres proches tournent plus vite). Une icône « ? » l'explique.
 * Survoler un astre (grand écran) ou appuyer dessus (tous écrans) affiche son nom, sa qualité et son débit dans une
 * étiquette qui le suit : la scène émet `CONSTELLATION_HOVER_EVENT` sur son canevas, l'événement remonte jusqu'au cadre
 * écouté ici. La légende, sous la scène (jamais par-dessus), est faite de pastilles : en toucher une affiche le même
 * détail sous la légende, y compris sans WebGL.
 */
export function Constellation({ models, className = '' }: { models: RankingModel[]; className?: string }) {
  const data = useMemo<ConstellationData>(
    () => ({
      models: models.map((m) => ({
        id: m.modelId,
        color: m.color,
        quality: m.quality,
        tokensPerS: m.raw.medianTokensPerS,
      })),
    }),
    [models],
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<ConstellationHover | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Place l'étiquette près de l'astre, sans rendu React : la position change à chaque image tant que l'astre tourne.
  const placeRef = useRef(() => {
    const stage = stageRef.current;
    const label = labelRef.current;
    const hover = hoverRef.current;
    if (!stage || !label || !hover) return;
    const { left, top } = placeLabel(hover, { w: label.offsetWidth, h: label.offsetHeight }, { w: stage.clientWidth, h: stage.clientHeight });
    label.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onHover = (e: Event) => {
      const hover = (e as CustomEvent<ConstellationHover | null>).detail ?? null;
      hoverRef.current = hover;
      setHoveredId(hover?.id ?? null);
      placeRef.current();
    };
    stage.addEventListener(CONSTELLATION_HOVER_EVENT, onHover);
    return () => stage.removeEventListener(CONSTELLATION_HOVER_EVENT, onHover);
  }, []);

  const hovered = hoveredId === null ? undefined : models.find((m) => m.modelId === hoveredId);
  const selected = selectedId === null ? undefined : models.find((m) => m.modelId === selectedId);
  // Nouvelle étiquette (autre astre) : sa taille change, on la replace une fois rendue.
  useLayoutEffect(() => placeRef.current(), [hovered]);

  return (
    <Card className={`flex h-full min-h-[360px] flex-col overflow-hidden p-0 ${className}`}>
      {/* Scène : elle occupe la hauteur libre de la carte ; la légende vient dessous, sans la recouvrir. */}
      <div className="relative min-h-[240px] flex-1">
        <div ref={stageRef} className="pointer-events-none absolute inset-0">
          <ThreeStage factory={constellationScene} fallback={<ConstellationFallback data={data} />} data={data} />
          {hovered && (
            <div
              ref={labelRef}
              data-testid="constellation-etiquette"
              aria-hidden="true"
              className="absolute top-0 left-0 z-20 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-x-1.5 rounded-lg border bg-night-1/90 px-2.5 py-1 font-mono text-[11px] text-white shadow-2xl sm:max-w-none sm:flex-nowrap sm:whitespace-nowrap"
              style={{ borderColor: hovered.quality === null ? UNRATED_COLOR : hovered.color }}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: hovered.quality === null ? UNRATED_COLOR : hovered.color }}
              />
              <span className="font-medium">{hovered.name}</span>
              <span className="text-mute">{hoverDetails(hovered)}</span>
            </div>
          )}
        </div>
        {/* Même position et même corps que le titre « Podium » (marge de 16 px de la carte) : les deux titres s'alignent. */}
        <div className="absolute top-4 left-4 z-30 flex items-center gap-2">
          <h2 className="m-0 font-display text-base leading-6 font-bold text-white">Constellation des modèles</h2>
          <InfoTip label="Constellation">
            Chaque astre est un modèle, de sa couleur. Sa taille suit la qualité (note sur 100) ; gris et plus petit, il n’est
            pas encore noté. Sa distance au centre suit le débit médian en tokens par seconde : le modèle le plus proche du
            centre a le plus haut débit, et il tourne aussi le plus vite. Les modèles sans débit mesuré sont sur les orbites
            extérieures. Survolez ou touchez un astre (ou une pastille de la légende) pour voir son nom, sa qualité et son débit.
          </InfoTip>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pt-1 pb-3.5">
        <ul aria-label="Légende de la constellation" className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
          {models.map((m) => {
            const active = m.modelId === selectedId;
            return (
              <li key={m.modelId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(active ? null : m.modelId)}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium text-white ${
                    active ? 'border-peach bg-night-2' : 'border-line bg-night-0/60 hover:border-line-strong'
                  }`}
                >
                  <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: m.quality === null ? UNRATED_COLOR : m.color }} />
                  {m.name}
                </button>
              </li>
            );
          })}
        </ul>
        {selected ? (
          <p role="status" className="m-0 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-white">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: selected.quality === null ? UNRATED_COLOR : selected.color }} />
            <span className="font-semibold">{selected.name}</span>
            {selected.providerName ? <span className="text-mute">{selected.providerName}</span> : null}
            <span className="text-peach">{hoverDetails(selected)}</span>
          </p>
        ) : null}
        <p className="m-0 font-mono text-[10px] font-medium text-mute">
          Taille = qualité · Plus près du centre = débit plus élevé · Touchez ou survolez un astre pour son nom
        </p>
      </div>
    </Card>
  );
}
