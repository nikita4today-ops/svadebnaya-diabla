/**
 * characters3d.ts — объёмные персонажи «Свадебной Диаблы».
 * Сглаженные low-poly модели (капсулы, сферы, лофт-платья) с суставной
 * иерархией (бёдра/колени/плечи/локти) и процедурной анимацией:
 * походка с переносом веса, замах оружием, каст, падение, посадка на маунте.
 * Материалы — MeshStandardMaterial, чтобы свет и тени давали объём.
 */
import * as THREE from "three";

export interface HumanOpts {
  skin: number;
  hair: number;
  hairStyle: "short" | "ponytail" | "long" | "hood" | "bald";
  beard?: number;
  top: number;
  sleeves: number;
  pants: number;
  boots: number;
  robe?: boolean;
  robeColor?: number;
  mask?: number;
  hatCone?: number;
  shoulderPads?: number;
  weapon: "stick" | "wand" | "crossbow" | "claws" | "fists";
  weaponColor?: number;
  scaleMul?: number;
}

export interface RigState {
  walk: number;
  moving: boolean;
  attackT: number;
  castT: number;
  dead01: number;
  mounted: boolean;
  time: number;
  speed01?: number;
  lean?: number;
  roll?: number;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function capsule(r: number, len: number): THREE.BufferGeometry {
  const k = `cap${r},${len}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.CapsuleGeometry(r, len, 6, 14); geoCache.set(k, g); }
  return g;
}
function sph(r: number, w = 18, h = 14): THREE.BufferGeometry {
  const k = `s${r},${w}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.SphereGeometry(r, w, h); geoCache.set(k, g); }
  return g;
}
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const k = `b${w},${h},${d}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
function cyl(rTop: number, rBot: number, h: number, seg = 14): THREE.BufferGeometry {
  const k = `cy${rTop},${rBot},${h},${seg}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, h, seg); geoCache.set(k, g); }
  return g;
}
function cone(r: number, h: number): THREE.BufferGeometry {
  const k = `c${r},${h}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.ConeGeometry(r, h, 14); geoCache.set(k, g); }
  return g;
}
/** Плавный колокол платья/мантии через профиль вращения. */
function bell(rWaist: number, rHem: number, h: number): THREE.BufferGeometry {
  const k = `bell${rWaist},${rHem},${h}`;
  let g = geoCache.get(k);
  if (!g) {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const r = rWaist + (rHem - rWaist) * Math.pow(t, 1.6);
      pts.push(new THREE.Vector2(r, -t * h));
    }
    g = new THREE.LatheGeometry(pts, 18);
    geoCache.set(k, g);
  }
  return g;
}

interface Part { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; base: THREE.Color }

function part(g: THREE.BufferGeometry, color: number, parent: THREE.Object3D, x = 0, y = 0, z = 0, rough = 0.85): Part {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.04, transparent: true });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return { mesh, mat, base: new THREE.Color(color) };
}

/** Конечность-капсула: верх (сустав) в начале координат. */
function limb(r: number, len: number, color: number, parent: THREE.Object3D): Part {
  const p = part(capsule(r, len), color, parent);
  p.mesh.position.y = -(len / 2 + r * 0.5);
  return p;
}

export class HumanRig {
  group = new THREE.Group();
  private hips = new THREE.Group();
  private torsoG = new THREE.Group();
  private headG = new THREE.Group();
  private shoulderL = new THREE.Group();
  private shoulderR = new THREE.Group();
  private elbowL = new THREE.Group();
  private elbowR = new THREE.Group();
  private hipL = new THREE.Group();
  private hipR = new THREE.Group();
  private kneeL = new THREE.Group();
  private kneeR = new THREE.Group();
  private parts: Part[] = [];
  private opts: HumanOpts;
  private baseHipY = 0.95;

  constructor(opts: HumanOpts) {
    this.opts = opts;
    const g = this.group;
    this.hips.position.y = this.baseHipY;
    g.add(this.hips);

    // таз
    const pelvis = part(sph(0.17), opts.pants, this.hips);
    pelvis.mesh.scale.set(1.15, 0.72, 0.85);

    // торс: гладкая капсула — грудь и живот единым силуэтом
    this.torsoG.position.y = 0.1;
    this.hips.add(this.torsoG);
    const chest = part(capsule(0.17, 0.26), opts.top, this.torsoG, 0, 0.34, 0);
    chest.mesh.scale.set(1.18, 1, 0.82);
    if (opts.shoulderPads !== undefined) {
      // хоккейные наплечники — выпуклые полусферы
      for (const sx of [-1, 1]) {
        const pad = part(sph(0.13), opts.shoulderPads, this.torsoG, sx * 0.22, 0.56, 0);
        pad.mesh.scale.set(1.25, 0.62, 1.05);
      }
    }

    // голова
    this.headG.position.y = 0.64;
    this.torsoG.add(this.headG);
    part(sph(0.155, 22, 18), opts.skin, this.headG, 0, 0.16, 0, 0.65);
    // нос — маленький акцент лица
    part(sph(0.024, 8, 6), opts.skin, this.headG, 0, 0.145, 0.155, 0.65);
    // глаза и брови — выразительность без фотомасок
    part(sph(0.021, 8, 6), 0x181820, this.headG, -0.056, 0.175, 0.138, 0.4);
    part(sph(0.021, 8, 6), 0x181820, this.headG, 0.056, 0.175, 0.138, 0.4);
    if (opts.hairStyle !== "hood" && opts.hairStyle !== "bald" && opts.mask === undefined) {
      const browL = part(box(0.055, 0.012, 0.02), opts.hair, this.headG, -0.056, 0.215, 0.14);
      browL.mesh.rotation.z = 0.15;
      const browR = part(box(0.055, 0.012, 0.02), opts.hair, this.headG, 0.056, 0.215, 0.14);
      browR.mesh.rotation.z = -0.15;
    }

    // волосы: скульптурные формы под каждый стиль
    if (opts.hairStyle === "short") {
      const cap = part(sph(0.165, 20, 14), opts.hair, this.headG, 0, 0.185, -0.035);
      cap.mesh.scale.set(1, 0.82, 1);
    } else if (opts.hairStyle === "long") {
      const cap = part(sph(0.165, 20, 14), opts.hair, this.headG, 0, 0.185, -0.03);
      cap.mesh.scale.set(1, 0.85, 1);
      const sheet = part(sph(0.14), opts.hair, this.headG, 0, -0.08, -0.15);
      sheet.mesh.scale.set(1.05, 2.1, 0.55);
    } else if (opts.hairStyle === "ponytail") {
      const cap = part(sph(0.165, 20, 14), opts.hair, this.headG, 0, 0.185, -0.03);
      cap.mesh.scale.set(1, 0.85, 1);
      const t1 = part(sph(0.07), opts.hair, this.headG, 0, 0.16, -0.19);
      t1.mesh.scale.set(0.8, 1, 1.2);
      const t2 = part(sph(0.055), opts.hair, this.headG, 0, 0.02, -0.23);
      t2.mesh.scale.set(0.75, 1.4, 1);
      const t3 = part(sph(0.042), opts.hair, this.headG, 0, -0.14, -0.22);
      t3.mesh.scale.set(0.7, 1.3, 0.9);
    } else if (opts.hairStyle === "hood") {
      const hood = part(cone(0.21, 0.36), opts.hair, this.headG, 0, 0.28, -0.03);
      hood.mesh.scale.set(1.05, 1, 1.15);
    }
    if (opts.beard !== undefined) {
      const beard = part(sph(0.1, 14, 10), opts.beard, this.headG, 0, 0.075, 0.105);
      beard.mesh.scale.set(1.05, 0.72, 0.72);
    }
    if (opts.mask !== undefined) {
      const m = part(sph(0.12, 16, 12), opts.mask, this.headG, 0, 0.15, 0.085, 0.35);
      m.mesh.scale.set(0.95, 1.05, 0.62);
      part(sph(0.02, 8, 6), 0x0a0a0e, this.headG, -0.05, 0.17, 0.155, 0.3);
      part(sph(0.02, 8, 6), 0x0a0a0e, this.headG, 0.05, 0.17, 0.155, 0.3);
    }
    if (opts.hatCone !== undefined) {
      const hat = part(cone(0.13, 0.36), opts.hatCone, this.headG, 0, 0.42, 0);
      hat.mesh.rotation.x = 0.12;
      part(sph(0.035, 10, 8), 0xf0ead8, this.headG, 0, 0.6, -0.04);
    }

    // руки
    this.shoulderL.position.set(-0.245, 0.52, 0);
    this.shoulderR.position.set(0.245, 0.52, 0);
    this.torsoG.add(this.shoulderL, this.shoulderR);
    this.parts.push(limb(0.062, 0.24, opts.sleeves, this.shoulderL));
    this.parts.push(limb(0.062, 0.24, opts.sleeves, this.shoulderR));
    this.elbowL.position.y = -0.34;
    this.elbowR.position.y = -0.34;
    this.shoulderL.add(this.elbowL);
    this.shoulderR.add(this.elbowR);
    this.parts.push(limb(0.052, 0.22, opts.sleeves, this.elbowL));
    this.parts.push(limb(0.052, 0.22, opts.sleeves, this.elbowR));
    // кисти
    part(sph(0.062, 12, 10), opts.skin, this.elbowL, 0, -0.32, 0, 0.65);
    part(sph(0.062, 12, 10), opts.skin, this.elbowR, 0, -0.32, 0, 0.65);

    // оружие в правой руке
    if (opts.weapon === "stick") {
      // хоккейная клюшка: круглый шафт + изогнутый крюк
      const shaft = part(cyl(0.02, 0.02, 1.12), opts.weaponColor ?? 0x8a6a3a, this.elbowR, 0, -0.7, 0.12, 0.55);
      shaft.mesh.rotation.x = 0.5;
      const blade = part(box(0.035, 0.07, 0.3), opts.weaponColor ?? 0x8a6a3a, this.elbowR, 0, -1.21, 0.5, 0.55);
      blade.mesh.rotation.x = 0.45;
      this.parts.push(blade);
    } else if (opts.weapon === "wand") {
      const w = part(cyl(0.013, 0.017, 0.42), opts.weaponColor ?? 0x6a4a2a, this.elbowR, 0, -0.44, 0.08, 0.5);
      w.mesh.rotation.x = 0.9;
      // светящийся наконечник
      const tip = new THREE.Mesh(sph(0.028, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff2c8 }));
      tip.position.set(0, -0.6, 0.26);
      this.elbowR.add(tip);
    } else if (opts.weapon === "crossbow") {
      const stock = part(box(0.05, 0.34, 0.07), opts.weaponColor ?? 0x3a3a42, this.elbowR, 0, -0.4, 0.1, 0.5);
      stock.mesh.rotation.x = 1.25;
      this.parts.push(stock);
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 8, 14, Math.PI), new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.4, metalness: 0.4 }));
      bow.position.set(0, -0.52, 0.22);
      bow.rotation.x = Math.PI / 2;
      bow.castShadow = true;
      this.elbowR.add(bow);
    } else if (opts.weapon === "claws") {
      for (let i = -1; i <= 1; i++) {
        const cl = part(cone(0.018, 0.17), opts.weaponColor ?? 0xd8d8e0, this.elbowR, i * 0.045, -0.4, 0.03, 0.3);
        cl.mesh.rotation.x = -0.5;
        this.parts.push(cl);
      }
    }

    // ноги
    if (!opts.robe) {
      this.hipL.position.set(-0.105, -0.06, 0);
      this.hipR.position.set(0.105, -0.06, 0);
      this.hips.add(this.hipL, this.hipR);
      this.parts.push(limb(0.075, 0.34, opts.pants, this.hipL));
      this.parts.push(limb(0.075, 0.34, opts.pants, this.hipR));
      this.kneeL.position.y = -0.46;
      this.kneeR.position.y = -0.46;
      this.hipL.add(this.kneeL);
      this.hipR.add(this.kneeR);
      this.parts.push(limb(0.062, 0.32, opts.pants, this.kneeL));
      this.parts.push(limb(0.062, 0.32, opts.pants, this.kneeR));
      // ботинки: скруглённая форма с носком
      for (const kn of [this.kneeL, this.kneeR]) {
        const boot = part(sph(0.075, 12, 10), opts.boots, kn, 0, -0.46, 0.04);
        boot.mesh.scale.set(0.95, 0.62, 1.55);
      }
    } else {
      // платье/мантия: плавный колокол от талии до земли
      const robe = part(bell(0.2, 0.44, 0.98), opts.robeColor ?? opts.top, this.hips, 0, -0.02, 0);
      this.parts.push(robe);
    }

    if (opts.scaleMul) this.group.scale.setScalar(opts.scaleMul);
  }

  /** Кадр анимации. face — поворот задаётся рендером через group.rotation.y. */
  update(st: RigState): void {
    const o = this.opts;
    const sw = Math.sin(st.walk);
    const sw2 = Math.sin(st.walk + Math.PI);
    const movingK = st.moving ? 1 : 0;
    const amp = 0.55 + 0.45 * Math.min(1, st.speed01 ?? 1);

    if (st.dead01 > 0) {
      this.group.rotation.x = -st.dead01 * Math.PI / 2;
      this.hips.position.y = this.baseHipY * (1 - st.dead01 * 0.82);
      return;
    }
    this.group.rotation.x = 0;

    if (st.mounted) {
      this.hips.rotation.x = 0;
      this.hips.rotation.z = 0;
      this.hips.position.y = this.baseHipY - 0.18;
      this.hipL.rotation.x = -1.35; this.hipR.rotation.x = -1.35;
      this.kneeL.rotation.x = 1.35; this.kneeR.rotation.x = 1.35;
      this.shoulderL.rotation.x = -0.5; this.shoulderR.rotation.x = -0.5;
      this.elbowL.rotation.x = -0.5; this.elbowR.rotation.x = -0.5;
      return;
    }

    this.hipL.rotation.x = sw * 0.62 * amp * movingK;
    this.hipR.rotation.x = sw2 * 0.62 * amp * movingK;
    this.kneeL.rotation.x = Math.max(0, -sw) * 0.9 * amp * movingK;
    this.kneeR.rotation.x = Math.max(0, -sw2) * 0.9 * amp * movingK;
    this.hips.position.y = this.baseHipY + Math.abs(Math.cos(st.walk)) * 0.055 * amp * movingK;
    this.hips.rotation.x = 0.1 * movingK * Math.min(1, st.speed01 ?? 1) + (st.lean ?? 0);
    this.hips.rotation.z = sw * 0.05 * movingK + (st.roll ?? 0);
    this.torsoG.rotation.x = 0.1 * movingK + Math.sin(st.time * 1.8) * 0.015;
    this.torsoG.rotation.y = sw * 0.08 * movingK;
    this.headG.rotation.y = -sw * 0.06 * movingK;

    const armSwing = o.robe ? 0.4 : 0.5;
    this.shoulderL.rotation.x = sw2 * armSwing * amp * movingK;
    this.shoulderR.rotation.x = sw * armSwing * amp * movingK;
    this.shoulderL.rotation.z = 0.1;
    this.shoulderR.rotation.z = -0.1;
    this.elbowL.rotation.x = -0.35 + Math.min(0, sw2) * 0.3 * movingK;
    this.elbowR.rotation.x = -0.35 + Math.min(0, sw) * 0.3 * movingK;

    if (!st.moving) {
      const br = Math.sin(st.time * 2.2) * 0.02;
      this.shoulderL.rotation.x = br;
      this.shoulderR.rotation.x = -br;
    }

    if (st.attackT > 0) {
      const t = st.attackT;
      const raise = t < 0.4 ? t / 0.4 : 1;
      const strike = t < 0.4 ? 0 : (t - 0.4) / 0.6;
      this.shoulderR.rotation.x = -raise * 2.1 + strike * 2.6;
      this.shoulderR.rotation.z = -0.25;
      this.elbowR.rotation.x = -0.6 - raise * 0.4 + strike * 0.9;
      this.torsoG.rotation.y = -raise * 0.35 + strike * 0.5;
    }
    if (st.castT > 0) {
      this.shoulderL.rotation.x = -1.5;
      this.shoulderR.rotation.x = -1.5;
      this.elbowL.rotation.x = -0.15;
      this.elbowR.rotation.x = -0.15;
    }
  }

  setOpacity(a: number): void {
    for (const p of this.parts) p.mat.opacity = a;
  }
  private tintC = new THREE.Color();
  setTint(hex: number): void {
    this.tintC.setHex(hex);
    for (const p of this.parts) p.mat.color.copy(p.base).multiply(this.tintC);
  }
}

// ---------- внешность героев и врагов ----------

export function heroOpts(id: string): HumanOpts {
  switch (id) {
    case "nikita":
      return {
        skin: 0xe8b88a, hair: 0x3a2a1a, hairStyle: "short", beard: 0x2e2014,
        top: 0xe8e8e8, sleeves: 0xc8352a, pants: 0x1e2a4a, boots: 0x2a2a30,
        shoulderPads: 0xc8352a, weapon: "stick", weaponColor: 0x9a7a4a,
      };
    case "maxim":
      return {
        skin: 0xe8b88a, hair: 0x2a2018, hairStyle: "short",
        top: 0xe8e2d2, sleeves: 0x3a3230, pants: 0x2a2622, boots: 0x3a2e22,
        weapon: "fists",
      };
    case "dasha":
      return {
        skin: 0xf0c49a, hair: 0x6a4a22, hairStyle: "ponytail",
        top: 0x1e1a22, sleeves: 0x1e1a22, pants: 0x16141c, boots: 0x241e18,
        weapon: "crossbow", weaponColor: 0x4a3a2a,
      };
    case "vika":
      return {
        skin: 0xf0c8a8, hair: 0xd8c490, hairStyle: "long",
        top: 0xf0ead8, sleeves: 0xf0ead8, pants: 0xf0ead8, boots: 0xd8cbaa,
        robe: true, robeColor: 0xf4eee0, weapon: "wand", weaponColor: 0x7a5a3a,
      };
    default:
      return heroOpts("maxim");
  }
}

export function enemyOpts(sprite: string): HumanOpts & { cat?: boolean } {
  if (sprite.startsWith("enemy-hockey")) {
    const pal = sprite.includes("metallurg")
      ? { top: 0x24448f, acc: 0xd33a2c }
      : sprite.includes("akbars")
        ? { top: 0x1e7a4a, acc: 0xe8e8e8 }
        : { top: 0xb3202c, acc: 0xe8e8e8 };
    return {
      skin: 0xd8a87a, hair: 0x2a2018, hairStyle: "short",
      top: pal.top, sleeves: pal.acc, pants: 0x22262e, boots: 0x2a2a30,
      shoulderPads: pal.acc, weapon: "stick", weaponColor: 0x9a7a4a,
    };
  }
  if (sprite.startsWith("enemy-akatsuki")) {
    return {
      skin: 0xc8b898, hair: 0x151518, hairStyle: "hood",
      top: 0x151518, sleeves: 0x151518, pants: 0x101014, boots: 0x1a1a20,
      robe: true, robeColor: 0x1a1a22, weapon: "claws", weaponColor: 0xd8d8e0,
    };
  }
  if (sprite.startsWith("enemy-gnome")) {
    const brute = sprite.includes("brute");
    return {
      skin: 0x7ab54a, hair: 0x8a6d3b, hairStyle: "bald", hatCone: brute ? 0x8a6d3b : 0xc0392b,
      top: 0x3f7a3a, sleeves: 0x356830, pants: 0x2c5c28, boots: 0x3a2e1a,
      weapon: "claws", weaponColor: 0xc8c8d0, scaleMul: brute ? 0.85 : 0.62,
    };
  }
  if (sprite.startsWith("enemy-deatheater")) {
    const mage = sprite.includes("mage");
    return {
      skin: 0xd8d8e0, hair: 0x0e1014, hairStyle: "hood", mask: 0xe8e8e8,
      top: 0x191b22, sleeves: 0x14161c, pants: 0x101218, boots: 0x14161c,
      robe: true, robeColor: 0x14161c, weapon: "wand", weaponColor: mage ? 0x3ddc84 : 0x6a5a3a,
    };
  }
  return heroOpts("maxim");
}

/** Кот САТОРУ — четвероногий. */
export class CatRig {
  group = new THREE.Group();
  private body = new THREE.Group();
  private legFL = new THREE.Group();
  private legFR = new THREE.Group();
  private legBL = new THREE.Group();
  private legBR = new THREE.Group();
  private tail = new THREE.Group();
  private tail2 = new THREE.Group();
  private parts: Part[] = [];

  constructor() {
    const fur = 0x3a3a42, belly = 0x6a6a75;
    this.body.position.y = 0.34;
    this.group.add(this.body);
    const torso = part(capsule(0.16, 0.32), fur, this.body, 0, 0, 0, 0.9);
    torso.mesh.rotation.x = Math.PI / 2;
    this.parts.push(torso);
    const bl = part(sph(0.13, 14, 10), belly, this.body, 0, -0.09, 0.02, 0.9);
    bl.mesh.scale.set(0.95, 0.6, 1.5);
    this.parts.push(bl);
    // голова
    this.parts.push(part(sph(0.15, 16, 12), fur, this.body, 0, 0.12, 0.36, 0.9));
    part(sph(0.028, 8, 6), 0xffd24a, this.body, -0.055, 0.15, 0.49, 0.3);
    part(sph(0.028, 8, 6), 0xffd24a, this.body, 0.055, 0.15, 0.49, 0.3);
    // зрачки
    part(sph(0.012, 6, 5), 0x101014, this.body, -0.055, 0.15, 0.515, 0.3);
    part(sph(0.012, 6, 5), 0x101014, this.body, 0.055, 0.15, 0.515, 0.3);
    // нос и уши
    part(sph(0.018, 8, 6), 0xd88a8a, this.body, 0, 0.1, 0.5, 0.6);
    const earL = part(cone(0.055, 0.11), fur, this.body, -0.085, 0.27, 0.33);
    earL.mesh.rotation.z = 0.2;
    this.parts.push(earL);
    const earR = part(cone(0.055, 0.11), fur, this.body, 0.085, 0.27, 0.33);
    earR.mesh.rotation.z = -0.2;
    this.parts.push(earR);
    // ноги
    const mkLeg = (x: number, z: number, grp: THREE.Group) => {
      grp.position.set(x, -0.1, z);
      this.body.add(grp);
      this.parts.push(limb(0.042, 0.2, fur, grp));
    };
    mkLeg(-0.09, 0.2, this.legFL);
    mkLeg(0.09, 0.2, this.legFR);
    mkLeg(-0.09, -0.2, this.legBL);
    mkLeg(0.09, -0.2, this.legBR);
    // хвост: два сегмента
    this.tail.position.set(0, 0.06, -0.32);
    this.body.add(this.tail);
    const t1 = part(capsule(0.03, 0.16), fur, this.tail, 0, 0, -0.08, 0.9);
    t1.mesh.rotation.x = Math.PI / 2;
    this.parts.push(t1);
    this.tail2.position.set(0, 0, -0.17);
    this.tail.add(this.tail2);
    const t2 = part(capsule(0.024, 0.14), fur, this.tail2, 0, 0.03, -0.06, 0.9);
    t2.mesh.rotation.x = Math.PI / 2 - 0.5;
    this.parts.push(t2);
  }

  update(st: RigState): void {
    const sw = Math.sin(st.walk);
    this.legFL.rotation.x = sw * 0.7;
    this.legBR.rotation.x = sw * 0.7;
    this.legFR.rotation.x = -sw * 0.7;
    this.legBL.rotation.x = -sw * 0.7;
    this.body.position.y = 0.34 + Math.abs(Math.cos(st.walk)) * 0.03;
    this.tail.rotation.x = Math.sin(st.time * 3) * 0.25;
    this.tail.rotation.y = Math.sin(st.time * 2.2) * 0.35;
    this.tail2.rotation.x = 0.4 + Math.sin(st.time * 3.4) * 0.3;
    if (st.attackT > 0) this.body.rotation.x = -st.attackT * 0.4;
    else this.body.rotation.x = 0;
  }

  setOpacity(a: number): void { for (const p of this.parts) p.mat.opacity = a; }
}

// ---------- маунты героев ----------

export type MountKind = "zamboni" | "frog" | "batmobile" | "hippogriff";

/** Маунт под героем: замбони (Никита), жаба (Максим), бэтмобиль (Даша), гиппогриф (Вика). */
export class MountRig {
  group = new THREE.Group();
  readonly seatY: number;
  private wingL: THREE.Group | null = null;
  private wingR: THREE.Group | null = null;
  private bodyG = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private hopBaseY = 0;

  constructor(kind: MountKind) {
    this.group.add(this.bodyG);
    const add = (g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rough = 0.7): THREE.Mesh => {
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.08 }));
      m.position.set(x, y, z);
      m.castShadow = true;
      this.bodyG.add(m);
      return m;
    };
    const wheel = (x: number, z: number, r: number): void => {
      const geo = new THREE.CylinderGeometry(r, r, 0.14, 14);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.9 }));
      m.rotation.z = Math.PI / 2;
      m.position.set(x, r, z);
      m.castShadow = true;
      this.bodyG.add(m);
      this.wheels.push(m);
    };

    if (kind === "zamboni") {
      this.seatY = 1.05;
      add(box(1.15, 0.5, 2.0), 0x2a5a9a, 0, 0.55, 0, 0.5);
      add(box(0.85, 0.5, 0.75), 0x3a7ac0, 0, 1.05, -0.35, 0.45);
      add(box(0.65, 0.3, 0.06), 0xbfe4ff, 0, 1.08, 0.04, 0.2);
      add(cyl(0.32, 0.32, 0.66), 0xd8d8de, 0, 1.02, -1.0, 0.4).rotation.x = Math.PI / 2;
      add(box(1.2, 0.16, 0.3), 0x8a8a92, 0, 0.28, -1.15, 0.6);
      add(box(0.3, 0.1, 0.08), 0xffd24a, -0.35, 0.6, 1.02, 0.3);
      add(box(0.3, 0.1, 0.08), 0xffd24a, 0.35, 0.6, 1.02, 0.3);
      wheel(-0.55, 0.65, 0.26); wheel(0.55, 0.65, 0.26);
      wheel(-0.55, -0.65, 0.26); wheel(0.55, -0.65, 0.26);
    } else if (kind === "frog") {
      this.seatY = 0.72;
      this.hopBaseY = 0;
      const body = add(sph(0.62, 20, 16), 0x5a8a3a, 0, 0.45, 0, 0.95);
      body.scale.set(1.1, 0.62, 1.25);
      const belly = add(sph(0.5, 18, 14), 0x7ab54a, 0, 0.32, 0.1, 0.95);
      belly.scale.set(0.95, 0.45, 1.05);
      for (const sx of [-1, 1]) {
        add(cyl(0.04, 0.05, 0.2), 0x5a8a3a, sx * 0.28, 0.82, 0.3, 0.9);
        add(sph(0.13, 14, 10), 0xf0f0e8, sx * 0.28, 0.95, 0.3, 0.5);
        add(sph(0.055, 10, 8), 0x14141a, sx * 0.28, 0.97, 0.41, 0.3);
        const leg = add(capsule(0.11, 0.3), 0x4a7a30, sx * 0.55, 0.28, -0.35, 0.95);
        leg.rotation.x = 1.1;
      }
    } else if (kind === "batmobile") {
      this.seatY = 0.72;
      add(box(0.95, 0.3, 2.2), 0x14141a, 0, 0.38, 0, 0.35);
      const nose = add(box(0.7, 0.2, 0.7), 0x1a1a22, 0, 0.42, 1.25, 0.3);
      nose.rotation.x = -0.15;
      add(sph(0.3, 14, 10), 0x22222c, 0, 0.6, -0.25, 0.25).scale.set(0.95, 0.55, 1.4);
      add(box(0.1, 0.55, 0.5), 0x1a1a22, -0.28, 0.75, -0.95, 0.35);
      add(box(0.1, 0.55, 0.5), 0x1a1a22, 0.28, 0.75, -0.95, 0.35);
      add(box(0.22, 0.09, 0.06), 0xffd24a, -0.25, 0.42, 1.6, 0.2);
      add(box(0.22, 0.09, 0.06), 0xffd24a, 0.25, 0.42, 1.6, 0.2);
      wheel(-0.5, 0.75, 0.26); wheel(0.5, 0.75, 0.26);
      wheel(-0.5, -0.75, 0.3); wheel(0.5, -0.75, 0.3);
    } else {
      this.seatY = 1.12;
      const body = add(sph(0.62, 20, 16), 0x8a7a5a, 0, 0.85, -0.1, 0.9);
      body.scale.set(0.95, 0.78, 1.4);
      add(sph(0.22, 16, 12), 0xc9b18a, 0, 1.25, 0.62, 0.85);
      const beak = add(cone(0.09, 0.3), 0xe8c84a, 0, 1.2, 0.85, 0.5);
      beak.rotation.x = Math.PI / 2;
      add(sph(0.035, 8, 6), 0x14141a, -0.09, 1.3, 0.72, 0.3);
      add(sph(0.035, 8, 6), 0x14141a, 0.09, 1.3, 0.72, 0.3);
      for (const sx of [-1, 1]) {
        const w = new THREE.Group();
        w.position.set(sx * 0.32, 1.08, -0.15);
        this.bodyG.add(w);
        const panel = new THREE.Mesh(box(0.7, 0.05, 0.5), new THREE.MeshStandardMaterial({ color: 0xc9b18a, roughness: 0.85 }));
        panel.position.set(sx * 0.38, 0, -0.05);
        panel.rotation.y = sx * 0.35;
        panel.castShadow = true;
        w.add(panel);
        const tip = new THREE.Mesh(box(0.4, 0.04, 0.34), new THREE.MeshStandardMaterial({ color: 0xa8946a, roughness: 0.85 }));
        tip.position.set(sx * 0.8, 0, -0.22);
        tip.rotation.y = sx * 0.6;
        tip.castShadow = true;
        w.add(tip);
        if (sx < 0) this.wingL = w; else this.wingR = w;
      }
      const tail = add(cone(0.14, 0.6), 0x6a5c42, 0, 0.85, -1.0, 0.9);
      tail.rotation.x = -Math.PI / 2 - 0.3;
      for (const sx of [-0.25, 0.25]) for (const sz of [0.45, -0.55]) {
        add(capsule(0.06, 0.4), 0x6a5c42, sx, 0.3, sz, 0.9);
      }
    }
  }

  /** Анимация: крылья гиппогрифа, колёса машин, подскок жабы. */
  update(time: number, moving: boolean): void {
    if (this.wingL && this.wingR) {
      const flap = Math.sin(time * 9) * (moving ? 0.55 : 0.25);
      this.wingL.rotation.z = 0.15 + flap;
      this.wingR.rotation.z = -0.15 - flap;
      this.bodyG.position.y = Math.abs(Math.sin(time * 4.5)) * (moving ? 0.1 : 0.04);
    } else if (this.wheels.length > 0) {
      if (moving) for (const w of this.wheels) w.rotation.x += 0.35;
    } else {
      this.bodyG.position.y = this.hopBaseY + (moving ? Math.abs(Math.sin(time * 7)) * 0.22 : Math.sin(time * 2) * 0.03 + 0.03);
    }
  }
}
