import type { BufferAttribute, Material, Mesh, Object3D } from 'three';
import { createInteractionGate } from './interaction-gate';
import type { SceneFactory } from './useThreeScene';

/**
 * Données de la constellation : un astre par modèle, dans l'ordre des orbites (le premier au plus près du centre).
 * `quality` est la note sur 100 (nulle : modèle non noté), `tokensPerS` le débit médian.
 */
export type ConstellationData = {
  models: { id: string; color: string; quality: number | null; tokensPerS: number | null }[];
};

// ---------- géométrie pure (testée) ----------

/** Rayon d'un astre noté : de 0,18 (note 0) à 0,5 (note 100). Un modèle non noté est plus petit que tous les autres. */
export const MIN_RADIUS = 0.18;
export const MAX_RADIUS = 0.5;
export const UNRATED_RADIUS = 0.14;
export const UNRATED_COLOR = '#7F8C95';
/** Première orbite, écart entre deux orbites et rayon maximal (plafond quand il y a beaucoup de modèles). */
export const FIRST_ORBIT = 1.5;
export const ORBIT_STEP = 0.62;
export const MAX_ORBIT = 6;
/** Vitesse angulaire (rad/s) : du plus lent (débit nul ou inconnu) au plus rapide (le plus haut débit). */
export const MIN_SPEED = 0.15;
export const MAX_SPEED = 0.7;
const FLOW = 520;
const STARS = 1200;

export function astreRadius(quality: number | null): number {
  if (quality === null || !Number.isFinite(quality)) return UNRATED_RADIUS;
  const q = Math.min(100, Math.max(0, quality));
  return MIN_RADIUS + (q / 100) * (MAX_RADIUS - MIN_RADIUS);
}

export function astreColor(color: string, quality: number | null): string {
  return quality === null || !Number.isFinite(quality) ? UNRATED_COLOR : color;
}

/** Rayon de l'orbite du i-ième astre : régulier, resserré au-delà de MAX_ORBIT. */
export function orbitRadius(index: number, count: number): number {
  const step = Math.min(ORBIT_STEP, (MAX_ORBIT - FIRST_ORBIT) / Math.max(1, count - 1));
  return FIRST_ORBIT + index * step;
}

/** Vitesse d'orbite croissante avec le débit (relatif au plus haut débit), bornée ; débit inconnu : la plus lente. */
export function orbitSpeed(tokensPerS: number | null, maxTokensPerS: number): number {
  if (tokensPerS === null || !(tokensPerS > 0) || !(maxTokensPerS > 0)) return MIN_SPEED;
  const ratio = Math.min(1, tokensPerS / maxTokensPerS);
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * ratio;
}

/** Particules entre le centre et les astres, étoiles du fond : moitié moins sur mobile. */
export function flowCount(isMobile: boolean): number {
  return isMobile ? FLOW / 2 : FLOW;
}
export function starCount(isMobile: boolean): number {
  return isMobile ? STARS / 2 : STARS;
}

/** Position d'un astre à l'instant `time` (plan x-z, léger balancement vertical). */
export function orbitPosition(radius: number, speed: number, phase: number, time: number): { x: number; y: number; z: number } {
  const a = time * speed + phase;
  return { x: Math.cos(a) * radius, y: Math.sin(a * 2) * 0.08, z: Math.sin(a) * radius };
}

const astreKey = (m: ConstellationData['models'][number]) => `${m.id}|${m.color}|${m.quality}|${m.tokensPerS}`;

// ---------- survol : remontée vers React (testée) ----------

/**
 * Événement émis par le canevas (il remonte dans le DOM) quand l'astre survolé change ou se déplace à l'écran.
 * `detail` vaut `null` quand plus aucun astre n'est survolé.
 */
export const CONSTELLATION_HOVER_EVENT = 'constellation-hover';
/** Astre survolé : identifiant du modèle, centre à l'écran (px CSS, relatif au canevas) et rayon apparent du halo (px). */
export type ConstellationHover = { id: string; x: number; y: number; r: number };

/** Coordonnées normalisées (-1 à 1, y vers le haut) vers des pixels CSS du canevas (y vers le bas). */
export function ndcToScreen(ndcX: number, ndcY: number, width: number, height: number): { x: number; y: number } {
  return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height };
}

/** Même astre, déplacé de moins d'un demi-pixel : inutile de réémettre l'événement. */
export function sameHover(a: ConstellationHover | null, b: ConstellationHover | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.r - b.r) < 0.5;
}

/**
 * Place une étiquette de taille `label` au-dessus de l'astre (en dessous s'il manque de place), centrée sur lui
 * et maintenue dans le cadre `box` avec une marge.
 */
