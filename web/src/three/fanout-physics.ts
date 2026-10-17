/** Logique pure de l'interaction « logos élastiques » de la scène de connexion (sans Three.js, donc testable). */
export type Vec3 = { x: number; y: number; z: number };

/**
 * Un pas de ressort amorti, Euler semi-implicite : la vitesse est mise à jour d'abord, puis la position avec la
 * nouvelle vitesse. MUTE `pos` et `vel` (aucune allocation par image). Avec K=70 et C=6.5 le système est sous-amorti :
 * il dépasse la cible puis se stabilise, d'où l'effet de rebond.
 */
export function springStep(pos: Vec3, vel: Vec3, target: Vec3, k: number, c: number, dt: number): void {
  vel.x += ((target.x - pos.x) * k - vel.x * c) * dt;
  vel.y += ((target.y - pos.y) * k - vel.y * c) * dt;
  vel.z += ((target.z - pos.z) * k - vel.z * c) * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

/**
 * Décalage d'« aimant » d'un logo dont la position d'origine est `home` quand la souris est en `mouse` : un vecteur
 * dirigé vers la souris, de longueur min(distance, force × (1 − distance / rayon)). Il ne dépasse donc jamais la souris
 * (le logo reste attrapable) et s'annule au bord du rayon. Nul hors rayon ou si la souris est sur `home`.
 */
export function magnetOffset(home: Vec3, mouse: Vec3, radius: number, strength: number): Vec3 {
  const dx = mouse.x - home.x;
  const dy = mouse.y - home.y;
  const dz = mouse.z - home.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist >= radius || dist < 1e-9) return { x: 0, y: 0, z: 0 };
  const len = Math.min(dist, strength * (1 - dist / radius));
  const f = len / dist;
  return { x: dx * f, y: dy * f, z: dz * f };
}

/** Indice du point le plus proche de `p` dans le rayon `radius` (distance 3D), ou -1 si aucun. */
export function pickNearest(points: readonly Vec3[], p: Vec3, radius: number): number {
  let best = -1;
  let bestDist = radius;
  points.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}
