import { MAIN_PROVIDERS } from './providers';

const ORANGE = '#F0631F';
const BLUE = '#3FA2E0';
const PX = -2.4; // bulle du prompt
const JX = 7.4; // jauge du juge
const CX = 2.5;
const N = MAIN_PROVIDERS.length;

// Mêmes positions que la scène 3D (repère de la scène, y vers le haut → inversé pour le SVG).
const COINS = MAIN_PROVIDERS.map((p, i) => {
  const k = i / (N - 1);
  return { ...p, x: CX + Math.sin(k * Math.PI) * 1.1, y: -(3.7 - k * 7.4) };
});

/** Repli statique « un prompt, huit réponses » (sans WebGL, ou si le fragment Three.js ne se charge pas). */
export function FanoutFallback({ className = '' }: { className?: string }) {
  return (
    <svg
      data-testid="fanout-fallback"
      viewBox="-4.2 -5 14.4 10"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={className}
    >
      {COINS.map((c) => (
        <g key={c.name}>
          <line x1={PX} y1="0" x2={c.x} y2={c.y} stroke={BLUE} strokeOpacity="0.25" strokeWidth="0.025" />
          <line x1={c.x} y1={c.y} x2={JX} y2="0" stroke={ORANGE} strokeOpacity="0.25" strokeWidth="0.025" />
        </g>
      ))}
      {/* bulle du prompt */}
      <g>
        <path d={`M${PX - 0.55} 0.6 L${PX - 0.95} 1.05 L${PX - 0.15} 0.6 Z`} fill={BLUE} />
        <rect x={PX - 1.05} y="-0.65" width="2.1" height="1.3" rx="0.42" fill={BLUE} />
        {[-0.42, 0, 0.42].map((dx) => (
          <circle key={dx} cx={PX + dx} cy="0" r="0.13" fill="#fff" />
        ))}
      </g>
      <text x={PX} y="1.75" textAnchor="middle" fontFamily="'Noto Sans Mono', monospace" fontWeight="600" fontSize="0.28" fill="#fff">
        PROMPTS, DOCUMENTS, CODE…
      </text>
      {/* logos */}
      {COINS.map((c) => (
        <g key={c.name}>
          <circle cx={c.x} cy={c.y} r="0.42" fill="#f2f7fa" stroke={c.color} strokeWidth="0.05" />
          <image href={c.icon} x={c.x - 0.27} y={c.y - 0.27} width="0.54" height="0.54" />
        </g>
      ))}
      {/* jauge ronde du juge */}
      <g transform={`translate(${JX} 0)`}>
        <circle r="0.81" fill={ORANGE} fillOpacity="0.08" />
        <circle r="0.95" fill="none" stroke="#0C3A52" strokeWidth="0.09" />
        <circle
          r="0.95"
          fill="none"
          stroke={ORANGE}
          strokeWidth="0.1"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="87 13"
          transform="rotate(-90)"
        />
        <text y="0.18" textAnchor="middle" fontFamily="'Noto Sans Mono', monospace" fontWeight="600" fontSize="0.5" fill="#fff">
          8.7
        </text>
        <text y="0.62" textAnchor="middle" fontFamily="'Noto Sans Mono', monospace" fontWeight="600" fontSize="0.2" fill="#7FA3B5">
          / 10
        </text>
      </g>
      <text x={JX} y="1.75" textAnchor="middle" fontFamily="'Noto Sans Mono', monospace" fontWeight="600" fontSize="0.28" fill="#fff">
        JUGE IA
      </text>
    </svg>
  );
}
