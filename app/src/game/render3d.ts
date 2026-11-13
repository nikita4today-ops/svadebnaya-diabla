/**
 * render3d.ts — WebGL-рендер мира «Свадебной Диаблы» на Three.js.
 * Камера — изометрическая в духе Diablo 3 (yaw 45°, pitch ~52°), следит за героем.
 * Игровая логика остаётся 2D (x,y в пикселях мира); здесь она отображается в 3D:
 *   мир (x, y) px → сцена (x/S, 0, y/S), высота — по оси Y.
 * Персонажи — анимированные билборды из запечённых кадров кукольной анимации,
 * эффекты — аддитивные кольца, веера, свечения; HUD рисуется поверх на 2D-canvas.
 */
import * as THREE from "three";
import { HumanRig, CatRig, heroOpts, enemyOpts } from "./characters3d";
import type { HumanOpts } from "./characters3d";

/** Масштаб: 40 пикселей мира = 1 единица сцены. */
export const S = 40;

interface Baked { walk: HTMLCanvasElement[]; attack: HTMLCanvasElement[]; W: number; H: number }

/** Всё, что нужно рендеру за кадр (ссылки на живые массивы игры). */
export interface View3D {
  time: number;
  mapCanvas: HTMLCanvasElement | null;
  mapId: string;
  target: { x: number; y: number };
  shake: number;
  players: any[];
  enemies: any[];
  corpses: any[];
  projs: any[];
  volleys: any[];
  particles: any[];
  waves: any[];
  cones: any[];
  telegraphs: any[];
  decals: any[];
  orbs: any[];
  golds: any[];
  loots: any[];
  satorus: any[];
  clones: any[];
  dragons: any[];
  tempLights: any[];
  meHeroId: string;
  bake: (id: string, cat: boolean) => Baked | undefined;
  lootColor: (kind: string) => string;
  skip: (sec: string) => boolean;
}

const TWO_PI = Math.PI * 2;

