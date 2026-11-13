/**
 * environment3d.ts — объёмные локации «Свадебной Диаблы».
 * Для каждой карты строится статичный набор геометрии поверх текстуры земли:
 * борта и трибуны арены, колонны и парящие свечи Хогвартса,
 * парты и доска школы, дома и фонари Одинцово.
 * Возвращает группу и функцию покадровой анимации (свечи, табло, фонари).
 */
import * as THREE from "three";

export interface Environment {
  group: THREE.Group;
  update: (time: number) => void;
  /** Шероховатость земли (лёд блестит, камень — нет). */
  groundRoughness: number;
}

const WORLD_U = 2600 / 40; // 65 единиц сцены
const C = WORLD_U / 2;

function std(color: number, rough = 0.85, metal = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}
function glowMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color });
}
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, shadow = true): THREE.Mesh {
  const mm = new THREE.Mesh(g, m);
  mm.position.set(x, y, z);
  if (shadow) mm.castShadow = true;
  parent.add(mm);
  return mm;
}

// ---------- АРЕНА (Омск) ----------
function buildArena(): Environment {
  const g = new THREE.Group();
  const animated: ((t: number) => void)[] = [];

  // борта: белые панели с жёлтым кик-плейтом и синей полосой, стёкла сверху
  const boardM = std(0xf2f4f6, 0.6);
  const kickM = std(0xd8a820, 0.7);
  const stripeM = std(0x24448f, 0.6);
  const glassM = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.16 });
  const mkBoard = (x: number, z: number, len: number, rotY: number) => {
    const b = new THREE.Group();
    b.position.set(x, 0, z);
    b.rotation.y = rotY;
    mesh(new THREE.BoxGeometry(len, 1.05, 0.28), boardM, 0, 0.62, 0, b);
    mesh(new THREE.BoxGeometry(len, 0.2, 0.3), kickM, 0, 0.1, 0, b);
    mesh(new THREE.BoxGeometry(len, 0.09, 0.3), stripeM, 0, 1.18, 0, b);
    mesh(new THREE.BoxGeometry(len, 1.5, 0.06), glassM, 0, 1.95, 0, b, false);
    g.add(b);
  };
  const m3 = 1.2; // отступ от края льда
  mkBoard(C, m3, WORLD_U - 2 * m3, 0);
  mkBoard(C, WORLD_U - m3, WORLD_U - 2 * m3, 0);
  mkBoard(m3, C, WORLD_U - 2 * m3, Math.PI / 2);
  mkBoard(WORLD_U - m3, C, WORLD_U - 2 * m3, Math.PI / 2);

  // ворота на двух концах площадки (красная рамка + сетка)
  const netM = new THREE.MeshStandardMaterial({ color: 0xe8f0f8, roughness: 0.9, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  for (const sz of [3.4, WORLD_U - 3.4]) {
    const goal = new THREE.Group();
    goal.position.set(C, 0, sz);
    const frameM = std(0xd8232a, 0.5);
    mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.15, 10), frameM, -0.9, 0.57, 0, goal);
    mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.15, 10), frameM, 0.9, 0.57, 0, goal);
    mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 10), frameM, 0, 1.12, 0, goal).rotation.z = Math.PI / 2;
    const back = sz < C ? -1 : 1;
    mesh(new THREE.BoxGeometry(1.9, 1.1, 0.05), netM, 0, 0.55, back * 0.75, goal, false);
    mesh(new THREE.BoxGeometry(0.05, 1.1, 0.8), netM, -0.9, 0.55, back * 0.38, goal, false);
    mesh(new THREE.BoxGeometry(0.05, 1.1, 0.8), netM, 0.9, 0.55, back * 0.38, goal, false);
    mesh(new THREE.BoxGeometry(1.9, 0.05, 0.8), netM, 0, 1.1, back * 0.38, goal, false);
    g.add(goal);
  }

  // трибуны: ярусы тёмных секций по периметру с пёстрым «населением»
  const standM = std(0x141c2c, 0.95);
  const crowdColors = [0xc8ccd4, 0x8f2c34, 0x2c4a8f, 0x3a3f4a, 0xd8cba0, 0x4a7a5a];
  for (let tier = 0; tier < 3; tier++) {
    const inset = 0.4 - tier * 0.9;
    const y = 2.6 + tier * 1.1;
    const h = 1.1;
    mesh(new THREE.BoxGeometry(WORLD_U - inset * 2, h, 1.6), standM, C, y, inset - 0.4, g);
    mesh(new THREE.BoxGeometry(WORLD_U - inset * 2, h, 1.6), standM, C, y, WORLD_U - inset + 0.4, g);
    mesh(new THREE.BoxGeometry(1.6, h, WORLD_U - inset * 2), standM, inset - 0.4, y, C, g);
    mesh(new THREE.BoxGeometry(1.6, h, WORLD_U - inset * 2), standM, WORLD_U - inset + 0.4, y, C, g);
  }
  // зрители: инстансированные точки на ярусах
  const crowdGeo = new THREE.BoxGeometry(0.22, 0.34, 0.22);
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const N = 900;
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, N);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let ci = 0;
  const rnd = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  while (ci < N) {
    const side = ci % 4;
    const tier = Math.floor(rnd() * 3);
    const along = 2 + rnd() * (WORLD_U - 4);
    const inset = 0.4 - tier * 0.9 - 0.4;
    const y = 3.25 + tier * 1.1;
    if (side === 0) dummy.position.set(along, y, inset);
    else if (side === 1) dummy.position.set(along, y, WORLD_U - inset);
    else if (side === 2) dummy.position.set(inset, y, along);
    else dummy.position.set(WORLD_U - inset, y, along);
    dummy.rotation.y = rnd() * Math.PI;
    dummy.updateMatrix();
    crowd.setMatrixAt(ci, dummy.matrix);
    col.setHex(crowdColors[Math.floor(rnd() * crowdColors.length)]);
    crowd.setColorAt(ci, col);
    ci++;
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  g.add(crowd);

  // табло над центром площадки (высоко, тень не мешает игре)
  const board = new THREE.Group();
  board.position.set(C, 10.5, C);
  mesh(new THREE.BoxGeometry(3.6, 1.7, 3.6), std(0x10141c, 0.5), 0, 0, 0, board, false);
  const scrM = glowMat(0x28e0ff);
  const screens: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const s = mesh(new THREE.PlaneGeometry(2.8, 1.1), scrM, 0, 0, 0, board, false);
    s.position.set(Math.sin((i * Math.PI) / 2) * 1.82, 0, Math.cos((i * Math.PI) / 2) * 1.82);
    s.rotation.y = (i * Math.PI) / 2;
    screens.push(s);
  }
  mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 8), std(0x3a3f4a, 0.6), 0, 3.3, 0, board, false);
  g.add(board);
  animated.push((t) => {
    const k = 0.75 + Math.sin(t * 2.4) * 0.25;
    scrM.color.setRGB(0.16 * k, 0.88 * k, 1.0 * k);
  });

  return { group: g, update: (t) => animated.forEach((f) => f(t)), groundRoughness: 0.25 };
}

