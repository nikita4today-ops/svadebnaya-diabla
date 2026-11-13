/**
 * characters3d.ts — объёмные персонажи «Свадебной Диаблы».
 * Параметрические low-poly модели с суставной иерархией (бёдра/колени/плечи/локти)
 * и процедурной анимацией: походка с переносом веса и сгибом коленей,
 * замах оружием, каст двумя руками, падение при смерти, посадка на маунте.
 * Внешность собирается из палитры и деталей (борода, хвост, платье, маски, клюшка…).
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
  robe?: boolean;       // платье/мантия вместо штанов (Вика, пожиратели, акацуки)
  robeColor?: number;
  mask?: number;        // маска на лице (пожиратели смерти)
  hatCone?: number;     // конусный колпак (гномики)
  shoulderPads?: number; // хоккейные наплечники
  weapon: "stick" | "wand" | "crossbow" | "claws" | "fists";
  weaponColor?: number;
  scaleMul?: number;
}

export interface RigState {
  walk: number;    // фаза шага, рад (растёт со скоростью движения)
  moving: boolean;
  attackT: number; // 0..1 — замах/удар правой рукой
  castT: number;   // 0..1 — каст двумя руками вперёд
  dead01: number;  // 0 — жив, 1 — лежит
  mounted: boolean;
  time: number;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const k = `b${w},${h},${d}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
function sph(r: number): THREE.BufferGeometry {
  const k = `s${r}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.SphereGeometry(r, 10, 8); geoCache.set(k, g); }
  return g;
}
function cone(r: number, h: number): THREE.BufferGeometry {
  const k = `c${r},${h}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.ConeGeometry(r, h, 10); geoCache.set(k, g); }
  return g;
}

interface Part { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial; base: THREE.Color }

function part(g: THREE.BufferGeometry, color: number, parent: THREE.Object3D, x = 0, y = 0, z = 0): Part {
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return { mesh, mat, base: new THREE.Color(color) };
}

/** Конечность: меш, сдвинутый так, чтобы верх (сустав) был в начале координат. */
function limb(w: number, h: number, d: number, color: number, parent: THREE.Object3D): Part {
  const p = part(box(w, h, d), color, parent);
  p.mesh.geometry = box(w, h, d);
  p.mesh.position.y = -h / 2;
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
  private baseHipY = 0.92;

  constructor(opts: HumanOpts) {
    this.opts = opts;
    const g = this.group;
    this.hips.position.y = this.baseHipY;
    g.add(this.hips);

    // таз
    this.parts.push(part(box(0.34, 0.2, 0.24), opts.pants, this.hips));

    // торс
    this.torsoG.position.y = 0.08;
    this.hips.add(this.torsoG);
    this.parts.push(part(box(0.42, 0.52, 0.28), opts.top, this.torsoG, 0, 0.32, 0));
    if (opts.shoulderPads !== undefined) {
      this.parts.push(part(box(0.62, 0.14, 0.34), opts.shoulderPads, this.torsoG, 0, 0.52, 0));
    }

    // голова
    this.headG.position.y = 0.62;
    this.torsoG.add(this.headG);
    this.parts.push(part(sph(0.17), opts.skin, this.headG, 0, 0.17, 0));
    // глаза
    this.parts.push(part(sph(0.022), 0x1a1a22, this.headG, -0.06, 0.19, 0.15));
    this.parts.push(part(sph(0.022), 0x1a1a22, this.headG, 0.06, 0.19, 0.15));
    // волосы
    if (opts.hairStyle === "short") this.parts.push(part(sph(0.175), opts.hair, this.headG, 0, 0.21, -0.03));
    else if (opts.hairStyle === "long") {
      this.parts.push(part(sph(0.175), opts.hair, this.headG, 0, 0.21, -0.03));
      this.parts.push(part(box(0.26, 0.5, 0.1), opts.hair, this.headG, 0, -0.05, -0.16));
    } else if (opts.hairStyle === "ponytail") {
      this.parts.push(part(sph(0.175), opts.hair, this.headG, 0, 0.21, -0.03));
      this.parts.push(part(box(0.09, 0.42, 0.09), opts.hair, this.headG, 0, 0.02, -0.2));
    } else if (opts.hairStyle === "hood") {
      this.parts.push(part(cone(0.24, 0.4), opts.hair, this.headG, 0, 0.28, -0.04));
    }
    if (opts.beard !== undefined) this.parts.push(part(box(0.2, 0.14, 0.08), opts.beard, this.headG, 0, 0.06, 0.13));
    if (opts.mask !== undefined) this.parts.push(part(box(0.2, 0.16, 0.06), opts.mask, this.headG, 0, 0.17, 0.14));
    if (opts.hatCone !== undefined) this.parts.push(part(cone(0.14, 0.34), opts.hatCone, this.headG, 0, 0.44, 0));

    // руки
    this.shoulderL.position.set(-0.26, 0.52, 0);
    this.shoulderR.position.set(0.26, 0.52, 0);
    this.torsoG.add(this.shoulderL, this.shoulderR);
    this.parts.push(limb(0.11, 0.34, 0.11, opts.sleeves, this.shoulderL));
    this.parts.push(limb(0.11, 0.34, 0.11, opts.sleeves, this.shoulderR));
    this.elbowL.position.y = -0.34;
    this.elbowR.position.y = -0.34;
    this.shoulderL.add(this.elbowL);
    this.shoulderR.add(this.elbowR);
    this.parts.push(limb(0.09, 0.3, 0.09, opts.sleeves, this.elbowL));
    this.parts.push(limb(0.09, 0.3, 0.09, opts.sleeves, this.elbowR));
    // кисти
    this.parts.push(part(sph(0.06), opts.skin, this.elbowL, 0, -0.32, 0));
    const handR = part(sph(0.06), opts.skin, this.elbowR, 0, -0.32, 0);
    this.parts.push(handR);

    // оружие в правой руке
    if (opts.weapon === "stick") {
      const wp = part(box(0.05, 1.15, 0.05), opts.weaponColor ?? 0x8a6a3a, this.elbowR, 0, -0.72, 0.14);
      wp.mesh.rotation.x = 0.5;
      this.parts.push(wp);
      const blade = part(box(0.05, 0.08, 0.3), opts.weaponColor ?? 0x8a6a3a, this.elbowR, 0, -1.24, 0.5);
      blade.mesh.rotation.x = 0.5;
      this.parts.push(blade);
    } else if (opts.weapon === "wand") {
      const wp = part(box(0.03, 0.42, 0.03), opts.weaponColor ?? 0x6a4a2a, this.elbowR, 0, -0.5, 0.06);
      wp.mesh.rotation.x = 0.9;
      this.parts.push(wp);
    } else if (opts.weapon === "crossbow") {
      const wp = part(box(0.06, 0.3, 0.06), opts.weaponColor ?? 0x3a3a42, this.elbowR, 0, -0.42, 0.1);
      wp.mesh.rotation.x = 1.2;
      this.parts.push(wp);
      const bow = part(box(0.34, 0.04, 0.04), opts.weaponColor ?? 0x3a3a42, this.elbowR, 0, -0.5, 0.16);
      this.parts.push(bow);
    } else if (opts.weapon === "claws") {
      for (let i = -1; i <= 1; i++) {
        const cl = part(box(0.02, 0.16, 0.02), opts.weaponColor ?? 0xd8d8e0, this.elbowR, i * 0.04, -0.42, 0.04);
        this.parts.push(cl);
      }
    }

    // ноги
    if (!opts.robe) {
      this.hipL.position.set(-0.11, -0.04, 0);
      this.hipR.position.set(0.11, -0.04, 0);
      this.hips.add(this.hipL, this.hipR);
      this.parts.push(limb(0.13, 0.44, 0.13, opts.pants, this.hipL));
      this.parts.push(limb(0.13, 0.44, 0.13, opts.pants, this.hipR));
      this.kneeL.position.y = -0.44;
      this.kneeR.position.y = -0.44;
      this.hipL.add(this.kneeL);
      this.hipR.add(this.kneeR);
      this.parts.push(limb(0.11, 0.42, 0.11, opts.pants, this.kneeL));
      this.parts.push(limb(0.11, 0.42, 0.11, opts.pants, this.kneeR));
      this.parts.push(part(box(0.12, 0.08, 0.22), opts.boots, this.kneeL, 0, -0.44, 0.05));
      this.parts.push(part(box(0.12, 0.08, 0.22), opts.boots, this.kneeR, 0, -0.44, 0.05));
    } else {
      // мантия/платье: колокол от талии до земли
      const robe = part(cone(0.42, 0.95), opts.robeColor ?? opts.top, this.hips, 0, -0.5, 0);
      this.parts.push(robe);
    }
    // масштаб задаётся рендером через group.scale (зависит от радиуса/босса)
  }

  /** Кадр анимации. face — поворот задаётся рендером через group.rotation.y. */
  update(st: RigState): void {
    const o = this.opts;
    const sw = Math.sin(st.walk);
    const sw2 = Math.sin(st.walk + Math.PI);
    const movingK = st.moving ? 1 : 0;

    // смерть: падение навзничь
    if (st.dead01 > 0) {
      this.group.rotation.x = -st.dead01 * Math.PI / 2;
      this.hips.position.y = this.baseHipY * (1 - st.dead01 * 0.82);
      return;
    }
    this.group.rotation.x = 0;

    // посадка на маунте: ноги согнуты вперёд, корпус ровно
    if (st.mounted) {
      this.hips.position.y = this.baseHipY - 0.18;
      this.hipL.rotation.x = -1.35; this.hipR.rotation.x = -1.35;
      this.kneeL.rotation.x = 1.35; this.kneeR.rotation.x = 1.35;
      this.shoulderL.rotation.x = -0.5; this.shoulderR.rotation.x = -0.5;
      this.elbowL.rotation.x = -0.5; this.elbowR.rotation.x = -0.5;
      return;
    }

    // походка: бёдра в противофазе, колени сгибаются на переносе,
    // корпус покачивается и чуть наклонён вперёд — шаг «с весом»
    this.hipL.rotation.x = sw * 0.62 * movingK;
    this.hipR.rotation.x = sw2 * 0.62 * movingK;
    this.kneeL.rotation.x = Math.max(0, -sw) * 0.9 * movingK;
    this.kneeR.rotation.x = Math.max(0, -sw2) * 0.9 * movingK;
    this.hips.position.y = this.baseHipY + Math.abs(Math.cos(st.walk)) * 0.055 * movingK;
    this.hips.rotation.z = sw * 0.05 * movingK;
    this.torsoG.rotation.x = 0.1 * movingK + Math.sin(st.time * 1.8) * 0.015;
    this.torsoG.rotation.y = sw * 0.08 * movingK;
    this.headG.rotation.y = -sw * 0.06 * movingK;

    // руки: мах в противофазе ногам; локоть чуть согнут
    const armSwing = o.robe ? 0.4 : 0.5;
    this.shoulderL.rotation.x = sw2 * armSwing * movingK;
    this.shoulderR.rotation.x = sw * armSwing * movingK;
    this.shoulderL.rotation.z = 0.12;
    this.shoulderR.rotation.z = -0.12;
    this.elbowL.rotation.x = -0.35 + Math.min(0, sw2) * 0.3 * movingK;
    this.elbowR.rotation.x = -0.35 + Math.min(0, sw) * 0.3 * movingK;

    // дыхание на месте
    if (!st.moving) {
      const br = Math.sin(st.time * 2.2) * 0.02;
      this.shoulderL.rotation.x = br;
      this.shoulderR.rotation.x = -br;
    }

    // удар правой рукой: подъём-замах и резкий опуск
    if (st.attackT > 0) {
      const t = st.attackT;
      const raise = t < 0.4 ? t / 0.4 : 1;
      const strike = t < 0.4 ? 0 : (t - 0.4) / 0.6;
      this.shoulderR.rotation.x = -raise * 2.1 + strike * 2.6;
      this.shoulderR.rotation.z = -0.25;
      this.elbowR.rotation.x = -0.6 - raise * 0.4 + strike * 0.9;
      this.torsoG.rotation.y = -raise * 0.35 + strike * 0.5;
    }
    // каст: обе руки вперёд
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
  /** Подсветка поверх базовой палитры (умножение): 0xffffff — без изменений. */
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
  private parts: Part[] = [];

  constructor() {
    const fur = 0x3a3a42, belly = 0x6a6a75;
    this.body.position.y = 0.34;
    this.group.add(this.body);
    this.parts.push(part(box(0.3, 0.26, 0.62), fur, this.body));
    this.parts.push(part(box(0.28, 0.1, 0.5), belly, this.body, 0, -0.12, 0));
    // голова
    const head = part(sph(0.17), fur, this.body, 0, 0.12, 0.38);
    this.parts.push(head);
    this.parts.push(part(sph(0.025), 0xffd24a, this.body, -0.06, 0.16, 0.52));
    this.parts.push(part(sph(0.025), 0xffd24a, this.body, 0.06, 0.16, 0.52));
    // уши
    this.parts.push(part(cone(0.06, 0.12), fur, this.body, -0.09, 0.28, 0.36));
    this.parts.push(part(cone(0.06, 0.12), fur, this.body, 0.09, 0.28, 0.36));
    // ноги
    const mkLeg = (x: number, z: number, grp: THREE.Group) => {
      grp.position.set(x, -0.1, z);
      this.body.add(grp);
      this.parts.push(limb(0.07, 0.26, 0.07, fur, grp));
    };
    mkLeg(-0.1, 0.22, this.legFL);
    mkLeg(0.1, 0.22, this.legFR);
    mkLeg(-0.1, -0.22, this.legBL);
    mkLeg(0.1, -0.22, this.legBR);
    // хвост
    this.tail.position.set(0, 0.08, -0.32);
    this.body.add(this.tail);
    const t1 = part(box(0.05, 0.05, 0.3), fur, this.tail, 0, 0, -0.14);
    this.parts.push(t1);
  }

  update(st: RigState): void {
    const sw = Math.sin(st.walk);
    this.legFL.rotation.x = sw * 0.7;
    this.legBR.rotation.x = sw * 0.7;
    this.legFR.rotation.x = -sw * 0.7;
    this.legBL.rotation.x = -sw * 0.7;
    this.body.position.y = 0.34 + Math.abs(Math.cos(st.walk)) * 0.03;
    this.tail.rotation.x = Math.sin(st.time * 3) * 0.3;
    this.tail.rotation.y = Math.sin(st.time * 2.2) * 0.4;
    if (st.attackT > 0) this.body.rotation.x = -st.attackT * 0.4;
    else this.body.rotation.x = 0;
  }

  setOpacity(a: number): void { for (const p of this.parts) p.mat.opacity = a; }
}
