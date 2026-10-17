import type { BufferAttribute, Line, Material, Mesh, MeshBasicMaterial, Object3D } from 'three';
import type { SceneFactory } from './useThreeScene';

/** Données de la scène « flux en direct » : les modèles de la série, les appels en cours, les derniers résultats. */
export type LiveFlowData = {
  models: { id: string; color: string }[];
  running: { modelId: string }[];
  finished: { resultId: string; modelId: string; ok: boolean }[];
};

// ---------- géométrie pure (testée) ----------

/** Demi-axes de l'ellipse des modèles (plan x-z) et ouverture de l'arc : une demi-ellipse derrière le prompt. */
export const ARC_RX = 3.6;
export const ARC_RZ = 2.2;
export const ARC_SPAN = Math.PI;
/** Chaque appel en cours est une traînée de particules du prompt vers le modèle. */
export const PARTICLES_PER_CALL = 8;
export const MAX_PARTICLES = 320;
const STARS = 700;

export const FLASH_OK = '#4FD1A5';
export const FLASH_ERROR = '#FF7A7A';

export type Point3 = { x: number; y: number; z: number };

/**
 * Positions des nœuds des modèles : sur une demi-ellipse au fond (z < 0), ouverte vers la caméra, de gauche à droite ; chaque nœud au milieu de sa part d'arc (deux modèles dessinent déjà un arc).
 * Un seul modèle se place au fond, dans l'axe du prompt.
 */
export function nodePositions(count: number): Point3[] {
  return Array.from({ length: count }, (_, i) => {
    const k = (i + 0.5) / count;
    const a = -Math.PI / 2 - ARC_SPAN / 2 + k * ARC_SPAN;
    return { x: Math.cos(a) * ARC_RX, y: 0, z: Math.sin(a) * ARC_RZ };
  });
}

/** Particules à dessiner : une traînée par appel en cours, moitié moins sur mobile, plafonnée. */
export function particleCount(running: number, isMobile: boolean): number {
  const perCall = isMobile ? PARTICLES_PER_CALL / 2 : PARTICLES_PER_CALL;
  const cap = isMobile ? MAX_PARTICLES / 2 : MAX_PARTICLES;
  return Math.min(Math.max(0, running) * perCall, cap);
}

/** Étoiles du fond : moitié moins sur mobile. */
export function starCount(isMobile: boolean): number {
  return isMobile ? STARS / 2 : STARS;
}

/** Résultats terminés pas encore signalés par un éclair. */
export function unseenFinished(seen: ReadonlySet<string>, finished: LiveFlowData['finished']): LiveFlowData['finished'] {
  return finished.filter((f) => !seen.has(f.resultId));
}

export function flashColor(ok: boolean): string {
  return ok ? FLASH_OK : FLASH_ERROR;
}

// ---------- scène (ne fait que dessiner) ----------

const FOV = 50;
const CAM = { y: 4.8, z: 7.6 }; // vue plongeante : l'arc des modèles se lit en profondeur
/** Demi-largeur à garder visible : l'arc et la taille des nœuds. */
const NEED_HALF_W = ARC_RX + 0.9;
const HUB_COLOR = 0xffb48a;
const PARTICLE_COLOR = 0xbfe5fb;
const STREAM_SPEED = 0.55; // traversées par seconde
const TRAIL_STEP = 0.035; // écart entre deux particules d'une même traînée
const FLASH_DECAY = 0.94; // par image à 60 images/s

type FlowNode = { id: string; color: string; sphere: Mesh; line: Line; flash: Mesh };
type Stream = { node: number; phase: number };

/**
 * « Flux en direct » : le prompt au centre, un nœud par modèle en arc ; une traînée de particules par appel en cours,
 * un éclair bref au nœud à chaque résultat terminé (vert réussi, rouge en erreur).
 */