// ---------- ХОГВАРТС ----------
function buildHogwarts(): Environment {
  const g = new THREE.Group();
  const animated: ((t: number) => void)[] = [];
  const stoneM = std(0x8a8478, 0.9);
  const stoneDark = std(0x6a655a, 0.9);

  // две колоннады вдоль зала
  const colGeo = new THREE.CylinderGeometry(0.55, 0.65, 9, 14);
  const baseGeo = new THREE.BoxGeometry(1.7, 0.6, 1.7);
  const capGeo = new THREE.BoxGeometry(1.6, 0.5, 1.6);
  for (const cx of [10, WORLD_U - 10]) {
    for (let z = 8; z < WORLD_U - 6; z += 9.5) {
      mesh(baseGeo, stoneDark, cx, 0.3, z, g);
      mesh(colGeo, stoneM, cx, 4.9, z, g);
      mesh(capGeo, stoneDark, cx, 9.6, z, g);
      // аркадный пролёт до стены
      mesh(new THREE.BoxGeometry(1.1, 0.8, 9.5), stoneDark, cx, 10.1, z + 4.75, g, false);
    }
  }

  // знамёна факультетов на колоннах
  const bannerColors = [0x7a1414, 0x1a4a2a, 0x1a2a6a, 0x8a6a10];
  let bi = 0;
  for (const cx of [10.9, WORLD_U - 10.9]) {
    for (let z = 8; z < WORLD_U - 6; z += 9.5) {
      const b = mesh(new THREE.PlaneGeometry(1.3, 3.4), new THREE.MeshStandardMaterial({ color: bannerColors[bi % 4], roughness: 0.95, side: THREE.DoubleSide }), cx, 6.6, z, g, false);
      b.rotation.y = cx < C ? Math.PI / 2 : -Math.PI / 2;
      bi++;
    }
  }

  // парящие свечи (как в Большом зале): тело + пламя, покачивание
  const candleGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.5, 8);
  const candleM = std(0xe8ddc0, 0.7);
  const flameM = glowMat(0xffc860);
  const rnd = (() => { let s = 7; return () => (s = (s * 48271) % 2147483647) / 2147483647; })();
  const candles: { grp: THREE.Group; ph: number; y0: number }[] = [];
  for (let i = 0; i < 46; i++) {
    const grp = new THREE.Group();
    const x = 4 + rnd() * (WORLD_U - 8);
    const z = 4 + rnd() * (WORLD_U - 8);
    const y = 4.4 + rnd() * 3.2;
    grp.position.set(x, y, z);
    mesh(candleGeo, candleM, 0, 0, 0, grp, false);
    const flame = mesh(new THREE.SphereGeometry(0.07, 8, 6), flameM, 0, 0.32, 0, grp, false);
    flame.scale.set(0.7, 1.5, 0.7);
    g.add(grp);
    candles.push({ grp, ph: rnd() * Math.PI * 2, y0: y });
  }
  animated.push((t) => {
    for (const c of candles) {
      c.grp.position.y = c.y0 + Math.sin(t * 0.9 + c.ph) * 0.22;
    }
  });

  // свечение от свечей: пара мягких точечных источников
  const l1 = new THREE.PointLight(0xffc890, 60, 40, 1.6);
  l1.position.set(C * 0.5, 6, C);
  g.add(l1);
  const l2 = new THREE.PointLight(0xffc890, 60, 40, 1.6);
  l2.position.set(C * 1.5, 6, C);
  g.add(l2);

  return { group: g, update: (t) => animated.forEach((f) => f(t)), groundRoughness: 0.85 };
}

