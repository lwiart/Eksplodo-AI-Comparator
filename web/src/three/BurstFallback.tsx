const ORANGE = '#F0631F';
const SKY = '#7CC4EF';
const DEEP_BLUE = '#0C659D';

// Même gerbe que la scène 3D, figée : longueurs déterministes (le rendu doit être stable d'un affichage à l'autre).
const pseudo = (n: number) => Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1;

const RAYS = Array.from({ length: 140 }, (_, i) => {
  const angle = (i / 140) * Math.PI * 2;
  const length = 32 + pseudo(i) * 72;
  const accent = i % 7 === 0;
  return {
    x1: Math.cos(angle) * 58,
    y1: Math.sin(angle) * 58,
    x2: Math.cos(angle) * (58 + length),
    y2: Math.sin(angle) * (58 + length),
    color: accent ? ORANGE : i % 3 === 0 ? SKY : DEEP_BLUE,
    opacity: accent ? 1 : 0.75,
  };
});

const STARS = Array.from({ length: 60 }, (_, i) => ({
  x: (pseudo(i + 0.5) - 0.5) * 760,
  y: (pseudo(i + 100.5) - 0.5) * 760,
}));

/** Repli statique (sans WebGL, ou si le fragment Three.js ne se charge pas). */
export function BurstFallback({ className = '' }: { className?: string }) {
  return (
    <svg
      data-testid="burst-fallback"
      viewBox="-200 -200 400 400"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={className}
    >
      {STARS.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r="0.8" fill="#5d97b8" opacity="0.6" />
      ))}
      {RAYS.map((r, i) => (
        <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={r.color} strokeOpacity={r.opacity} strokeWidth="1.6" />
      ))}
      <circle r="68" fill={ORANGE} opacity="0.07" />
      <circle r="50" fill="#011F2E" />
      <circle r="52" fill="none" stroke={ORANGE} strokeWidth="1.6" />
    </svg>
  );
}