export const liveFlowScene: SceneFactory = ({ THREE, canvas, width, height, isMobile, pixelRatio }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  const root = new THREE.Group();
  scene.add(root);

  function fit(w: number, h: number) {
    const aspect = w / h;
    const tan = Math.tan((FOV / 2) * (Math.PI / 180));
    const base = Math.hypot(CAM.y, CAM.z);
    const scale = Math.max(1, NEED_HALF_W / (base * tan * aspect));
    camera.aspect = aspect;
    camera.position.set(0, CAM.y * scale, CAM.z * scale);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  fit(width, height);

  // Fond étoilé, lumières, prompt central.
  const stars = starCount(isMobile);
  const starPos = new Float32Array(stars * 3);
  for (let i = 0; i < stars; i++) starPos.set([(Math.random() - 0.5) * 50, (Math.random() - 0.5) * 30, -8 - Math.random() * 14], i * 3);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x5d97b8, size: 0.045 })));
  scene.add(new THREE.AmbientLight(0x335566, 1.4));
  const light = new THREE.PointLight(0xffffff, 50, 40);
  light.position.set(0, 4, 4);
  scene.add(light);
  const hub = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 2), new THREE.MeshBasicMaterial({ color: HUB_COLOR, wireframe: true }));
  root.add(hub);

  // Particules : un tampon unique, seule la partie utile est dessinée.
  const capacity = particleCount(Number.MAX_SAFE_INTEGER, isMobile);
  const perCall = particleCount(1, isMobile);
  const flowPos = new Float32Array(capacity * 3);
  const flowGeo = new THREE.BufferGeometry();
  flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
  flowGeo.setDrawRange(0, 0);
  const flow = new THREE.Points(flowGeo, new THREE.PointsMaterial({ color: PARTICLE_COLOR, size: 0.09, transparent: true, opacity: 0.9 }));
  flow.frustumCulled = false;
  root.add(flow);

  let nodes: FlowNode[] = [];
  let streams: Stream[] = [];
  let seen = new Set<string>();
  let initialized = false;

  const disposeObject = (o: Object3D) => {
    o.traverse((x) => {
      const m = x as Mesh;
      m.geometry?.dispose();
      const mat = m.material as Material | Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((y) => y.dispose());
    });
  };

  function buildNodes(models: LiveFlowData['models']) {
    nodes.forEach((n) => {
      for (const o of [n.sphere, n.line, n.flash]) {
        root.remove(o);
        disposeObject(o);
      }
    });
    const positions = nodePositions(models.length);
    nodes = models.map((m, i) => {
      const p = positions[i]!;
      const color = new THREE.Color(m.color);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 32, 32),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
      );
      sphere.position.set(p.x, p.y, p.z);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), sphere.position.clone()]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }),
      );
      const flash = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 24), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      flash.position.copy(sphere.position);
      root.add(line, sphere, flash);
      return { id: m.id, color: m.color, sphere, line, flash };
    });
  }

  function setData(raw: unknown) {
    const data = raw as LiveFlowData;
    const sameModels = data.models.length === nodes.length && data.models.every((m, i) => nodes[i]!.id === m.id && nodes[i]!.color === m.color);
    if (!sameModels) buildNodes(data.models);
    const index = new Map(nodes.map((n, i) => [n.id, i] as const));

    // Appels en cours : on garde la phase des traînées qui continuent, pour un mouvement sans à-coup.
    const previous = streams;
    streams = data.running.flatMap((r, i) => {
      const node = index.get(r.modelId);
      if (node === undefined) return [];
      const same = previous[i];
      return [{ node, phase: same && same.node === node ? same.phase : Math.random() }];
    });
    flowGeo.setDrawRange(0, Math.min(capacity, streams.length * perCall));

    // Résultats : un éclair par résultat nouveau ; rien au premier affichage (ce sont des résultats déjà connus).
    if (initialized) {
      for (const f of unseenFinished(seen, data.finished)) {
        const n = nodes[index.get(f.modelId) ?? -1];
        if (!n) continue;
        const mat = n.flash.material as MeshBasicMaterial;
        mat.color.set(flashColor(f.ok));
        mat.opacity = 0.6;
      }
    }
    seen = new Set(data.finished.map((f) => f.resultId));
    initialized = true;
  }

  let time = 0;
  function update(dt: number) {
    time += dt;
    hub.rotation.y += dt * 0.72;
    hub.rotation.x += dt * 0.36;
    root.rotation.y = Math.sin(time * 0.12) * 0.3;

    const attr = flowGeo.attributes.position as BufferAttribute;
    let p = 0;
    for (const s of streams) {
      const target = nodes[s.node]!.sphere.position;
      for (let j = 0; j < perCall && p < capacity; j++, p++) {
        const k = (((s.phase + time * STREAM_SPEED - j * TRAIL_STEP) % 1) + 1) % 1;
        flowPos[p * 3] = target.x * k;
        flowPos[p * 3 + 1] = Math.sin(k * Math.PI) * 0.6;
        flowPos[p * 3 + 2] = target.z * k;
      }
    }
    attr.needsUpdate = true;

    const decay = Math.pow(FLASH_DECAY, dt * 60);
    for (const n of nodes) {
      const mat = n.flash.material as MeshBasicMaterial;
      mat.opacity = mat.opacity < 0.01 ? 0 : mat.opacity * decay;
      n.flash.visible = mat.opacity > 0;
      n.flash.scale.setScalar(1 + (0.6 - mat.opacity));
    }
  }

  return {
    render(dt) {
      update(dt);
      renderer.render(scene, camera);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      fit(w, h);
    },
    setData,
    dispose() {
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
