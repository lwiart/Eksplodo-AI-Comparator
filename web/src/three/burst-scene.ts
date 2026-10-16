import type { SceneFactory } from './useThreeScene';

const ORANGE = 0xf0631f;
const SKY = 0x7cc4ef;
const DEEP_BLUE = 0x0c659d;
const CORE = 0x011f2e;

/** Gerbe Eksplodo (thème « Nuit ») : rayons qui pulsent autour d'un cœur sombre cerclé d'orange, sur un ciel d'étoiles. */
export const burstScene: SceneFactory = ({ THREE, canvas, width, height, isMobile, pixelRatio }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  if (!isMobile) {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions.set([(Math.random() - 0.5) * 50, (Math.random() - 0.5) * 30, -8 - Math.random() * 14], i * 3);
    }
    const geometry = track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(geometry, track(new THREE.PointsMaterial({ color: 0x5d97b8, size: 0.045 }))));
  }

  const group = new THREE.Group();
  scene.add(group);

  const rayCount = isMobile ? 60 : 140;
  const rays: Array<{ mesh: import('three').Mesh; phase: number }> = [];
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    const length = 0.8 + Math.random() * 1.8;
    const geometry = track(new THREE.BoxGeometry(length, 0.05, 0.05));
    geometry.translate(length / 2, 0, 0);
    const accent = i % 7 === 0;
    const color = accent ? ORANGE : i % 3 === 0 ? SKY : DEEP_BLUE;
    const material = track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: accent ? 1 : 0.75 }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.z = angle;
    mesh.position.set(Math.cos(angle) * 1.45, Math.sin(angle) * 1.45, 0);
    group.add(mesh);
    rays.push({ mesh, phase: Math.random() * Math.PI * 2 });
  }

  group.add(new THREE.Mesh(track(new THREE.SphereGeometry(1.25, 48, 48)), track(new THREE.MeshBasicMaterial({ color: CORE }))));
  group.add(new THREE.Mesh(track(new THREE.TorusGeometry(1.3, 0.03, 12, 120)), track(new THREE.MeshBasicMaterial({ color: ORANGE }))));
  const halo = new THREE.Mesh(
    track(new THREE.SphereGeometry(1.7, 32, 32)),
    track(new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.07 })),
  );
  group.add(halo);

  // Grand écran : la gerbe passe à droite, la carte de connexion occupe la gauche. Mobile : centrée derrière la carte.
  const place = (w: number, h: number) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    group.position.x = w / h > 1.2 ? 4.2 : 0;
  };
  place(width, height);

  let t = 0;
  return {
    render(dt) {
      t += dt;
      for (const ray of rays) ray.mesh.scale.x = 1 + 0.35 * Math.sin(t * 1.6 + ray.phase);
      group.rotation.z += dt * 0.11;
      group.rotation.y = Math.sin(t * 0.3) * 0.25;
      halo.scale.setScalar(1 + 0.06 * Math.sin(t * 2));
      renderer.render(scene, camera);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      place(w, h);
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    },
  };
};