export class Renderer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private ground: THREE.Mesh | null = null;
  private groundTex: THREE.CanvasTexture | null = null;
  private groundMapId = "";

  // кэши текстур
  private canvasTex = new Map<HTMLCanvasElement, THREE.CanvasTexture>();
  private glowTex = new Map<string, THREE.CanvasTexture>();
  private bakedTex = new Map<string, { frames: THREE.Texture[]; attack: THREE.Texture[]; W: number; H: number }>();

  // пулы
  private sprites: THREE.Sprite[] = [];
  private spriteCursor = 0;
  private flats: THREE.Mesh[] = []; // плоские круги/элипсы на земле
  private flatCursor = 0;
  private rings: THREE.Mesh[] = [];
  private ringCursor = 0;
  private fans: THREE.Mesh[] = [];
  private fanCursor = 0;
  private lights: THREE.PointLight[] = [];
  private points: THREE.Points;
  private pointsGeo = new THREE.BufferGeometry();
  private readonly MAX_PARTICLES = 500;

  // пулы объёмных ригов (персонажи/враги/коты), ключ — живой объект игры
  private rigs = new Map<object, HumanRig>();
  private catRigs = new Map<object, CatRig>();
  private rigSeen = new Set<object>();
  private catSeen = new Set<object>();

  private camPos = new THREE.Vector3();
  private lastW = 0; private lastH = 0;

  constructor(private glCanvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 220);

    this.scene.background = new THREE.Color(0x07080c);
    this.scene.fog = new THREE.Fog(0x07080c, 34, 95);

    const hemi = new THREE.HemisphereLight(0x9aa8cc, 0x241c14, 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff0d8, 1.1);
    dir.position.set(14, 26, 8);
    this.scene.add(dir);

    // тёмная «пустота» под картой
    const voidMat = new THREE.MeshBasicMaterial({ color: 0x05060a });
    const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), voidMat);
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.set(32.5, -0.05, 32.5);
    this.scene.add(voidPlane);

    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.8);
      l.position.y = 1.4;
      this.lights.push(l);
      this.scene.add(l);
    }

    const mat = new THREE.PointsMaterial({
      size: 0.22, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.pointsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.MAX_PARTICLES * 3), 3));
    this.pointsGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.MAX_PARTICLES * 3), 3));
    this.points = new THREE.Points(this.pointsGeo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  setSize(w: number, h: number): void {
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w; this.lastH = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.glCanvas.style.width = `${w}px`;
    this.glCanvas.style.height = `${h}px`;
  }

  /** Проекция мировых координат (px, высота px) в экранные пиксели — для 2D-оверлея. */
  project(wx: number, heightPx: number, wz: number, outW: number, outH: number): { x: number; y: number; vis: boolean } {
    const v = new THREE.Vector3(wx / S, heightPx / S, wz / S).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * outW, y: (-v.y * 0.5 + 0.5) * outH, vis: v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15 };
  }

  dispose(): void {
    this.renderer.dispose();
    for (const t of this.canvasTex.values()) t.dispose();
    for (const t of this.glowTex.values()) t.dispose();
  }

  // ---------- внутреннее ----------

  private texOf(c: HTMLCanvasElement): THREE.CanvasTexture {
    let t = this.canvasTex.get(c);
    if (!t) {
      t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.canvasTex.set(c, t);
    }
    return t;
  }

  private glow(color: string): THREE.CanvasTexture {
    let t = this.glowTex.get(color);
    if (!t) {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const ctx = c.getContext("2d")!;
      const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.25, color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      this.glowTex.set(color, t);
    }
    return t;
  }

  private bakedFrames(v: View3D, id: string, cat: boolean): { frames: THREE.Texture[]; attack: THREE.Texture[]; W: number; H: number } | undefined {
    const key = id + (cat ? "|cat" : "");
    let e = this.bakedTex.get(key);
    if (e) return e;
    const b = v.bake(id, cat);
    if (!b) return undefined;
    e = {
      frames: b.walk.map((c) => this.texOf(c)),
      attack: b.attack.map((c) => this.texOf(c)),
      W: b.W, H: b.H,
    };
    this.bakedTex.set(key, e);
    return e;
  }

  private acquireSprite(): THREE.Sprite {
    if (this.spriteCursor < this.sprites.length) {
      const s = this.sprites[this.spriteCursor++];
      s.visible = true;
      return s;
    }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.sprites.push(s);
    this.scene.add(s);
    this.spriteCursor++;
    return s;
  }

  private acquireFlat(geo: "circle" | "ellipse"): THREE.Mesh {
    if (this.flatCursor < this.flats.length) {
      const m = this.flats[this.flatCursor++];
      m.visible = true;
      return m;
    }
    const g = new THREE.CircleGeometry(1, 40);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    this.flats.push(m);
    this.scene.add(m);
    this.flatCursor++;
    void geo;
    return m;
  }

  private acquireRing(): THREE.Mesh {
    if (this.ringCursor < this.rings.length) {
      const m = this.rings[this.ringCursor++];
      m.visible = true;
      return m;
    }
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 56),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    m.rotation.x = -Math.PI / 2;
    this.rings.push(m);
    this.scene.add(m);
    this.ringCursor++;
    return m;
  }

  private acquireFan(): THREE.Mesh {
    if (this.fanCursor < this.fans.length) {
      const m = this.fans[this.fanCursor++];
      m.visible = true;
      return m;
    }
    const m = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    m.rotation.x = -Math.PI / 2;
    this.fans.push(m);
    this.scene.add(m);
    this.fanCursor++;
    return m;
  }

  /** Риг по живому объекту игры (создаётся один раз, переиспользуется). */
  private humanRigFor(key: object, opts: HumanOpts): HumanRig {
    let r = this.rigs.get(key);
    if (!r) {
      r = new HumanRig(opts);
      this.scene.add(r.group);
      this.rigs.set(key, r);
    }
    this.rigSeen.add(key);
    return r;
  }

  private catRigFor(key: object): CatRig {
    let r = this.catRigs.get(key);
    if (!r) {
      r = new CatRig();
      this.scene.add(r.group);
      this.catRigs.set(key, r);
    }
    this.catSeen.add(key);
    return r;
  }

  /** Удаляет риги объектов, которых не было в этом кадре. */
  private endRigs(): void {
    for (const [k, r] of this.rigs) {
      if (!this.rigSeen.has(k)) { this.scene.remove(r.group); this.rigs.delete(k); }
    }
    for (const [k, r] of this.catRigs) {
      if (!this.catSeen.has(k)) { this.scene.remove(r.group); this.catRigs.delete(k); }
    }
    this.rigSeen.clear();
    this.catSeen.clear();
  }

  private endPools(): void {
    this.endRigs();
    for (let i = this.spriteCursor; i < this.sprites.length; i++) this.sprites[i].visible = false;
    for (let i = this.flatCursor; i < this.flats.length; i++) this.flats[i].visible = false;
    for (let i = this.ringCursor; i < this.rings.length; i++) this.rings[i].visible = false;
    for (let i = this.fanCursor; i < this.fans.length; i++) this.fans[i].visible = false;
    this.spriteCursor = 0; this.flatCursor = 0; this.ringCursor = 0; this.fanCursor = 0;
  }

  /** Билборд персонажа из запечённых кадров куклы. */
  private charSprite(
    v: View3D, id: string, cat: boolean, wx: number, wz: number, heightPx: number,
    walk: number, attackT: number, flip: boolean, alpha: number, tint?: number, lift = 0,
  ): void {
    const b = this.bakedFrames(v, id, cat);
    if (!b) return;
    const atk = Math.min(1, Math.max(0, attackT));
    const tex = atk > 0.02 ? b.attack[Math.min(3, Math.floor(atk * 4))] : b.frames[Math.floor((((walk % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI * 12) % 12];
    const spr = this.acquireSprite();
    const m = spr.material as THREE.SpriteMaterial;
    if (m.blending !== THREE.NormalBlending) { m.blending = THREE.NormalBlending; m.needsUpdate = true; }
    m.map = tex;
    m.opacity = alpha;
    m.color.setHex(tint ?? 0xffffff);
    m.rotation = 0;
    const hU = heightPx / S;
    const wU = (b.W / b.H) * hU;
    spr.scale.set(flip ? -wU : wU, hU, 1);
    spr.position.set(wx / S, hU / 2 + lift / S, wz / S);
  }

  private glowSprite(color: string, wx: number, wz: number, rPx: number, yU: number, alpha: number, additive = true): void {
    const spr = this.acquireSprite();
    const m = spr.material as THREE.SpriteMaterial;
    if (m.blending !== THREE.AdditiveBlending) { m.blending = THREE.AdditiveBlending; m.needsUpdate = true; }
    m.map = this.glow(color);
    m.opacity = alpha;
    m.color.setHex(0xffffff);
    void additive;
    const rU = (rPx * 2) / S;
    spr.scale.set(rU, rU, 1);
    spr.position.set(wx / S, yU, wz / S);
  }

  private flatCircle(wx: number, wz: number, rPx: number, ryPx: number, color: number, alpha: number, yU = 0.03): void {
    const m = this.acquireFlat("ellipse");
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    (m.material as THREE.MeshBasicMaterial).opacity = alpha;
    (m.material as THREE.MeshBasicMaterial).blending = THREE.NormalBlending;
    m.scale.set(rPx / S, ryPx / S, 1);
    m.position.set(wx / S, yU, wz / S);
  }

  private ring(wx: number, wz: number, rPx: number, color: number, alpha: number, yU = 0.06): void {
    const m = this.acquireRing();
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    (m.material as THREE.MeshBasicMaterial).opacity = alpha;
    m.scale.set(rPx / S, rPx / S, 1);
    m.position.set(wx / S, yU, wz / S);
  }

  private fan(wx: number, wz: number, dir: number, half: number, rangePx: number, color: number, alpha: number): void {
    const m = this.acquireFan();
    const segs = 22;
    const verts: number[] = [0, 0, 0];
    // мир 2D: угол dir в плоскости XY; на сцене — плоскость XZ (y мира = z сцены)
    for (let i = 0; i <= segs; i++) {
      const a = dir - half + (2 * half * i) / segs;
      verts.push(Math.cos(a), Math.sin(a), 0);
    }
    const idx: number[] = [];
    for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
    const g = m.geometry as THREE.BufferGeometry;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.setIndex(idx);
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    (m.material as THREE.MeshBasicMaterial).opacity = alpha;
    m.scale.set(rangePx / S, rangePx / S, 1);
    m.position.set(wx / S, 0.07, wz / S);
  }

  private shadow(wx: number, wz: number, rPx: number): void {
    this.flatCircle(wx, wz, rPx, rPx * 0.42, 0x000000, 0.42, 0.025);
  }

  // ---------- кадр ----------

  render(v: View3D, w: number, h: number): void {
    this.setSize(w, h);

    // камера следует за героем (изометрия Diablo 3)
    const cx = v.target.x / S, cz = v.target.y / S;
    const shx = (Math.random() - 0.5) * v.shake / S, shz = (Math.random() - 0.5) * v.shake / S;
    this.camPos.set(cx + 9.8 + shx, 12.4, cz + 9.8 + shz);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(cx + shx, 0, cz + shz);

    // карта на земле
    if (v.mapCanvas && this.groundMapId !== v.mapId + String(v.mapCanvas.width)) {
      if (this.ground) { this.scene.remove(this.ground); this.groundTex?.dispose(); }
      this.groundTex = new THREE.CanvasTexture(v.mapCanvas);
      this.groundTex.colorSpace = THREE.SRGBColorSpace;
      this.groundTex.anisotropy = 8;
      const mat = new THREE.MeshLambertMaterial({ map: this.groundTex });
      const world = v.mapCanvas.width / S;
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(world, world), mat);
      this.ground.rotation.x = -Math.PI / 2;
      this.ground.position.set(world / 2, 0, world / 2);
      this.scene.add(this.ground);
      this.groundMapId = v.mapId + String(v.mapCanvas.width);
    }

    // декали (кровь, следы)
    if (!v.skip("decals"))
      for (const d of v.decals) this.flatCircle(d.x, d.y, d.r, d.r * 0.6, 0x2a0808, Math.min(0.75, d.alpha));

    // телеграфы (метеориты, кольца боссов)
    for (const tg of v.telegraphs) {
      const prog = Math.max(0, Math.min(1, 1 - tg.t / tg.maxT));
      const col = tg.kind === "meteor" ? 0xff6a2c : 0xe83c3c;
      this.flatCircle(tg.x, tg.y, tg.r, tg.r, col, 0.22 + 0.1 * Math.sin(v.time * 10), 0.035);
      this.ring(tg.x, tg.y, tg.r, tg.kind === "meteor" ? 0xffb02e : 0xff5a3c, 0.85);
      this.ring(tg.x, tg.y, Math.max(4, tg.r * (1 - prog)), 0xffffff, 0.7);
    }

    // сферы здоровья, золото, лут
    for (const o of v.orbs) {
      const pulse = 1 + Math.sin(o.t * 6) * 0.15;
      this.glowSprite("#e83c3c", o.x, o.y, 13 * pulse, 0.32, 0.9);
    }
    for (const g of v.golds) {
      const pulse = 1 + Math.sin(v.time * 5 + g.x) * 0.15;
      this.glowSprite("#ffd24a", g.x, g.y, 9 * pulse, 0.28 + Math.sin(v.time * 3 + g.x) * 0.04, 0.95);
    }
    for (const l of v.loots) {
      this.glowSprite(v.lootColor(l.kind), l.x, l.y, 14, 0.34 + Math.sin(v.time * 3 + l.x) * 0.05, 0.95);
      this.ring(l.x, l.y, 16 + Math.sin(v.time * 4) * 2, 0xffffff, 0.35);
    }

    // трупы: риг падает навзничь в первые 0.35с, затем тает
    if (!v.skip("corpses"))
      for (const c of v.corpses) {
        const rig = this.humanRigFor(c, enemyOpts(c.sprite));
        rig.group.position.set(c.x / S, 0, c.y / S);
        rig.group.scale.setScalar(c.scale * 0.95);
        const dead01 = Math.min(1, (1.4 - c.life) / 0.35);
        rig.update({ walk: 0, moving: false, attackT: 0, castT: 0, dead01, mounted: false, time: v.time });
        rig.setOpacity(Math.min(1, c.life / 0.6) * 0.95);
        rig.setTint(0xffffff);
      }

    // враги
    for (const e of v.enemies) {
      const r = e.radius;
      const scale = (e.boss ? 2.1 : 1) * (e.kind.scaleMul ?? 1);
      const hh = r * 3.6 * scale;
      this.shadow(e.x, e.y + r * 0.9, r * 1.1 * scale);
      if (e.windup > 0) this.glowSprite("#ff3c28", e.x, e.y, r * 1.7, 0.4, 0.3 + 0.25 * Math.sin(v.time * 30));
      if (e.boss) this.glowSprite("#c8321e", e.x, e.y, hh * 0.9, 0.9, 0.5);
      let lx = 0, lz = 0;
      if (e.attackCd > 0.7) {
        const t = (e.attackCd - 0.7) / 0.3;
        const tgt = v.players[0];
        if (tgt) {
          const d = Math.hypot(tgt.x - e.x, tgt.y - e.y) || 1;
          lx = ((tgt.x - e.x) / d) * 12 * Math.sin(t * Math.PI);
          lz = ((tgt.y - e.y) / d) * 12 * Math.sin(t * Math.PI);
        }
      }
      const attackT = e.attackCd > 0.7 ? (e.attackCd - 0.7) / 0.3 : 0;
      const tint = e.charmT > 0 ? 0xa8ffd0 : e.burnT > 0 ? 0xffc8a0 : 0xffffff;
      const rig = this.humanRigFor(e, enemyOpts(e.sprite));
      rig.group.position.set((e.x + lx) / S, 0, (e.y + lz) / S);
      // рост модели пропорционален радиусу существа (база рига ~60px)
      rig.group.scale.setScalar(scale * Math.max(0.55, (r * 3.6) / 60));
      rig.group.rotation.y = Math.atan2(v.target.x - e.x, v.target.y - e.y);
      rig.update({ walk: e.anim * 7, moving: true, attackT, castT: 0, dead01: 0, mounted: false, time: v.time });
      rig.setOpacity(1);
      rig.setTint(tint);
      if (e.flash > 0) this.glowSprite("#ffffff", e.x + lx, e.y + lz, hh * 0.75, 0.8, 0.6 * Math.min(1, e.flash / 0.12));
      if (e.charmT > 0) this.ring(e.x, e.y + r * 0.9, r * 1.5 * scale, 0x3ddc84, 0.55 + Math.sin(v.time * 6) * 0.2);
    }

    // игроки (локальный и удалённые — единообразно)
    for (const p of v.players) {
      const heroId = p.hero.id;
      const alpha = p.alive ? 1 : 0.3;
      this.shadow(p.x, p.y + 20, 22);
      const flip = Math.cos(p.facing) < 0;
      const mounted = p.mountT > 0 && p.alive;
      const walk = p.moving && !mounted ? p.walkPhase * 11 : 0;
      const attackT = p.swingT > 0 ? 1 - Math.min(1, p.swingT / 0.18) : 0;
      if (mounted) {
        // маунт: светящаяся платформа в цвете героя
        this.flatCircle(p.x, p.y + 18, 52, 30, 0x1a1610, 0.55, 0.08);
        this.ring(p.x, p.y + 18, 50, 0xffc85a, 0.6, 0.1);
        this.glowSprite(p.hero.themeColor ?? "#8fb0ff", p.x, p.y, 52, 0.35, 0.55);
      }
      if (p.rageT > 0 && p.alive) {
        this.glowSprite("#ff3c1e", p.x, p.y, 95, 0.9, 0.5 + Math.sin(v.time * 10) * 0.15);
        this.ring(p.x, p.y, 60 + Math.sin(v.time * 8) * 6, 0xff5030, 0.5);
      }
      const scalePulse = (p.swingT > 0 ? 1 + p.swingT * 0.35 : 1) * (p.rageT > 0 ? 1.35 : 1);
      void flip;
      const rig = this.humanRigFor(p, heroOpts(heroId));
      rig.group.position.set(p.x / S, mounted ? 0.55 : 0, p.y / S);
      rig.group.scale.setScalar(1.25 * scalePulse);
      // поворот: по скорости при движении, иначе куда смотрит (к курсору)
      const dirA = p.moving && (p.vx !== 0 || p.vy !== 0) ? Math.atan2(p.vy, p.vx) : p.facing;
      rig.group.rotation.y = Math.atan2(Math.cos(dirA), Math.sin(dirA));
      rig.update({
        walk, moving: p.moving && !mounted, attackT, castT: 0,
        dead01: p.alive ? 0 : 1, mounted, time: v.time,
      });
      rig.setOpacity(alpha);
      rig.setTint(p.hurtFlash > 0 ? 0xff9090 : 0xffffff);
      if (p.shieldT > 0 && p.alive) {
        const a = 0.35 + Math.sin(v.time * 9) * 0.12;
        this.glowSprite("#b58cff", p.x, p.y, 52, 0.9, a);
        this.ring(p.x, p.y, 44, 0xd8c0ff, a + 0.25);
      }
    }

    // коты САТОРУ — четвероногие риги, смотрят на ближайшего врага
    for (const s2 of v.satorus) {
      this.shadow(s2.x, s2.y + 10, 16);
      const atkT = s2.swipeCd > 0.35 ? (s2.swipeCd - 0.35) / 0.2 : 0;
      const rig = this.catRigFor(s2);
      rig.group.position.set(s2.x / S, 0, s2.y / S);
      rig.group.scale.setScalar(1.9);
      let best: any = null, bd = 1e9;
      for (const e of v.enemies) {
        const d = (e.x - s2.x) * (e.x - s2.x) + (e.y - s2.y) * (e.y - s2.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) rig.group.rotation.y = Math.atan2(best.x - s2.x, best.y - s2.y);
      rig.update({ walk: v.time * 16, moving: true, attackT: atkT, castT: 0, dead01: 0, mounted: false, time: v.time });
      rig.setOpacity(1);
    }

    // клоны Максима — полупрозрачные ледяные риги
    for (const c of v.clones) {
      this.shadow(c.x, c.y + 20, 18);
      const rig = this.humanRigFor(c, heroOpts("maxim"));
      rig.group.position.set(c.x / S, 0, c.y / S);
      rig.group.scale.setScalar(1.2);
      let best: any = null, bd = 1e9;
      for (const e of v.enemies) {
        const d = (e.x - c.x) * (e.x - c.x) + (e.y - c.y) * (e.y - c.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) rig.group.rotation.y = Math.atan2(best.x - c.x, best.y - c.y);
      rig.update({ walk: c.walk * 11, moving: true, attackT: 0, castT: 0, dead01: 0, mounted: false, time: v.time });
      rig.setOpacity(0.65);
      rig.setTint(0x9fd8ff);
    }

    // огненные драконы
    for (const dr of v.dragons) {
      const flap = Math.sin(v.time * 14);
      this.glowSprite("#ff7828", dr.x, dr.y, 90, 1.1, 0.85);
      this.glowSprite("#ffe08a", dr.x + Math.cos(dr.ang) * 30, dr.y + Math.sin(dr.ang) * 30, 26, 1.15, 0.9);
      // шлейф пламени
      for (let k = 1; k <= 4; k++) {
        const bx = dr.x - Math.cos(dr.ang) * k * 26;
        const bz = dr.y - Math.sin(dr.ang) * k * 26;
        this.glowSprite("#ff8a3c", bx + Math.sin(v.time * 14 + k) * 6 * flap * 0.2, bz, 30 - k * 5, 1.0, 0.5 - k * 0.1);
      }
    }

    // снаряды
    if (!v.skip("projs"))
      for (const pr of v.projs) {
        this.glowSprite(pr.color, pr.x, pr.y, pr.r * 2.4, 0.75, 0.95);
      }

    // частицы
    if (!v.skip("particles")) {
      const pos = this.pointsGeo.getAttribute("position") as THREE.BufferAttribute;
      const colA = this.pointsGeo.getAttribute("color") as THREE.BufferAttribute;
      const n = Math.min(v.particles.length, this.MAX_PARTICLES);
      const col = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const pt = v.particles[i];
        const lifeK = Math.max(0, pt.life / pt.maxLife);
        pos.setXYZ(i, pt.x / S, 0.3 + ((i * 37) % 10) / 14, pt.y / S);
        col.set(pt.color).multiplyScalar(0.4 + 0.6 * lifeK);
        colA.setXYZ(i, col.r, col.g, col.b);
      }
      this.pointsGeo.setDrawRange(0, n);
      pos.needsUpdate = true; colA.needsUpdate = true;
    }

    // конусные вспышки
    for (const c of v.cones) {
      const a = Math.max(0, c.life / c.maxLife);
      const col = new THREE.Color(c.color).getHex();
      this.fan(c.x, c.y, c.dir, c.half, c.range * (1.15 - a * 0.15), col, a * 0.4);
    }

    // ударные волны
    for (const wv of v.waves) {
      const a = Math.max(0, wv.life / wv.maxLife);
      const col = new THREE.Color(wv.color).getHex();
      this.ring(wv.x, wv.y, wv.r, col, a * 0.55, 0.09);
      this.ring(wv.x, wv.y, Math.max(2, wv.r * 0.94), 0xffffff, a * 0.5, 0.1);
    }

    // точечные источники света (заклинания, взрывы)
    let li = 0;
    if (!v.skip("light")) {
      for (const tl of v.tempLights) {
        if (li >= this.lights.length) break;
        const l = this.lights[li++];
        l.color.setHex(0xffc890);
        l.intensity = 2.4 * Math.max(0, tl.life / tl.maxLife);
        l.distance = Math.max(2, (tl.r / S) * 1.6);
        l.position.set(tl.x / S, 1.4, tl.y / S);
      }
    }
    for (; li < this.lights.length; li++) this.lights[li].intensity = 0;

    this.endPools();
    this.renderer.render(this.scene, this.camera);
  }
}
