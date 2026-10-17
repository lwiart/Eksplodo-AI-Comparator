import type { BufferAttribute, BufferGeometry, Group, Line, Material, Mesh, Shape, Sprite, Texture, Vector3 } from 'three';
import { magnetOffset, pickNearest, springStep } from './fanout-physics';
import { MAIN_PROVIDERS } from './providers';
import type { SceneFactory } from './useThreeScene';

// Valeurs de la maquette validée (docs/superpowers/maquettes/connexion-fanout.html, « Retenu · Bulle & jauge ronde »).
const CYCLE = 7.5; // durée d'un tour : envoi, réponses, notes, podium
const OFFSET_X = 3.2; // la scène est poussée vers la droite : la carte de connexion occupe la gauche
const PX = -2.4; // bulle du prompt
const JX = 7.4; // jauge du juge
const CX = 2.5; // centre de l'arc des logos
const K = 70; // raideur du ressort de retour
const C = 6.5; // amortissement (sous-critique : rebond)
const HOVER_R = 1.6; // rayon de l'aimant au survol
const MAGNET = 0.35; // force de l'aimant
const GRAB_R = 0.6; // rayon de saisie
const ORANGE = 0xf0631f;
const PEACH = 0xffb48a;
const BLUE = 0x3fa2e0;
const FONT_MONO = '"Noto Sans Mono", monospace';
const PROMPT_FOV = 45;
const BASE_DIST = 13;
/** Demi-largeur (repère de la scène) à garder visible : jauge + légende à droite. */
const NEED_HALF_RIGHT = 9.6;
/** Étendue horizontale de la scène (repère du groupe), pour la centrer sur petit écran. */
const SCENE_CENTER_X = 2.85;
const SCENE_HALF_W = 7.0;
const CENTERED_BELOW = 1024; // en dessous, la carte est centrée : la scène l'est aussi (en fond)

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Facteur de lissage de la maquette (réglé pour 60 images/s), rendu indépendant de la cadence. */
const ease = (k: number, dt: number) => 1 - Math.pow(1 - k, dt * 60);

type Pulser = { g: Group; update(t: number, dt: number): void; onSend(): void; onScore(score: number): void };
type Label = { sprite: Sprite; set(text: string, color?: string): void };

