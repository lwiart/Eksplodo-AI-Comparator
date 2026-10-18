import { FIRST_ORBIT, astreColor, astreRadius, orbitRadius, orbitRanks, type ConstellationData } from './constellation-scene';

const PEACH = '#FFB48A';
const PAD = 0.9;

/** Repli statique de la constellation (sans WebGL) : vue de dessus, un astre par modèle sur son orbite (la plus proche du centre pour le plus haut débit). */
export function ConstellationFallback({ data, className = '' }: { data: ConstellationData; className?: string }) {
  const count = data.models.length;
  const outer = (count > 0 ? orbitRadius(count - 1, count) : FIRST_ORBIT) + PAD;
  const ranks = orbitRanks(data.models);
  return (
    <svg
      data-testid="constellation-fallback"
      viewBox={`${-outer} ${-outer} ${2 * outer} ${2 * outer}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      {data.models.map((m, i) => {
        const r = orbitRadius(ranks[i]!, count);
        const angle = -Math.PI / 2 + i * 1.1; // même déphasage que la scène 3D
        const color = astreColor(m.color, m.quality);
        const selected = m.id === data.selectedId;
        const cx = Math.cos(angle) * r;
        const cy = Math.sin(angle) * r;
        return (
          <g key={m.id} data-testid="constellation-astre" data-selected={selected || undefined}>
            <circle r={r} fill="none" stroke={selected ? PEACH : '#3FA2E0'} strokeOpacity={selected ? 0.7 : 0.16} strokeWidth="0.03" />
            {selected ? <circle cx={cx} cy={cy} r={astreRadius(m.quality) * 1.9} fill={color} fillOpacity="0.3" /> : null}
            <circle cx={cx} cy={cy} r={astreRadius(m.quality) * (selected ? 1.3 : 1)} fill={color} />
          </g>
        );
      })}
      <circle r="0.42" fill={PEACH} />
    </svg>
  );
}