export function placeLabel(
  hover: Pick<ConstellationHover, 'x' | 'y' | 'r'>,
  label: { w: number; h: number },
  box: { w: number; h: number },
  gap = 8,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, box.w - label.w - margin);
  const left = Math.min(maxLeft, Math.max(margin, hover.x - label.w / 2));
  const above = hover.y - hover.r - gap - label.h;
  const below = Math.min(Math.max(margin, box.h - label.h - margin), hover.y + hover.r + gap);
  return { left, top: above >= margin ? above : below };
}

// ---------- scène (ne fait que dessiner) ----------

const FOV = 48;
const CAM = { y: 2.6, z: 9.5 };
const HUB_COLOR = 0xffb48a;
const HALO_OPACITY = 0.12;
const HALO_OPACITY_HOVER = 0.32; // l'astre survolé est mis en valeur, sans mouvement de caméra

type Astre = { id: string; key: string; size: number; radius: number; speed: number; phase: number; mesh: Mesh; halo: Mesh; ring: Mesh };

/**
 * « Constellation » : un astre par modèle (taille = qualité, vitesse de rotation = débit, couleur du modèle, gris sans note),
 * orbites dans l'ordre reçu (le premier au plus près du centre), des particules du centre vers les astres.
 * Sur grand écran, l'astre survolé est mis en valeur et signalé par `CONSTELLATION_HOVER_EVENT` sur le canevas ;
 * la caméra ne fait que dériver lentement.
 */