/** « Un prompt, huit réponses » : le prompt part vers huit modèles, le juge note, puis on recommence. */
export const fanoutScene: SceneFactory = ({ THREE, canvas, width, height, isMobile, pixelRatio }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(PROMPT_FOV, width / height, 0.1, 200);
  const root = new THREE.Group();
  root.position.x = OFFSET_X;
  scene.add(root);

  let disposed = false;
  const redraws: Array<() => void> = [];
  const textures: Texture[] = [];
  const renderNow = () => {
    if (!disposed) renderer.render(scene, camera);
  };

  // ---------- caméra : toute la scène reste visible quel que soit le format ----------
  function fit(w: number, h: number) {
    const aspect = w / h;
    const tan = Math.tan((PROMPT_FOV / 2) * (Math.PI / 180));
    const centered = w < CENTERED_BELOW;
    const camX = centered ? SCENE_CENTER_X : 0;
    const dist = centered
      ? Math.max(BASE_DIST, SCENE_HALF_W / (tan * aspect))
      : BASE_DIST * Math.max(1, NEED_HALF_RIGHT / (BASE_DIST * tan * aspect));
    camera.aspect = aspect;
    camera.position.set(OFFSET_X + camX, 0, dist);
    camera.lookAt(OFFSET_X + camX, 0, 0);
    camera.updateProjectionMatrix();
  }
  fit(width, height);

  // ---------- textures et sprites ----------
  function canvasTexture(w: number, h: number) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) throw new Error('contexte 2D indisponible');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    textures.push(tex);
    return { g, tex };
  }

  function label(text: string, opts: { color?: string; size?: number; w?: number; h?: number } = {}): Label {
    const { color = '#d8ecf5', size = 42, w = 512, h = 96 } = opts;
    const { g, tex } = canvasTexture(w, h);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    let current = text;
    let currentColor = color;
    const draw = () => {
      g.clearRect(0, 0, w, h);
      g.font = `600 ${size}px ${FONT_MONO}`;
      g.fillStyle = currentColor;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(current, w / 2, h / 2 + 2);
      tex.needsUpdate = true;
    };
    draw();
    redraws.push(draw); // les polices s'affichent après coup : on redessine une fois chargées
    sprite.scale.set((w / h) * 0.42, 0.42, 1);
    return {
      sprite,
      set(txt, col = color) {
        current = txt;
        currentColor = col;
        draw();
      },
    };
  }

  /** Pièce ronde : fond clair, anneau à la couleur du fournisseur, icône centrée (initiale si l'image ne charge pas). */
  const coinTextures = MAIN_PROVIDERS.map((p) => {
    const { g, tex } = canvasTexture(256, 256);
    const base = () => {
      g.clearRect(0, 0, 256, 256);
      g.beginPath();
      g.arc(128, 128, 118, 0, Math.PI * 2);
      g.fillStyle = '#f2f7fa';
      g.fill();
      g.lineWidth = 12;
      g.strokeStyle = p.color;
      g.stroke();
    };
    const initial = () => {
      g.fillStyle = '#032a3d';
      g.font = '800 110px Archivo, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(p.name.charAt(0), 128, 136);
    };
    base();
    tex.needsUpdate = true;
    if (typeof Image === 'undefined') {
      initial();
      return tex;
    }
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      base();
      g.drawImage(img, 58, 58, 140, 140);
      tex.needsUpdate = true;
      renderNow(); // image fixe (animations coupées) : on la rafraîchit
    };
    img.onerror = () => {
      if (disposed) return;
      base();
      initial();
      tex.needsUpdate = true;
      renderNow();
    };
    img.src = p.icon;
    return tex;
  });

  function coin(i: number, size: number): Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: coinTextures[i], transparent: true, depthWrite: false }));
    s.scale.set(size, size, 1);
    return s;
  }

  if (!isMobile) {
    const n = 700;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 34, -14 - Math.random() * 12], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(a, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x5d97b8, size: 0.05 })));
  }
  scene.add(new THREE.AmbientLight(0x6688aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 6, 5);
  scene.add(sun);

  // ---------- prompt : la bulle ----------
  function roundRect(w: number, h: number, r: number): Shape {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  const std = (color: number, e = 0.35) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: e, roughness: 0.4 });

  function promptBubble(): Pulser {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.ExtrudeGeometry(roundRect(2.1, 1.3, 0.42), { depth: 0.18, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3 }),
      std(BLUE, 0.45),
    );
    body.position.z = -0.1;
    const tailShape = new THREE.Shape();
    tailShape.moveTo(-0.55, -0.6);
    tailShape.lineTo(-0.95, -1.05);
    tailShape.lineTo(-0.15, -0.6);
    const tail = new THREE.Mesh(new THREE.ExtrudeGeometry(tailShape, { depth: 0.18, bevelEnabled: false }), std(BLUE, 0.45));
    tail.position.z = -0.1;
    const dots = [-0.42, 0, 0.42].map((x) => {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 20), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      d.position.set(x, 0, 0.2);
      return d;
    });
    g.add(body, tail, ...dots);
    let pulse = 0;
    return {
      g,
      update(t, dt) {
        dots.forEach((d, i) => (d.position.y = Math.max(0, Math.sin(t * 6 - i * 0.7)) * 0.16));
        pulse = Math.max(0, pulse - dt * 3);
        g.scale.setScalar(1 + pulse * 0.12);
        g.rotation.y = Math.sin(t * 0.6) * 0.15;
      },
      onSend() {
        pulse = 1;
      },
      onScore() {},
    };
  }

  // ---------- juge : la jauge ronde ----------
  function judgeGaugeRound(): Pulser {
    const g = new THREE.Group();
    const R = 0.95;
    const track = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 16, 160), new THREE.MeshBasicMaterial({ color: 0x0c3a52 }));
    const fill = new THREE.Mesh(new THREE.TorusGeometry(R, 0.1, 16, 160, 0.01), new THREE.MeshBasicMaterial({ color: ORANGE }));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 20), new THREE.MeshBasicMaterial({ color: PEACH }));
    const num = label('', { size: 64, color: '#fff', w: 320, h: 128 });
    num.sprite.scale.set(1.25, 0.5, 1);
    num.sprite.position.set(0, 0.06, 0.1);
    const cap = label('/ 10', { size: 28, color: '#7fa3b5', w: 256, h: 64 });
    cap.sprite.scale.set(0.9, 0.22, 1);
    cap.sprite.position.set(0, -0.4, 0.1);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(R - 0.14, 64),
      new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.08 }),
    );
    glow.position.z = -0.05;
    g.add(glow, track, fill, tip, num.sprite, cap.sprite);
    let val = 0;
    let target = 0;
    let shown = -1;
    let builtArc = 0.01;
    return {
      g,
      update(t, dt) {
        val = lerp(val, target, ease(0.08, dt));
        const arc = Math.max(0.01, (val / 10) * Math.PI * 2);
        if (Math.abs(arc - builtArc) > 0.002) {
          fill.geometry.dispose();
          fill.geometry = new THREE.TorusGeometry(R, 0.1, 16, 160, arc);
          builtArc = arc;
        }
        fill.rotation.z = Math.PI / 2 - arc;
        const a = Math.PI / 2 - arc;
        tip.position.set(Math.cos(a) * R, Math.sin(a) * R, 0.02);
        tip.visible = val > 0.05;
        const v = Math.round(val * 10) / 10;
        if (v !== shown) {
          shown = v;
          num.set(v.toFixed(1));
        }
        (glow.material as import('three').MeshBasicMaterial).opacity = 0.06 + 0.04 * Math.sin(t * 3);
        g.rotation.y = Math.sin(t * 0.4) * 0.2;
      },
      onSend() {
        target = 0;
      },
      onScore(s) {
        target = s;
      },
    };
  }

  const prompt = promptBubble();
  const judge = judgeGaugeRound();
  const PROMPT = new THREE.Vector3(PX, 0, 0);
  const JUDGE = new THREE.Vector3(JX, 0, 0);
  prompt.g.position.copy(PROMPT);
  judge.g.position.copy(JUDGE);
  root.add(prompt.g, judge.g);
  for (const [txt, x] of [['PROMPTS, DOCUMENTS, CODE…', PX] as const, ['JUGE IA', JX] as const]) {
    const lb = label(txt, { size: 30, color: '#fff', w: 640 });
    lb.sprite.position.set(x, -1.6, 0);
    root.add(lb.sprite);
  }

  // ---------- les huit logos et leurs deux élastiques ----------
  // Les liens sont des « élastiques » : leur géométrie suit la position courante du logo.
  const mkLine = (color: number): Line => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.14 }));
    root.add(l);
    return l;
  };
  const setLine = (l: Line, a: Vector3, b: Vector3) => {
    const attr = (l.geometry as BufferGeometry).attributes.position as BufferAttribute;
    const p = attr.array as Float32Array;
    p[0] = a.x;
    p[1] = a.y;
    p[2] = a.z;
    p[3] = b.x;
    p[4] = b.y;
    p[5] = b.z;
    attr.needsUpdate = true;
    l.geometry.computeBoundingSphere();
  };

  type Node = {
    c: Sprite;
    home: Vector3;
    pos: Vector3;
    vel: Vector3;
    inL: Line;
    outL: Line;
    dotIn: Mesh;
    dotOut: Mesh;
    sc: Label;
    tm: Label;
    lat: number;
    score: number;
    rank: number;
    pop: number;
    ph: number;
    hover: boolean;
  };
  const N = MAIN_PROVIDERS.length;
  const nodes: Node[] = MAIN_PROVIDERS.map((p, i) => {
    const k = i / (N - 1);
    const home = new THREE.Vector3(CX + Math.sin(k * Math.PI) * 1.1, 3.7 - k * 7.4, 0);
    const c = coin(i, 0.9);
    root.add(c);
    const inL = mkLine(BLUE);
    const outL = mkLine(ORANGE);
    const dotIn = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: 0x9fd6f7 }));
    const dotOut = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color) }));
    root.add(dotIn, dotOut);
    const sc = label('', { size: 40, color: '#FFB48A' });
    const tm = label('', { size: 28, color: '#7fa3b5' });
    sc.sprite.visible = tm.sprite.visible = false;
    root.add(sc.sprite, tm.sprite);
    return {
      c, home, pos: home.clone(), vel: new THREE.Vector3(), inL, outL, dotIn, dotOut, sc, tm,
      lat: 0, score: 0, rank: 0, pop: 0, ph: Math.random() * Math.PI * 2, hover: false,
    };
  });
  const positions = nodes.map((n) => n.pos);

  // ---------- interaction : survol (aimant) et glisser-déposer (retour élastique) ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  const mouse = new THREE.Vector3(1e3, 1e3, 0);
  let drag: Node | null = null;
  const toLocal = (e: PointerEvent): Vector3 | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(plane, hit) ? hit.clone().sub(root.position) : null;
  };
  const pick = (p: Vector3): Node | null => nodes[pickNearest(positions, p, GRAB_R)] ?? null;

  const listeners: Array<() => void> = [];
  if (!isMobile) {
    const on = <E extends keyof HTMLElementEventMap>(type: E, fn: (e: HTMLElementEventMap[E]) => void) => {
      canvas.addEventListener(type, fn as EventListener);
      listeners.push(() => canvas.removeEventListener(type, fn as EventListener));
    };
    on('pointermove', (e) => {
      const p = toLocal(e as PointerEvent);
      if (!p) return;
      mouse.copy(p);
      if (drag) drag.pos.copy(p);
      canvas.style.cursor = drag ? 'grabbing' : pick(p) ? 'grab' : 'default';
    });
    on('pointerleave', () => {
      if (!drag) mouse.set(1e3, 1e3, 0);
    });
    on('pointerdown', (e) => {
      const p = toLocal(e as PointerEvent);
      const n = p && pick(p);
      if (!n) return;
      drag = n;
      n.vel.set(0, 0, 0);
      canvas.setPointerCapture((e as PointerEvent).pointerId);
      canvas.style.cursor = 'grabbing';
    });
    const release = () => {
      if (!drag) return;
      drag = null;
      canvas.style.cursor = 'grab';
    };
    on('pointerup', release);
    on('pointercancel', release);
  }

  // ---------- cycle ----------
  let T = 0;
  let ranked = false;
  function reset() {
    T = 0;
    ranked = false;
    prompt.onSend();
    judge.onSend();
    nodes.forEach((n) => {
      n.lat = 1.1 + Math.random() * 2.6;
      n.score = +(6.4 + Math.random() * 3.4).toFixed(1);
      n.rank = 0;
      n.pop = 0;
      n.sc.sprite.visible = n.tm.sprite.visible = false;
    });
  }
  reset();

  let time = 0;
  const target = new THREE.Vector3();
  function update(dt: number) {
    time += dt;
    const t = time;
    T += dt;
    prompt.update(t, dt);
    judge.update(t, dt);
    const send = Math.min(1, T / 1.0);
    nodes.forEach((n) => {
      // cible = position d'origine + léger flottement + aimant vers la souris
      target.set(Math.sin(t * 0.9 + n.ph) * 0.13, Math.cos(t * 1.15 + n.ph * 1.3) * 0.11, 0).add(n.home);
      n.hover = drag !== n && n.pos.distanceTo(mouse) < GRAB_R;
      if (drag !== n) {
        const m = magnetOffset(n.home, mouse, HOVER_R, MAGNET);
        target.x += m.x;
        target.y += m.y;
        springStep(n.pos, n.vel, target, K, C, dt);
      }
      n.c.position.copy(n.pos);
      n.c.material.rotation = Math.sin(t * 1.3 + n.ph) * 0.09 - n.vel.x * 0.04;
      // taille : réponse reçue (petit « pop »), podium, logo saisi
      n.pop = Math.max(0, n.pop - dt * 2.5);
      const s = lerp(
        n.c.scale.x,
        (n.rank && n.rank <= 3 ? 1.2 : 0.9) * (drag === n ? 1.15 : n.hover ? 1.1 : 1) + n.pop * 0.25,
        ease(0.12, dt),
      );
      n.c.scale.set(s, s, 1);
      // élastiques : plus on tire, plus le lien s'illumine
      const stretch = Math.min(1, n.pos.distanceTo(n.home) / 2.5);
      setLine(n.inL, PROMPT, n.pos);
      setLine(n.outL, n.pos, JUDGE);
      n.dotIn.visible = send < 1;
      n.dotIn.position.lerpVectors(PROMPT, n.pos, send);
      (n.inL.material as import('three').LineBasicMaterial).opacity = (send < 1 ? 0.4 : 0.12) + stretch * 0.7;
      const back = Math.max(0, Math.min(1, (T - 1 - n.lat) / 0.9));
      if (T > 1 + n.lat && !n.tm.sprite.visible) {
        n.tm.set(`${n.lat.toFixed(1)} s`);
        n.tm.sprite.visible = true;
        n.pop = 1;
      }
      n.dotOut.visible = back > 0 && back < 1;
      n.dotOut.position.lerpVectors(n.pos, JUDGE, back);
      (n.outL.material as import('three').LineBasicMaterial).opacity = (back > 0 && back < 1 ? 0.45 : 0.12) + stretch * 0.7;
      if (back >= 1 && !n.sc.sprite.visible) {
        n.sc.set(`${n.score} / 10`);
        n.sc.sprite.visible = true;
        judge.onScore(n.score);
      }
      n.sc.sprite.position.set(n.pos.x + 1.45, n.pos.y, 0);
      n.tm.sprite.position.set(n.pos.x - 1.6, n.pos.y, 0);
    });
    if (!ranked && nodes.every((n) => n.sc.sprite.visible)) {
      ranked = true;
      [...nodes]
        .sort((a, b) => b.score - a.score)
        .forEach((n, k) => {
          n.rank = k + 1;
          if (k < 3) n.sc.set(`${['🥇', '🥈', '🥉'][k]} ${n.score}`, '#FFB48A');
          else n.sc.set(`${n.score} / 10`, '#7fa3b5');
        });
    }
    if (T > CYCLE) reset();
  }

  // Les polices auto-hébergées se chargent à la demande : on redessine les légendes dès qu'elles sont prêtes.
  if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
    void Promise.all([document.fonts.load(`600 30px ${FONT_MONO}`), document.fonts.load('800 110px Archivo')])
      .then(() => {
        if (disposed) return;
        redraws.forEach((fn) => fn());
        renderNow();
      })
      .catch(() => {});
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
    dispose() {
      disposed = true;
      listeners.forEach((off) => off());
      canvas.style.cursor = '';
      drag = null;
      scene.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mat = m.material as Material | Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      textures.forEach((t) => t.dispose());
      renderer.dispose();
    },
  };
};