// ---------- ШКОЛА («Закрытая школа») ----------
function buildSchool(): Environment {
  const g = new THREE.Group();
  const animated: ((t: number) => void)[] = [];

  // стены с высокими окнами (тёплый свет снаружи)
  const wallM = std(0x9a8a72, 0.95);
  const winM = glowMat(0xffe8b0);
  const H = 5.5;
  mesh(new THREE.BoxGeometry(WORLD_U + 2, H, 0.6), wallM, C, H / 2, -0.6, g);
  mesh(new THREE.BoxGeometry(WORLD_U + 2, H, 0.6), wallM, C, H / 2, WORLD_U + 0.6, g);
  mesh(new THREE.BoxGeometry(0.6, H, WORLD_U + 2), wallM, -0.6, H / 2, C, g);
  mesh(new THREE.BoxGeometry(0.6, H, WORLD_U + 2), wallM, WORLD_U + 0.6, H / 2, C, g);
  for (let x = 5; x < WORLD_U - 4; x += 8) {
    mesh(new THREE.PlaneGeometry(2.6, 2.0), winM, x, 3.4, -0.28, g, false);
    mesh(new THREE.PlaneGeometry(2.6, 2.0), winM, x, 3.4, WORLD_U + 0.28, g, false).rotation.y = Math.PI;
  }
  animated.push((t) => {
    const k = 0.85 + Math.sin(t * 7.3) * 0.06 + Math.sin(t * 13.7) * 0.04;
    winM.color.setRGB(1.0 * k, 0.91 * k, 0.69 * k);
  });

  // доска на торцевой стене
  const boardG = new THREE.Group();
  boardG.position.set(C, 0, 0.4);
  mesh(new THREE.BoxGeometry(8, 3, 0.15), std(0x1e3a28, 0.9), 0, 2.6, 0, boardG);
  mesh(new THREE.BoxGeometry(8.4, 3.4, 0.1), std(0x6a4a2a, 0.7), 0, 2.6, -0.06, boardG);
  g.add(boardG);

  // учительский стол
  mesh(new THREE.BoxGeometry(2.6, 0.12, 1.2), std(0x5a4028, 0.7), C, 0.85, 3.4, g);
  mesh(new THREE.BoxGeometry(0.14, 0.85, 1.1), std(0x4a3420, 0.8), C - 1.2, 0.42, 3.4, g);
  mesh(new THREE.BoxGeometry(0.14, 0.85, 1.1), std(0x4a3420, 0.8), C + 1.2, 0.42, 3.4, g);

  // ряды парт с двух сторон от центрального прохода (по рисунку карты)
  const deskTopM = std(0x7a5a38, 0.75);
  const deskLegM = std(0x3a3f4a, 0.6);
  const chairM = std(0x5a4028, 0.8);
  for (let x = 4; x < WORLD_U - 3; x += 4.6) {
    for (const dz of [-4.6, 4.6]) {
      const z = C + dz;
      // парта
      mesh(new THREE.BoxGeometry(1.9, 0.09, 1.0), deskTopM, x, 0.72, z, g);
      mesh(new THREE.BoxGeometry(0.09, 0.7, 0.9), deskLegM, x - 0.85, 0.36, z, g);
      mesh(new THREE.BoxGeometry(0.09, 0.7, 0.9), deskLegM, x + 0.85, 0.36, z, g);
      // стул
      mesh(new THREE.BoxGeometry(0.7, 0.07, 0.7), chairM, x, 0.42, z + (dz < 0 ? -0.95 : 0.95), g);
      mesh(new THREE.BoxGeometry(0.7, 0.7, 0.07), chairM, x, 0.75, z + (dz < 0 ? -1.28 : 1.28), g);
    }
  }

  // разбросанные листы бумаги
  const paperM = std(0xd8d4c8, 0.95);
  const rnd = (() => { let s = 13; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let i = 0; i < 26; i++) {
    const p = mesh(new THREE.PlaneGeometry(0.5, 0.65), paperM, 3 + rnd() * (WORLD_U - 6), 0.02 + rnd() * 0.02, 3 + rnd() * (WORLD_U - 6), g, false);
    p.rotation.x = -Math.PI / 2;
    p.rotation.z = rnd() * Math.PI;
  }

  return { group: g, update: (t) => animated.forEach((f) => f(t)), groundRoughness: 0.8 };
}

// ---------- ОДИНЦОВО ----------
function buildOdintsovo(): Environment {
  const g = new THREE.Group();
  const animated: ((t: number) => void)[] = [];

  // жилые панельки по периметру: разная высота, окна-сетка через текстуру
  const winTex = (() => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#3a4452";
    ctx.fillRect(0, 0, 64, 128);
    for (let y = 6; y < 122; y += 12) {
      for (let x = 6; x < 58; x += 10) {
        const lit = Math.random() < 0.45;
        ctx.fillStyle = lit ? "#ffd890" : "#1c222c";
        ctx.fillRect(x, y, 6, 8);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const buildM = new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.9 });
  const rnd = (() => { let s = 99; return () => (s = (s * 48271) % 2147483647) / 2147483647; })();
  const spots: [number, number][] = [];
  for (let x = 4; x < WORLD_U - 4; x += 10) { spots.push([x, -4], [x, WORLD_U + 4]); }
  for (let z = 6; z < WORLD_U - 4; z += 10) { spots.push([-4, z], [WORLD_U + 4, z]); }
  for (const [x, z] of spots) {
    if (rnd() < 0.25) continue; // пропуски — дворы
    const h = 6 + rnd() * 7;
    mesh(new THREE.BoxGeometry(6.5, h, 6.5), buildM, x, h / 2, z, g);
    mesh(new THREE.BoxGeometry(6.9, 0.4, 6.9), std(0x2a2f38, 0.95), x, h + 0.2, z, g);
  }

  // фонари вдоль дорог (тёплые головки, лёгкое мерцание)
  const poleM = std(0x2a2f38, 0.6);
  const lampM = glowMat(0xffd890);
  const lamps: THREE.Mesh[] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const x = C + Math.cos(a) * (C - 5);
    const z = C + Math.sin(a) * (C - 5);
    mesh(new THREE.CylinderGeometry(0.07, 0.1, 3.4, 8), poleM, x, 1.7, z, g);
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), poleM, x + Math.cos(a + Math.PI / 2) * 0.4, 3.4, z + Math.sin(a + Math.PI / 2) * 0.4, g, false).rotation.z = 0.5;
    const lamp = mesh(new THREE.SphereGeometry(0.17, 10, 8), lampM, x + Math.cos(a + Math.PI / 2) * 0.75, 3.55, z + Math.sin(a + Math.PI / 2) * 0.75, g, false);
    lamps.push(lamp);
  }
  animated.push((t) => {
    const k = 0.9 + Math.sin(t * 5.1) * 0.05 + Math.sin(t * 11.3) * 0.05;
    lampM.color.setRGB(1.0 * k, 0.85 * k, 0.55 * k);
  });

  // деревья: ствол + два яруса кроны
  const trunkM = std(0x4a3420, 0.95);
  const leafM = std(0x2c5c28, 0.95);
  const leafM2 = std(0x3f7a3a, 0.95);
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + 0.13;
    const r = C - 9 - (i % 3) * 3.5;
    const x = C + Math.cos(a) * r;
    const z = C + Math.sin(a) * r;
    mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.4, 7), trunkM, x, 0.7, z, g);
    mesh(new THREE.ConeGeometry(0.9, 1.8, 9), leafM, x, 2.1, z, g);
    mesh(new THREE.ConeGeometry(0.62, 1.3, 9), leafM2, x, 3.0, z, g);
  }

  return { group: g, update: (t) => animated.forEach((f) => f(t)), groundRoughness: 0.75 };
}

/** Построить окружение карты по её id. */
export function buildEnvironment(mapId: string): Environment {
  if (mapId === "arena") return buildArena();
  if (mapId === "hogwarts") return buildHogwarts();
  if (mapId === "school") return buildSchool();
  return buildOdintsovo();
}