export const constellationScene: SceneFactory = ({ THREE, canvas, width, height, isMobile, pixelRatio }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  let fitScale = 1;
  let needHalfW = FIRST_ORBIT + 0.9;
  let size = { w: width, h: height };
  function fit(w: number, h: number) {
    size = { w, h };
    const aspect = w / h;
    const tan = Math.tan((FOV / 2) * (Math.PI / 180));
    const dist = Math.hypot(CAM.y, CAM.z);
    fitScale = Math.max(1, needHalfW / (dist * tan * aspect));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  fit(width, height);

  // Fond, lumières, centre.
  const stars = starCount(isMobile);
  const starPos = new Float32Array(stars * 3);
  for (let i = 0; i < stars; i++) starPos.set([(Math.random() - 0.5) * 50, (Math.random() - 0.5) * 30, -10 - Math.random() * 12], i * 3);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x5d97b8, size: 0.045 })));
  scene.add(new THREE.AmbientLight(0x335566, 1.4));
  scene.add(new THREE.PointLight(0xffffff, 60, 40));
  const hub = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 3), new THREE.MeshBasicMaterial({ color: HUB_COLOR }));
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 32), new THREE.MeshBasicMaterial({ color: 0xf0631f, transparent: true, opacity: 0.2 }));
  scene.add(hub, glow);

  // Particules du centre vers les astres.
  const flowN = flowCount(isMobile);
  const flowPos = new Float32Array(flowN * 3);
  const flowGeo = new THREE.BufferGeometry();
  flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
  const flowMeta = Array.from({ length: flowN }, (_, i) => ({ astre: i, t: Math.random() }));
  const flowPoints = new THREE.Points(flowGeo, new THREE.PointsMaterial({ color: 0x9fd6f7, size: 0.03, transparent: true, opacity: 0.85 }));
  flowPoints.frustumCulled = false;
  scene.add(flowPoints);

  let astres: Astre[] = [];
  let time = 0;

  const disposeObject = (o: Object3D) => {
    o.traverse((x) => {
      const m = x as Mesh;
      m.geometry?.dispose();
      const mat = m.material as Material | Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((y) => y.dispose());
    });
  };

  // ---------- interaction : survol d'un astre (grand écran seulement), signalé à React par un événement ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const projected = new THREE.Vector3();
  let pointer: { x: number; y: number } | null = null; // pointeur en coordonnées normalisées, nul hors du canevas
  let hovered: Astre | null = null;
  let lastHover: ConstellationHover | null = null;
  let listeners: Array<() => void> = [];
  const on = <E extends keyof HTMLElementEventMap>(type: E, fn: (e: HTMLElementEventMap[E]) => void) => {
    canvas.addEventListener(type, fn as EventListener);
    listeners.push(() => canvas.removeEventListener(type, fn as EventListener));
  };
  const haloMaterial = (a: Astre) => a.halo.material as Material & { opacity: number };

  /** Position à l'écran d'un astre : centre et rayon apparent de son halo. */
  function screenOf(a: Astre): ConstellationHover {
    projected.copy(a.mesh.position).project(camera);
    const c = ndcToScreen(projected.x, projected.y, size.w, size.h);
    projected.copy(a.mesh.position).setY(a.mesh.position.y + a.size).project(camera);
    const top = ndcToScreen(projected.x, projected.y, size.w, size.h);
    return { id: a.id, x: c.x, y: c.y, r: Math.abs(c.y - top.y) };
  }

  /** Émet l'événement de survol si l'astre survolé ou sa position à l'écran a changé. */
  function emitHover() {
    const next = hovered ? screenOf(hovered) : null;
    if (sameHover(lastHover, next)) return;
    lastHover = next;
    canvas.dispatchEvent(new CustomEvent<ConstellationHover | null>(CONSTELLATION_HOVER_EVENT, { bubbles: true, detail: next }));
  }

  function setHovered(a: Astre | null) {
    if (hovered && hovered !== a) haloMaterial(hovered).opacity = HALO_OPACITY;
    hovered = a;
    if (a) haloMaterial(a).opacity = HALO_OPACITY_HOVER;
    canvas.style.cursor = a ? 'help' : '';
    emitHover();
  }

  /** Astre sous le pointeur ; les astres tournent, d'où un nouvel essai à chaque image tant que le pointeur reste sur le canevas. */
  function pick() {
    if (!pointer) return setHovered(null);
    ndc.set(pointer.x, pointer.y);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(
      astres.map((a) => a.halo),
      false,
    )[0];
    setHovered(hit ? (astres.find((a) => a.halo === hit.object) ?? null) : null);
  }

  function detachInteraction() {
    listeners.forEach((off) => off());
    listeners = [];
    pointer = null;
    setHovered(null);
  }
  function attachInteraction() {
    on('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      pointer = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
      pick();
    });
    on('pointerleave', () => {
      pointer = null;
      setHovered(null);
    });
  }

  function build(models: ConstellationData['models']) {
    setHovered(null);
    astres.forEach((a) => {
      for (const o of [a.mesh, a.halo, a.ring]) {
        scene.remove(o);
        disposeObject(o);
      }
    });
    const maxTps = Math.max(0, ...models.map((m) => m.tokensPerS ?? 0));
    astres = models.map((m, i) => {
      const color = new THREE.Color(astreColor(m.color, m.quality));
      const radius = astreRadius(m.quality);
      const R = orbitRadius(i, models.length);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 40, 40),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.35 }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.9, 24, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: HALO_OPACITY }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(R - 0.006, R + 0.006, 160),
        new THREE.MeshBasicMaterial({ color: 0x3fa2e0, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
      );
      ring.rotation.x = Math.PI / 2;
      scene.add(mesh, halo, ring);
      return { id: m.id, key: astreKey(m), size: radius * 1.9, radius: R, speed: orbitSpeed(m.tokensPerS, maxTps), phase: i * 1.1, mesh, halo, ring };
    });
    needHalfW = (astres.length ? orbitRadius(astres.length - 1, astres.length) : FIRST_ORBIT) + 0.9;
    fit(size.w, size.h);
  }

  function setData(raw: unknown) {
    const models = (raw as ConstellationData | undefined)?.models ?? [];
    const same = models.length === astres.length && models.every((m, i) => astres[i]!.key === astreKey(m));
    if (!same) build(models);
  }

  const gate =
    typeof window.matchMedia === 'function'
      ? createInteractionGate(window.matchMedia('(min-width: 1024px)'), { attach: attachInteraction, detach: detachInteraction })
      : null;

  function update(dt: number) {
    time += dt;
    hub.rotation.y += dt * 0.6;
    glow.scale.setScalar(1 + 0.1 * Math.sin(time * 3));
    for (const a of astres) {
      const p = orbitPosition(a.radius, a.speed, a.phase, time);
      a.mesh.position.set(p.x, p.y, p.z);
      a.halo.position.copy(a.mesh.position);
      a.halo.updateMatrixWorld();
      a.mesh.rotation.y += dt * 1.2;
    }

    const attr = flowGeo.attributes.position as BufferAttribute;
    for (let i = 0; i < flowN; i++) {
      const d = flowMeta[i]!;
      if (astres.length === 0) {
        flowPos[i * 3] = flowPos[i * 3 + 1] = flowPos[i * 3 + 2] = 0;
        continue;
      }
      d.t += dt * 0.3;
      if (d.t > 1) {
        d.t = 0;
        d.astre = Math.floor(Math.random() * astres.length);
      }
      const q = astres[d.astre % astres.length]!.mesh.position;
      const k = d.t;
      flowPos[i * 3] = q.x * k + Math.sin(k * 10 + i) * 0.04;
      flowPos[i * 3 + 1] = q.y * k + Math.sin(k * Math.PI) * 0.35;
      flowPos[i * 3 + 2] = q.z * k;
    }
    attr.needsUpdate = true;

    // Caméra : simple dérive lente autour du centre ; plus de plongée vers l'astre survolé (l'affichage ne « saute » plus).
    camera.position.set(Math.sin(time * 0.08) * 1.2 * fitScale, CAM.y * fitScale, CAM.z * fitScale);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    // Survol rejoué à chaque image : l'astre peut quitter le pointeur, l'étiquette suit sa position.
    if (pointer) pick();
  }

  return {
    render(dt) {
      update(dt);
      renderer.render(scene, camera);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      fit(w, h);
      if (pointer) pick();
    },
    setData,
    dispose() {
      gate?.dispose();
      detachInteraction();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
