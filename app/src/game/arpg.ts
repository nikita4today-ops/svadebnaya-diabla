/**
 * arpg.ts — «Свадебная Диабла»: изометрический hack-and-slash на 2D-canvas.
 * Четыре героя, четыре тематические локации, волны каждые 30 секунд,
 * боссы каждые 90 секунд, прокачка урона за убийства и кот САТОРУ на клавише F.
 */

import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import {
  HEROES, MAPS, WORLD_SIZE, XP_BASE, SATORU, SATORU_DURATION,
  ALL_ENEMY_KINDS, COOP_BOSSES, COOP_MAP, kindSprite,
  SHOP, LOOT, BREAK_DURATION, SKILL_MAX, ULT_UNLOCK_LEVEL, shopPrice,
} from "./heroes";
import type { HeroDef, EnemyKindDef, MapDef, LootKind } from "./heroes";
import { paintMap } from "./maps";
import { Renderer3D } from "./render3d";
import type { View3D } from "./render3d";
import { Net, makeRoomCode } from "./net";
import type { SnapMsg, EvMsg, LobbyPlayer } from "./net";

type GameState = "select" | "lobby" | "play" | "pause" | "over";

/** Риг частей тела в нормализованных координатах спрайта (совпадает с parts/*.png). */
const RIG_HUMANOID: Record<string, [number, number, number, number]> = {
  legL: [0.28, 0.55, 0.52, 1.0],
  legR: [0.48, 0.55, 0.72, 1.0],
  armL: [0.0, 0.18, 0.34, 0.75],
  armR: [0.66, 0.18, 1.0, 0.75],
};
const RIG_CAT: Record<string, [number, number, number, number]> = {
  legL: [0.5, 0.55, 1.0, 1.0],
  legR: [0.0, 0.55, 0.5, 1.0],
};
const SPRITE_IDS = [
  "hero-nikita", "hero-maxim", "hero-dasha", "hero-vika",
  "enemy-akatsuki", "enemy-gnome", "enemy-deatheater", "enemy-hockey", "satoru",
  // предзапечённые цветные варианты врагов (без ctx.filter в кадре)
  "enemy-hockey-metallurg", "enemy-hockey-akbars",
  "enemy-akatsuki-thrower", "enemy-akatsuki-runner",
  "enemy-gnome-thrower", "enemy-gnome-brute",
  "enemy-deatheater-mage", "enemy-deatheater-assassin",
];

interface Enemy {
  x: number; y: number; hp: number; maxHp: number;
  kind: EnemyKindDef; boss: boolean; name: string;
  speed: number; dmg: number; radius: number; xp: number;
  attackCd: number; shootCd: number; burstCd: number;
  flash: number; disarmT: number; kx: number; ky: number;
  anim: number; sprite: string;
  /** Замах перед ударом: >0 — идёт телеграф атаки, урон при достижении 0. */
  windup: number;
  /** Этап 3 (боссы): кулдауны телеграфа под целью и призыва миньонов. */
  telCd: number; sumCd: number;
  /** Империус (Вика): враг временно сражается за героев. */
  charmT: number; charmOwner?: PlayerEnt;
  /** Поджог (Катон/Инсендио/дракон): урон раз в 0.5 с. */
  burnT: number; burnAcc: number; burnDmg: number; burnOwner?: PlayerEnt;
  /** Сетевой id (кооп): назначает хост, по нему клиент сверяет снапшоты. */
  nid?: number;
  /** Цель интерполяции на клиенте. */
  tx?: number; ty?: number;
}

/** Игрок в коопе (в соло-режиме он один — «me»). */
interface PlayerEnt {
  pid: string;
  hero: HeroDef;
  isLocal: boolean;
  x: number; y: number; facing: number;
  vx: number; vy: number; walkPhase: number; moving: boolean;
  hp: number; maxHp: number; mana: number; maxMana: number;
  level: number; xp: number; xpNext: number; dmgMul: number;
  cdBasic: number; cdQ: number; cdE: number; cdR: number; cdT: number;
  dashT: number; dashDx: number; dashDy: number; dashDmgMul: number; dashHits: Set<Enemy>;
  iframes: number; shieldT: number; speedBuffT: number; swingT: number; hurtFlash: number;
  /** Ярость хоккеиста (Никита, T): усиление на время. */
  rageT: number;
  /** Крутящийся стрелок (Даша, E). */
  spinT: number; spinAng: number; spinFireT: number;
  /** Маунт (замбони/жаба/бэтмобиль/гиппогриф, R): оставшееся время и тик урона. */
  mountT: number; mountDmgT: number;
  /** Сейсмический прыжок (Даша, T). */
  leapT: number; leapFromX: number; leapFromY: number; leapToX: number; leapToY: number;
  cdF: number; // Зов САТОРУ
  /** Этап 2: очки навыков, уровни скиллов q/e/r/t, золото, покупки, бонусы из лута. */
  skillPts: number; sk: { q: number; e: number; r: number; t: number };
  gold: number; buys: number[];
  cdRushT: number; berserkT: number; invulnT: number;
  alive: boolean;
  /** Этап 3: личные убийства (лидерборд), прогресс воскрешения, место гибели. */
  kills: number; reviveProg: number; deadX: number; deadY: number;
  /** Цель интерполяции для удалённых игроков. */
  tx: number; ty: number;
  trail: Array<{ x: number; y: number; life: number }>;
}

function makePlayer(pid: string, hero: HeroDef, isLocal: boolean): PlayerEnt {
  return {
    pid, hero, isLocal,
    x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, facing: 0,
    vx: 0, vy: 0, walkPhase: 0, moving: false,
    hp: hero.hp, maxHp: hero.hp, mana: 100, maxMana: 100,
    level: 1, xp: 0, xpNext: XP_BASE, dmgMul: 1,
    cdBasic: 0, cdQ: 0, cdE: 0, cdR: 0, cdT: 0,
    dashT: 0, dashDx: 0, dashDy: 0, dashDmgMul: 0, dashHits: new Set(),
    iframes: 0, shieldT: 0, speedBuffT: 0, swingT: 0, hurtFlash: 0,
    rageT: 0, spinT: 0, spinAng: 0, spinFireT: 0, mountT: 0, mountDmgT: 0,
    leapT: 0, leapFromX: 0, leapFromY: 0, leapToX: 0, leapToY: 0, cdF: 0,
    skillPts: 0, sk: { q: 1, e: 1, r: 1, t: 0 }, gold: 0, buys: [0, 0, 0, 0, 0, 0],
    cdRushT: 0, berserkT: 0, invulnT: 0,
    kills: 0, reviveProg: 0, deadX: 0, deadY: 0,
    alive: true, tx: WORLD_SIZE / 2, ty: WORLD_SIZE / 2, trail: [],
  };
}

function heroById(id: string): HeroDef {
  return HEROES.find((h) => h.id === id) ?? HEROES[0];
}

interface Corpse { x: number; y: number; sprite: string; life: number; flip: boolean; scale: number }

interface Proj {
  x: number; y: number; vx: number; vy: number;
  dmg: number; r: number; friendly: boolean; pierce: boolean;
  life: number; color: string; kind: string; disarm: boolean;
  hitSet: Set<Enemy> | null;
  /** Сетевой id (кооп) и владелец (для начисления опыта). */
  nid?: number; owner?: PlayerEnt;
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; size: number }
interface Floater { x: number; y: number; text: string; color: string; life: number }
interface Orb { x: number; y: number; heal: number; t: number }
interface Announce { text: string; sub: string; life: number; max: number }
/** Ударная волна: расширяющееся кольцо; если dmg > 0 — наносит урон один раз каждому врагу в кольце. */
interface WaveFx { x: number; y: number; r: number; maxR: number; life: number; maxLife: number; color: string; dmg: number; width: number; hitSet: Set<Enemy> | null; owner?: PlayerEnt }
/** Временный источник света (вспышка взрыва/заклинания). */
interface TempLight { x: number; y: number; r: number; life: number; maxLife: number }
/** Отложенный залп (Даша, «Тотальный отстрел»). */
interface Volley { t: number; ang0: number; p: PlayerEnt }
/** Кот САТОРУ (в коопе может быть несколько — по одному на игрока). */
interface SatoruEnt { x: number; y: number; life: number; swipeCd: number; pid: string }
/** Теневой клон Максима: сам ищет врагов и стреляет сюрикенами. */
interface CloneEnt { x: number; y: number; t: number; shootT: number; walk: number; owner: PlayerEnt; nid?: number }
/** Огненный дракон Вики: летает вокруг хозяйки и жжёт область. */
interface DragonEnt { x: number; y: number; t: number; ang: number; tickT: number; owner: PlayerEnt }
/** Вспышка конусной атаки (Катон, Инсендио, дробовик, замах). */
interface ConeFx { x: number; y: number; dir: number; half: number; range: number; life: number; maxLife: number; color: string }

const BEST_KEY = "svadebnaya-diabla.best.v1";
type BestMap = Partial<Record<string, { time: number; kills: number; level: number }>>;

function loadBest(): BestMap {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as BestMap;
    return typeof p === "object" && p !== null ? p : {};
  } catch { return {}; }
}
function saveBest(b: BestMap): void {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch { /* private mode */ }
}

export class Arpg {
  private ctx: CanvasRenderingContext2D;
  /** WebGL-рендер мира (изометрия Diablo 3); null — запасной 2D-рендер. */
  private r3d: Renderer3D | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private loop: GameLoop;
  private input: Input;
  private audio = new AudioSystem();
  private dpr = Math.min(window.devicePixelRatio || 1, 1) * 0.8; // рендер в пониженном разрешении — критично для ПК без видеокарты
  /** Адаптивное качество: множитель внутреннего разрешения, подстраивается под реальный FPS. */
  private qs = 0.8;
  private qWallT = 0; private qFrames = 0; private qLast = 0;
  /** Диагностика производительности: ?skip=decals,corpses,... пропускает секции рендера. */
  private skipSec = new Set((new URLSearchParams(location.search).get("skip") ?? "").split(",").filter(Boolean));
  private perfU = 0; private perfR = 0; private perfN = 0;
  /** Время по секциям рендера: [карта, сущности, эффекты, свет, HUD]. */
  private perfSec = [0, 0, 0, 0, 0];
  private w = window.innerWidth;
  private h = window.innerHeight;

  private state: GameState = "select";
  private faces = new Map<string, HTMLImageElement>();
  private sprites = new Map<string, HTMLImageElement>();
  private parts = new Map<string, HTMLImageElement>();
  /** Запечённые кадры кукольной анимации: 12 кадров шага + 4 кадра удара на спрайт. */
  private baked = new Map<string, { walk: HTMLCanvasElement[]; attack: HTMLCanvasElement[]; W: number; H: number }>();
  /** Кэш радиальных свечений: вместо createRadialGradient на каждый снаряд в каждом кадре. */
  private glowCache = new Map<string, HTMLCanvasElement>();
  private mapCanvas: HTMLCanvasElement | null = null;
  private corpses: Corpse[] = [];

  private hero: HeroDef = HEROES[0];
  private map: MapDef = MAPS.arena;
  private selIndex = 0;

  // игроки (в соло — только me)
  private me: PlayerEnt = makePlayer("me", HEROES[0], true);
  private players: PlayerEnt[] = [];
  /** Хит-стоп: микрозамедление времени при убийствах (сочность ударов, как в Diablo). */
  private hitStop = 0;

  // сеть (кооп)
  private net: Net | null = null;
  private netMode: "off" | "host" | "client" = "off";
  private myPid = "me";
  private hostPeerId = ""; // trystero-id хоста, узнаём из входящих сообщений
  private netPeerOf = new Map<string, string>(); // pid -> trystero peerId (на хосте)
  private lobbyPlayers: LobbyPlayer[] = [];
  private lobbyT = 0;           // периодическая рассылка состояния лобби
  private lobbyWait = 0;        // таймер ожидания ответа лобби на клиенте
  private lobbyError = "";
  private selScreen: "heroes" | "join" = "heroes";
  private joinCode = "";
  private netSendT = 0;
  private nidSeq = 1;
  private enemyByNid = new Map<number, Enemy>();
  private projByNid = new Map<number, Proj>();
  private prevWave = 1;
  private prevAlive = true;

  // акцессоры к полям локального игрока — основной код симуляции не меняется
  private get px(): number { return this.me.x; } private set px(v: number) { this.me.x = v; }
  private get py(): number { return this.me.y; } private set py(v: number) { this.me.y = v; }
  private get facing(): number { return this.me.facing; } private set facing(v: number) { this.me.facing = v; }
  private get pvx(): number { return this.me.vx; } private set pvx(v: number) { this.me.vx = v; }
  private get pvy(): number { return this.me.vy; } private set pvy(v: number) { this.me.vy = v; }
  private get walkPhase(): number { return this.me.walkPhase; } private set walkPhase(v: number) { this.me.walkPhase = v; }
  private get hp(): number { return this.me.hp; } private set hp(v: number) { this.me.hp = v; }
  private get maxHp(): number { return this.me.maxHp; } private set maxHp(v: number) { this.me.maxHp = v; }
  private get mana(): number { return this.me.mana; } private set mana(v: number) { this.me.mana = v; }
  private get maxMana(): number { return this.me.maxMana; } private set maxMana(v: number) { this.me.maxMana = v; }
  private get level(): number { return this.me.level; } private set level(v: number) { this.me.level = v; }
  private get xp(): number { return this.me.xp; } private set xp(v: number) { this.me.xp = v; }
  private get xpNext(): number { return this.me.xpNext; } private set xpNext(v: number) { this.me.xpNext = v; }
  private get dmgMul(): number { return this.me.dmgMul; } private set dmgMul(v: number) { this.me.dmgMul = v; }
  private get cdBasic(): number { return this.me.cdBasic; } private set cdBasic(v: number) { this.me.cdBasic = v; }
  private get cdQ(): number { return this.me.cdQ; } private set cdQ(v: number) { this.me.cdQ = v; }
  private get cdE(): number { return this.me.cdE; } private set cdE(v: number) { this.me.cdE = v; }
  private get cdR(): number { return this.me.cdR; } private set cdR(v: number) { this.me.cdR = v; }
  private get cdT(): number { return this.me.cdT; } private set cdT(v: number) { this.me.cdT = v; }
  private get dashT(): number { return this.me.dashT; } private set dashT(v: number) { this.me.dashT = v; }
  private get dashDx(): number { return this.me.dashDx; } private set dashDx(v: number) { this.me.dashDx = v; }
  private get dashDy(): number { return this.me.dashDy; } private set dashDy(v: number) { this.me.dashDy = v; }
  private get dashDmgMul(): number { return this.me.dashDmgMul; } private set dashDmgMul(v: number) { this.me.dashDmgMul = v; }
  private get dashHits(): Set<Enemy> { return this.me.dashHits; } private set dashHits(v: Set<Enemy>) { this.me.dashHits = v; }
  private get iframes(): number { return this.me.iframes; } private set iframes(v: number) { this.me.iframes = v; }
  private get shieldT(): number { return this.me.shieldT; } private set shieldT(v: number) { this.me.shieldT = v; }
  private get speedBuffT(): number { return this.me.speedBuffT; } private set speedBuffT(v: number) { this.me.speedBuffT = v; }
  private get swingT(): number { return this.me.swingT; } private set swingT(v: number) { this.me.swingT = v; }
  private get hurtFlash(): number { return this.me.hurtFlash; } private set hurtFlash(v: number) { this.me.hurtFlash = v; }
  private get rageT(): number { return this.me.rageT; } private set rageT(v: number) { this.me.rageT = v; }
  private get spinT(): number { return this.me.spinT; } private set spinT(v: number) { this.me.spinT = v; }
  private get mountT(): number { return this.me.mountT; } private set mountT(v: number) { this.me.mountT = v; }
  private get cdF(): number { return this.me.cdF; } private set cdF(v: number) { this.me.cdF = v; }

  // декали (кровь/следы) и слой освещения
  private decals: Array<{ x: number; y: number; r: number; color: string; alpha: number }> = [];
  private lightCanvas: HTMLCanvasElement | null = null;
  private lightCtx: CanvasRenderingContext2D | null = null;
  private vignette: HTMLCanvasElement | null = null;

  // мир
  private enemies: Enemy[] = [];
  private projs: Proj[] = [];
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private waves: WaveFx[] = [];
  private tempLights: TempLight[] = [];
  private volleys: Volley[] = [];
  private orbs: Orb[] = [];
  private announces: Announce[] = [];
  private time = 0; private kills = 0;
  private wave = 1; private hpMul = 1; private dmgMulE = 1;
  private spawnT = 0;
  /** Этап 2: обособленные волны с перерывом на прокачку и магазин. */
  private waveState: "fight" | "break" = "fight";
  private breakT = 0;
  private waveSpawnLeft = 0;
  private shopOpen = false;
  private golds: Array<{ x: number; y: number; v: number; t: number }> = [];
  private loots: Array<{ x: number; y: number; kind: LootKind; t: number }> = [];
  /** Этап 3: телеграфы (атаки боссов и катаклизмы), пауза хоста, метеоры, карта коопа. */
  private telegraphs: Array<{ x: number; y: number; r: number; t: number; maxT: number; dmg: number; kind: "boss" | "meteor" }> = [];
  private netPaused = false;
  private meteorT = 16;
  private meteorAnnounced = false;
  private lobbyMap = "coop";
  private satorus: SatoruEnt[] = [];
  private clones: CloneEnt[] = [];
  private dragons: DragonEnt[] = [];
  private cones: ConeFx[] = [];
  private shake = 0;
  private overStats = { time: 0, kills: 0, level: 1, wave: 1 };
  private best: BestMap = loadBest();

  // мышь
  private mx = 0; private my = 0; private mouseDown = false;
  private aimX = 0; private aimY = 0; // мировая точка под курсором
  private cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private menuBtns: Array<{ x: number; y: number; w: number; h: number; act: string }> = [];
  private unsub: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.input = new Input(canvas);
    this.resize();
    // 3D-рендер: изометрическая камера в духе Diablo 3 (запасной путь — 2D)
    try {
      const glc = document.createElement("canvas");
      glc.style.cssText = "position:fixed;inset:0;z-index:0;pointer-events:none;";
      this.canvas.style.position = "fixed";
      this.canvas.style.zIndex = "1";
      this.canvas.style.background = "transparent";
      this.canvas.parentElement?.insertBefore(glc, this.canvas);
      this.r3d = new Renderer3D(glc);
      this.glCanvas = glc;
    } catch {
      this.r3d = null;
    }
    const on = <T extends Event>(el: HTMLElement | Window, type: string, fn: (e: T) => void) => {
      const h = fn as EventListener;
      el.addEventListener(type, h);
      this.unsub.push(() => el.removeEventListener(type, h));
    };
    on<MouseEvent>(window, "mousemove", (e) => { this.mx = e.clientX; this.my = e.clientY; });
    on<MouseEvent>(window, "mousedown", (e) => { if (e.button === 0) { this.mouseDown = true; this.onClick(e.clientX, e.clientY); } });
    on<MouseEvent>(window, "mouseup", (e) => { if (e.button === 0) this.mouseDown = false; });
    on(window, "resize", () => this.resize());
    on(window, "contextmenu", (e) => { if (e.target === canvas) e.preventDefault(); });

    // загрузка лиц и спрайтов
    const base = import.meta.env.BASE_URL || "/";
    for (const hdef of HEROES) this.loadFace(hdef.id, base + hdef.face);
    this.loadFace("satoru", base + "faces/satoru.png");
    for (const id of SPRITE_IDS) {
      const img = new Image();
      img.src = base + `sprites/${id}.png`;
      this.sprites.set(id, img);
      // части тела для кукольной анимации
      const partNames = id === "satoru" ? ["torso", "legL", "legR"] : ["torso", "legL", "legR", "armL", "armR"];
      for (const p of partNames) {
        const pimg = new Image();
        pimg.src = base + `parts/${id}-${p}.png`;
        this.parts.set(`${id}-${p}`, pimg);
      }
    }

    this.loop = new GameLoop({
      update: (dt) => { const t = performance.now(); this.update(dt); this.perfU += performance.now() - t; },
      render: () => {
        const t = performance.now();
        this.render();
        this.perfR += performance.now() - t; this.perfN++;
        this.autoQuality(t);
      },
    });
  }

  /** Адаптивное разрешение: раз в 1.5 сек смотрим реальный промежуток между кадрами
   *  и понижаем/повышаем внутреннее разрешение рендера. */
  private autoQuality(now: number): void {
    if (this.qLast > 0) this.qWallT += now - this.qLast;
    this.qLast = now;
    this.qFrames++;
    if (this.qWallT < 1500 || this.qFrames < 5) return;
    const avg = this.qWallT / this.qFrames;
    this.qWallT = 0; this.qFrames = 0;
    if (avg > 24 && this.qs > 0.45) {
      this.qs = Math.max(0.45, this.qs - 0.12);
      this.resize();
    } else if (avg < 13 && this.qs < 0.85) {
      this.qs = Math.min(0.85, this.qs + 0.07);
      this.resize();
    }
  }

  /** Среднее время update/render за кадр (мс) с момента прошлого вызова; сбрасывает счётчики. */
  perfStats(): { update: number; render: number; frames: number; sections: number[] } {
    const n = Math.max(1, this.perfN);
    const r = {
      update: this.perfU / n, render: this.perfR / n, frames: this.perfN,
      sections: this.perfSec.map((v) => v / n),
    };
    this.perfU = 0; this.perfR = 0; this.perfN = 0;
    this.perfSec = [0, 0, 0, 0, 0];
    return r;
  }

  private loadFace(id: string, url: string): void {
    const img = new Image();
    img.src = url;
    this.faces.set(id, img);
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1) * this.qs;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    // слой освещения — в пониженном разрешении (мягкий свет, потери не видны)
    const ls = 0.35;
    this.lightCanvas = document.createElement("canvas");
    this.lightCanvas.width = Math.max(1, Math.floor(this.w * this.dpr * ls));
    this.lightCanvas.height = Math.max(1, Math.floor(this.h * this.dpr * ls));
    this.lightCtx = this.lightCanvas.getContext("2d");
    // виньетка статична — запекаем один раз при resize
    this.vignette = document.createElement("canvas");
    this.vignette.width = this.lightCanvas.width;
    this.vignette.height = this.lightCanvas.height;
    const vc = this.vignette.getContext("2d");
    if (vc) {
      vc.setTransform(this.dpr * ls, 0, 0, this.dpr * ls, 0, 0);
      const v = vc.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.42, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.72);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.5)");
      vc.fillStyle = v;
      vc.fillRect(0, 0, this.w, this.h);
    }
  }

  start(): void { this.loop.start(); }

  dispose(): void {
    this.r3d?.dispose();
    this.glCanvas?.remove();
    this.loop.stop();
    this.input.dispose();
    this.audio.dispose();
    void this.net?.leave();
    this.net = null;
    for (const f of this.unsub) f();
    this.unsub = [];
  }

  // ---------- сеть: лобби ----------

  private createLobby(): void {
    this.leaveNet();
    const code = makeRoomCode();
    this.net = new Net(code);
    this.netMode = "host";
    this.myPid = "HOST";
    this.lobbyPlayers = [{ pid: "HOST", hero: HEROES[this.selIndex].id, host: true }];
    this.lobbyError = "";
    this.state = "lobby";
    this.wireNet();
    this.audio.sfx("ui");
  }

  private joinLobby(code: string): void {
    this.leaveNet();
    this.net = new Net(code);
    this.netMode = "client";
    this.myPid = "C" + Math.random().toString(36).slice(2, 8).toUpperCase();
    this.lobbyPlayers = [];
    this.hostPeerId = "";
    this.lobbyError = "";
    this.lobbyWait = 15; // ждём первую рассылку лобби от хоста
    this.state = "lobby";
    this.wireNet();
    this.audio.sfx("ui");
  }

  private leaveNet(): void {
    void this.net?.leave();
    this.net = null;
    this.netMode = "off";
    this.netPeerOf.clear();
  }

  private wireNet(): void {
    const net = this.net!;
    net.onHero((d, peerId) => {
      if (this.netMode !== "host") return;
      const pid = (d as { pid?: string }).pid ?? peerId;
      this.netPeerOf.set(pid, peerId);
      const ex = this.lobbyPlayers.find((p) => p.pid === pid);
      if (ex) ex.hero = d.hero;
      else if (this.lobbyPlayers.length < 6) this.lobbyPlayers.push({ pid, hero: d.hero, host: false });
      this.broadcastLobby();
    });
    net.onPeerLeave((peerId) => {
      if (this.netMode === "host") {
        const pid = [...this.netPeerOf.entries()].find(([, v]) => v === peerId)?.[0];
        if (pid) {
          this.netPeerOf.delete(pid);
          const lp = this.lobbyPlayers.findIndex((p) => p.pid === pid);
          if (lp >= 0) { this.lobbyPlayers.splice(lp, 1); this.broadcastLobby(); }
          const pl = this.players.findIndex((p) => p.pid === pid);
          if (pl >= 0 && this.state === "play") {
            this.announce(`${this.players[pl].hero.name} ВЫБЫЛ`, "игрок отключился");
            this.players.splice(pl, 1);
          }
        }
      } else if (this.netMode === "client" && peerId === this.hostPeerId) {
        this.lobbyError = "хост отключился";
        this.announce("СОЕДИНЕНИЕ ПОТЕРЯНО", "хост покинул игру");
        this.leaveNet();
        this.state = "select";
        this.selScreen = "heroes";
      }
    });
    net.onLobby((d, peerId) => {
      if (this.netMode !== "client") return;
      this.hostPeerId = peerId;
      this.lobbyWait = 0;
      const before = this.lobbyPlayers.map((p) => p.pid).join(",");
      this.lobbyPlayers = d.pl;
      this.lobbyMap = d.map ?? "coop";
      // нас ещё нет в списке — представляемся
      if (!d.pl.some((p) => p.pid === this.myPid)) {
        net.sendHero({ pid: this.myPid, hero: HEROES[this.selIndex].id } as never, );
      }
      const after = d.pl.map((p) => p.pid).join(",");
      if (before !== after) this.audio.sfx("ui");
    });
    net.onStart((d, peerId) => {
      if (this.netMode !== "client") return;
      this.hostPeerId = peerId;
      const meLp = d.pl.find((p) => p.pid === this.myPid);
      this.startRun(heroById(meLp?.hero ?? HEROES[this.selIndex].id), true, d.pl, d.map);
    });
    net.onInp((d, peerId) => {
      if (this.netMode !== "host" || this.state !== "play") return;
      const p = this.players.find((pl) => this.netPeerOf.get(pl.pid) === peerId);
      if (!p || !p.alive) return;
      p.tx = d.x; p.ty = d.y; p.x = d.x; p.y = d.y; // позиция клиента авторитетна
      p.facing = d.fx; p.walkPhase = d.wk; p.moving = d.mv;
    });
    net.onCast((d, peerId) => {
      if (this.netMode !== "host" || this.state !== "play") return;
      const p = this.players.find((pl) => this.netPeerOf.get(pl.pid) === peerId);
      if (!p || !p.alive) return;
      this.executeCast(p, d.k, d.dir);
    });
    net.onReq((d, peerId) => {
      if (this.netMode !== "host" || this.state !== "play") return;
      const p = this.players.find((pl) => this.netPeerOf.get(pl.pid) === peerId);
      if (!p) return;
      if (d.k === "skillup") this.upgradeSkill(p, (["q", "e", "r", "t"] as const)[Math.max(0, Math.min(3, d.v))]);
      else if (d.k === "buy") this.buyItem(p, d.v);
    });
    net.onSnap((d) => {
      if (this.netMode === "client" && this.state === "play") this.applySnap(d);
    });
    net.onEv((d) => {
      if (this.netMode !== "client") return;
      this.applyEv(d);
    });
  }

  private broadcastLobby(): void {
    this.net?.sendLobby({ pl: this.lobbyPlayers, map: this.lobbyMap });
  }

  private hostStartCoop(): void {
    if (!this.net) return;
    this.net.sendStart({ pl: this.lobbyPlayers, map: this.lobbyMap });
    const meLp = this.lobbyPlayers.find((p) => p.pid === this.myPid);
    this.startRun(heroById(meLp?.hero ?? HEROES[this.selIndex].id), true, this.lobbyPlayers, this.lobbyMap);
  }

  private updateLobby(dt: number): void {
    // смена героя в лобби
    for (let i = 0; i < HEROES.length; i++) {
      if (this.input.consumeAction(`Digit${i + 1}`)) this.setLobbyHero(i);
    }
    if (this.input.consumeAction("Escape")) {
      this.leaveNet();
      this.state = "select";
      this.selScreen = "heroes";
      this.audio.sfx("ui");
      return;
    }
    if (this.netMode === "host") {
      this.lobbyT -= dt;
      if (this.lobbyT <= 0) { this.lobbyT = 1; this.broadcastLobby(); }
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        if (this.lobbyPlayers.length >= 2) this.hostStartCoop();
        else this.lobbyError = "нужно хотя бы 2 игрока";
      }
      // выбор карты стрелками
      if (this.input.consumeAction("ArrowLeft") || this.input.consumeAction("ArrowRight")) {
        const ids = ["coop", "arena", "odintsovo", "school", "hogwarts"];
        const ix = (ids.indexOf(this.lobbyMap) + 1) % ids.length;
        this.lobbyMap = ids[ix];
        this.broadcastLobby();
        this.audio.sfx("ui");
      }
    } else {
      // клиент: ждём первый ответ хоста
      if (!this.hostPeerId && this.lobbyWait > 0) {
        this.lobbyWait -= dt;
        if (this.lobbyWait <= 0) {
          this.lobbyError = "лобби не найдено";
          this.leaveNet();
          this.state = "select";
          this.selScreen = "join";
        }
      }
    }
  }

  // ---------- управление состоянием ----------

  private startRun(hero: HeroDef, coop = false, lobbyPl?: LobbyPlayer[], mapId?: string): void {
    this.hero = hero;
    if (coop && lobbyPl) {
      const picked = mapId && mapId !== "coop" ? (MAPS as Record<string, MapDef>)[mapId] : undefined;
      this.map = picked ?? COOP_MAP;
      this.mapCanvas = paintMap(picked ? picked.id : "arena");
      this.players = lobbyPl.map((lp, i) => {
        const p = makePlayer(lp.pid, heroById(lp.hero), lp.pid === this.myPid);
        const a = (i / lobbyPl.length) * Math.PI * 2;
        p.x = WORLD_SIZE / 2 + Math.cos(a) * 140;
        p.y = WORLD_SIZE / 2 + Math.sin(a) * 140;
        p.tx = p.x; p.ty = p.y;
        return p;
      });
      this.me = this.players.find((p) => p.isLocal) ?? this.players[0];
      this.hero = this.me.hero;
    } else {
      this.map = MAPS[hero.mapId];
      this.mapCanvas = paintMap(hero.mapId);
      this.me = makePlayer("me", hero, true);
      this.players = [this.me];
    }
    this.enemyByNid.clear(); this.projByNid.clear(); this.nidSeq = 1;
    this.cdBasic = this.cdQ = this.cdE = this.cdR = this.cdT = 0;
    this.hitStop = 0;
    this.enemies = []; this.projs = []; this.particles = []; this.floaters = []; this.orbs = [];
    this.decals = []; this.waves = []; this.tempLights = []; this.volleys = [];
    this.time = 0; this.kills = 0;
    this.wave = 1; this.hpMul = 1; this.dmgMulE = 1;
    this.prevWave = 1; this.prevAlive = true;
    this.waveState = "fight"; this.breakT = 0; this.waveSpawnLeft = 0;
    this.shopOpen = false; this.golds = []; this.loots = [];
    this.satorus = []; this.shake = 0;
    this.telegraphs = []; this.netPaused = false;
    this.meteorT = 16; this.meteorAnnounced = false;
    this.netSendT = 0;
    this.state = "play";
    this.audio.startMusic();
    this.announce(this.map.name.toUpperCase(), coop ? `${this.players.length} героя против всех армий` : `${hero.name} в деле — ${this.map.subtitle}`);
    if (this.netMode !== "client") this.startWave(1, coop);
    // хост рассылает стартовое состояние сразу, чтобы клиенты увидели мир
    if (this.netMode === "host") this.sendSnap();
  }

  private gameOver(): void {
    this.overStats = { time: this.time, kills: this.kills, level: this.level, wave: this.wave };
    if (this.netMode === "host") {
      this.net?.sendEv({ t: "over", time: this.time, kills: this.kills, wave: this.wave });
      this.leaveNetAfter();
    }
    if (this.netMode === "client") this.leaveNetAfter();
    const prev = this.best[this.hero.id];
    if (!prev || this.time > prev.time) {
      this.best[this.hero.id] = { time: Math.floor(this.time), kills: this.kills, level: this.level };
      saveBest(this.best);
    }
    this.state = "over";
    this.audio.sfx("lose");
    this.audio.stopMusic();
  }

  /** Аккуратно закрыть комнату после конца кооп-игры. */
  private leaveNetAfter(): void {
    const net = this.net;
    this.net = null;
    this.netMode = "off";
    setTimeout(() => { void net?.leave(); }, 800); // даём последним пакетам уйти
  }

  private announce(text: string, sub = ""): void {
    this.announces.push({ text, sub, life: 2.6, max: 2.6 });
  }

  // ---------- апдейт ----------

  private update(dt: number): void {
    // глобальные клавиши (в меню M — это буква кода лобби, не мьют)
    if (this.state === "play" || this.state === "pause") {
      if (this.input.consumeAction("KeyM")) this.audio.toggleMute();
    }
    if (this.state === "select") { this.updateSelect(); return; }
    if (this.state === "lobby") { this.updateLobby(dt); return; }
    if (this.state === "over") {
      if (this.input.consumeAction("Enter") || this.input.consumeAction("Space")) { this.state = "select"; this.selScreen = "heroes"; this.audio.sfx("ui"); }
      return;
    }
    if (this.input.consumeAction("Escape")) {
      if (this.shopOpen) { this.shopOpen = false; this.audio.sfx("ui"); }
      else if (this.netMode === "off") {
        this.state = this.state === "pause" ? "play" : "pause";
        this.audio.sfx("ui");
      } else if (this.netMode === "host") {
        this.netPaused = !this.netPaused;
        this.net?.sendEv({ t: "pause", on: this.netPaused });
        this.announce(this.netPaused ? "ПАУЗА" : "БОЙ ПРОДОЛЖАЕТСЯ", this.netPaused ? "хост поставил паузу для всего лобби" : "");
        this.audio.sfx("ui");
      } else {
        this.floaters.push({ x: this.px, y: this.py - 40, text: "ПАУЗУ СТАВИТ ТОЛЬКО ХОСТ", color: "#c9a15a", life: 1 });
      }
    }
    if (this.state === "pause") return;
    if (this.netPaused) return; // пауза хоста: мир заморожен у всех

    // хит-стоп: микрозамедление при убийствах (удар чувствуется весомым)
    if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.12; }

    this.time += dt;
    const authority = this.netMode !== "client";
    const coop = this.netMode !== "off";

    // волны: обособленные раунды; зачистил волну → перерыв на прокачку и магазин
    if (authority) {
      if (this.waveState === "fight") {
        this.spawnT -= dt;
        const cap = Math.min(70, 10 + this.wave * 3 + (coop ? (this.players.length - 1) * 6 : 0));
        if (this.spawnT <= 0 && this.waveSpawnLeft > 0 && this.enemies.length < cap) {
          this.spawnT = Math.max(0.5, 1.4 - this.wave * 0.05);
          const batch = Math.min(this.waveSpawnLeft, cap - this.enemies.length, 3 + Math.floor(this.wave / 2));
          for (let i = 0; i < batch; i++) this.spawnEnemy(false);
          this.waveSpawnLeft -= batch;
        }
        // волна зачищена → перерыв (подчинённые Империусом рассеиваются и не блокируют конец)
        if (this.waveSpawnLeft <= 0 && !this.enemies.some((e) => e.charmT <= 0)) {
          for (const e of this.enemies) {
            this.spawnParticles(e.x, e.y, 10, "#3ddc84", 200);
            if (e.nid !== undefined) this.enemyByNid.delete(e.nid);
          }
          this.enemies = [];
          // перерыв возвращает павших союзников в бой
          for (const p of this.players) {
            if (p.alive) continue;
            p.alive = true; p.hp = p.maxHp * 0.6; p.reviveProg = 0;
            const ra = Math.random() * Math.PI * 2;
            p.x = WORLD_SIZE / 2 + Math.cos(ra) * 120; p.y = WORLD_SIZE / 2 + Math.sin(ra) * 120;
            p.tx = p.x; p.ty = p.y;
            if (p.isLocal) this.audio.sfx("win");
            this.spawnWave(p.x, p.y, 160, "#7ee87a", 0, 18, 0.5);
            this.announce(`${p.hero.name} ВОСКРЕС`, "перерыв между волнами возвращает павших");
            if (coop) this.net?.sendEv({ t: "ann", x: `${p.hero.name} ВОСКРЕС`, s: "перерыв между волнами возвращает павших" });
          }
          this.waveState = "break"; this.breakT = BREAK_DURATION;
          this.announce("ВОЛНА ЗАЧИЩЕНА!", `перерыв ${BREAK_DURATION} сек — прокачка (1-4) и магазин (B)`);
          if (coop) this.net?.sendEv({ t: "ann", x: "ВОЛНА ЗАЧИЩЕНА!", s: `перерыв ${BREAK_DURATION} сек — прокачка (1-4) и магазин (B)` });
          this.audio.sfx("win");
        }
      } else {
        this.breakT -= dt;
        if (this.breakT <= 0) this.startWave(this.wave + 1, coop);
      }
    }

    // таймеры всех игроков тикают на хосте (и локально у каждого — для отзывчивости)
    for (const p of this.players) {
      if (!p.isLocal && !authority) continue;
      p.cdBasic -= dt; p.cdQ -= dt; p.cdE -= dt; p.cdR -= dt; p.cdT -= dt; p.cdF -= dt;
      p.mana = Math.min(p.maxMana, p.mana + 9 * dt);
      p.iframes -= dt; p.shieldT -= dt; p.speedBuffT -= dt; p.rageT -= dt;
      p.swingT -= dt; p.hurtFlash -= dt;
      p.cdRushT -= dt; p.berserkT -= dt; p.invulnT -= dt;
    }

    // прицел локального игрока: мировая точка под курсором
    // в 3D-режиме — луч мыши на плоскость земли, в 2D-запасном — смещение камеры
    if (this.r3d) {
      const wpt = this.r3d.unproject(this.mx, this.my, this.w, this.h);
      this.aimX = wpt.x; this.aimY = wpt.y;
    } else {
      this.aimX = this.camX() + this.mx; this.aimY = this.camY() + this.my;
    }
    this.facing = Math.atan2(this.aimY - this.py, this.aimX - this.px);

    // движение локального игрока (своя позиция авторитетна и в коопе)
    if (this.me.alive) this.updateLocalMovement(dt);

    // удалённые игроки: дэш-урон и приземление прыжка на хосте, следы на клиенте
    for (const p of this.players) {
      if (p.isLocal || !p.alive) continue;
      if (authority && p.leapT > 0) {
        p.leapT -= dt;
        if (p.leapT <= 0) this.leapLand(p);
      }
      if (authority && p.dashT > 0) {
        p.dashT -= dt;
        if (p.dashDmgMul > 0) {
          for (const e of this.enemies) {
            if (p.dashHits.has(e)) continue;
            const d = Math.hypot(e.x - p.x, e.y - p.y);
            if (d < e.radius + 30) {
              p.dashHits.add(e);
              this.damageEnemy(e, this.basicDmg(p) * p.dashDmgMul, p.dashDx * 320, p.dashDy * 320, p);
            }
          }
        }
      }
      if (!authority && p.dashT > 0) {
        p.trail.push({ x: p.x, y: p.y, life: 0.35 });
        if (p.trail.length > 40) p.trail.shift();
      }
    }

    // атаки локального игрока
    if (this.me.alive) {
      if (this.mouseDown && this.cdBasic <= 0 && this.dashT <= 0 && this.me.leapT <= 0) this.tryCast("basic");
      if (this.input.consumeAction("KeyQ") && this.cdQ <= 0) this.tryCast("q");
      if (this.input.consumeAction("KeyE") && this.cdE <= 0) this.tryCast("e");
      if (this.input.consumeAction("KeyR") && this.cdR <= 0) this.tryCast("r");
      if (this.input.consumeAction("KeyT") && this.cdT <= 0) this.tryCast("t");
      if (this.input.consumeAction("KeyF") && this.cdF <= 0) this.tryCast("f");
    }

    // прокачка навыков (1-4) и магазин (B) — этап 2
    if (this.input.consumeAction("KeyB")) {
      if (this.waveState === "break") { this.shopOpen = !this.shopOpen; this.audio.sfx("ui"); }
      else if (this.me.alive) this.floaters.push({ x: this.px, y: this.py - 40, text: "МАГАЗИН ОТКРОЕТСЯ В ПЕРЕРЫВЕ", color: "#c9a15a", life: 1.2 });
    }
    if (this.shopOpen && this.waveState !== "break") this.shopOpen = false;
    if (this.shopOpen) {
      for (let i = 0; i < SHOP.length; i++) {
        if (this.input.consumeAction(`Digit${i + 1}`)) this.requestBuy(i);
      }
    } else if (this.me.skillPts > 0 && this.me.alive) {
      const keys = ["q", "e", "r", "t"] as const;
      for (let i = 0; i < keys.length; i++) {
        if (this.input.consumeAction(`Digit${i + 1}`)) this.requestSkillUp(keys[i]);
      }
    }

    if (authority) {
      this.updateEnemies(dt);
      this.updateProjs(dt);
      this.updateSatoru(dt);
      this.updateMounts(dt);
      this.updateSpin(dt);
      this.updateClones(dt);
      this.updateDragons(dt);

      // сферы здоровья
      for (let i = this.orbs.length - 1; i >= 0; i--) {
        const o = this.orbs[i];
        o.t += dt;
        const np = this.nearestPlayer(o.x, o.y);
        if (!np) continue;
        const d = Math.hypot(o.x - np.x, o.y - np.y);
        if (d < 110 && d > 1) { o.x += (np.x - o.x) / d * 300 * dt; o.y += (np.y - o.y) / d * 300 * dt; }
        if (d < 26) {
          np.hp = Math.min(np.maxHp, np.hp + o.heal);
          if (np.isLocal) {
            this.floaters.push({ x: np.x, y: np.y - 30, text: `+${o.heal}`, color: "#5ee87a", life: 0.9 });
            this.audio.sfx("pickup");
          }
          this.orbs.splice(i, 1);
        } else if (o.t > 20) this.orbs.splice(i, 1);
      }

      // золото и лут: магнитятся к ближайшему игроку
      for (let i = this.golds.length - 1; i >= 0; i--) {
        const g = this.golds[i]; g.t += dt;
        const np = this.nearestPlayer(g.x, g.y);
        if (np) {
          const d = Math.hypot(g.x - np.x, g.y - np.y);
          if (d < 130 && d > 1) { g.x += ((np.x - g.x) / d) * 340 * dt; g.y += ((np.y - g.y) / d) * 340 * dt; }
          if (d < 26) {
            np.gold += g.v;
            if (np.isLocal) { this.floaters.push({ x: np.x, y: np.y - 44, text: `+${g.v} золота`, color: "#ffd24a", life: 0.8 }); this.audio.sfx("pickup"); }
            this.golds.splice(i, 1); continue;
          }
        }
        if (g.t > 25) this.golds.splice(i, 1);
      }
      for (let i = this.loots.length - 1; i >= 0; i--) {
        const l = this.loots[i]; l.t += dt;
        const np = this.nearestPlayer(l.x, l.y);
        if (np) {
          const d = Math.hypot(l.x - np.x, l.y - np.y);
          if (d < 110 && d > 1) { l.x += ((np.x - l.x) / d) * 280 * dt; l.y += ((np.y - l.y) / d) * 280 * dt; }
          if (d < 28) { this.applyLoot(np, l.kind); this.loots.splice(i, 1); continue; }
        }
        if (l.t > 30) this.loots.splice(i, 1);
      }

      // телеграфы: красная зона зарядки, затем взрыв
      for (let i = this.telegraphs.length - 1; i >= 0; i--) {
        const tg = this.telegraphs[i];
        tg.t -= dt;
        if (tg.t > 0) continue;
        this.telegraphs.splice(i, 1);
        for (const p of this.players) {
          if (p.alive && Math.hypot(p.x - tg.x, p.y - tg.y) < tg.r) this.hurtPlayer(p, tg.dmg);
        }
        if (tg.kind === "meteor") {
          // метеорит бьёт и по врагам — хаос на поле боя
          for (const e of [...this.enemies]) {
            if (e.charmT <= 0 && Math.hypot(e.x - tg.x, e.y - tg.y) < tg.r) {
              this.damageEnemy(e, 260, (e.x - tg.x) * 2, (e.y - tg.y) * 2, undefined);
            }
          }
        }
        this.spawnWave(tg.x, tg.y, tg.r * 1.5, tg.kind === "meteor" ? "#ff8a3c" : "#e83c3c", 0, 30, 0.5);
        this.spawnParticles(tg.x, tg.y, 36, tg.kind === "meteor" ? "#ff8a3c" : "#e83c3c", 380);
        this.decals.push({ x: tg.x, y: tg.y, r: tg.r * 0.5, color: "#181008", alpha: 0.6 });
        this.addLight(tg.x, tg.y, tg.r * 2.2, 0.35);
        this.shake = Math.min(20, this.shake + 8);
        this.audio.sfx("explosion");
      }

      // катаклизм: метеоритный дождь в боевой фазе
      this.meteorT -= dt;
      if (this.meteorT <= 0) {
        this.meteorT = Math.max(7, 15 - this.wave * 0.5);
        if (this.waveState === "fight") {
          const alivePl = this.players.filter((p) => p.alive);
          const tgt2 = alivePl[Math.floor(Math.random() * Math.max(1, alivePl.length))];
          if (tgt2) {
            const ma = Math.random() * Math.PI * 2, md = 60 + Math.random() * 240;
            const mx = Math.max(80, Math.min(WORLD_SIZE - 80, tgt2.x + Math.cos(ma) * md));
            const my = Math.max(80, Math.min(WORLD_SIZE - 80, tgt2.y + Math.sin(ma) * md));
            this.telegraphs.push({ x: mx, y: my, r: 120, t: 1.6, maxT: 1.6, dmg: 26 * this.dmgMulE, kind: "meteor" });
            if (!this.meteorAnnounced) {
              this.meteorAnnounced = true;
              this.announce("КАТАКЛИЗМ: МЕТЕОРИТЫ", "не стой в красных кругах!");
              if (coop) this.net?.sendEv({ t: "ann", x: "КАТАКЛИЗМ: МЕТЕОРИТЫ", s: "не стой в красных кругах!" });
            }
          }
        }
      }

      // уровни игроков
      for (const p of this.players) {
        if (p.xp < p.xpNext) continue;
        p.xp -= p.xpNext;
        p.level++;
        p.xpNext = Math.floor(XP_BASE * Math.pow(p.level, 1.32));
        p.dmgMul *= 1.22;
        p.maxHp += 15;
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.35);
        p.skillPts++;
        this.spawnParticles(p.x, p.y, 40, "#ffd24a", 320);
        this.spawnWave(p.x, p.y, 200, "#ffd24a", 0, 18, 0.5);
        this.addLight(p.x, p.y, 300, 0.4);
        if (p.isLocal) {
          this.announce(`УРОВЕНЬ ${p.level}!`, p.level === ULT_UNLOCK_LEVEL ? "УЛЬТИМЕЙТ ДОСТУПЕН — вложи очко (клавиша 4)!" : "+1 очко навыка — прокачка клавишами 1-4");
          this.audio.sfx("win");
        } else if (coop) {
          this.net?.sendEv({ t: "ann", x: `${p.hero.name} — УРОВЕНЬ ${p.level}!`, s: "" });
          this.net?.sendEv({ t: "castfx", h: p.hero.id, k: "lvl", x: p.x, y: p.y, dir: 0 });
        }
      }

      // смерти игроков
      for (const p of this.players) {
        if (p.alive && p.hp <= 0) {
          p.alive = false;
          p.deadX = p.x; p.deadY = p.y; p.reviveProg = 0;
          if (p.isLocal) { this.announce("ВЫ ПАЛИ", this.players.some((q) => q.alive) ? "команда сражается дальше" : ""); this.audio.sfx("lose"); }
          else this.net?.sendEv({ t: "ann", x: `${p.hero.name} ПАЛ`, s: "" });
        }
      }
      // воскрешение: живой союзник рядом с павшим 2.5 с возвращает его в бой
      for (const p of this.players) {
        if (p.alive) continue;
        const near = this.players.some((q) => q.alive && Math.hypot(q.x - p.deadX, q.y - p.deadY) < 90);
        p.reviveProg = Math.max(0, Math.min(1, p.reviveProg + (near ? dt / 2.5 : -dt / 5)));
        if (p.reviveProg >= 1) {
          p.alive = true; p.hp = p.maxHp * 0.5; p.reviveProg = 0;
          p.x = p.deadX; p.y = p.deadY; p.tx = p.x; p.ty = p.y;
          this.spawnWave(p.x, p.y, 180, "#7ee87a", 0, 20, 0.5);
          this.addLight(p.x, p.y, 260, 0.4);
          this.announce(`${p.hero.name} ВОСКРЕС`, "союзник вернул его в бой!");
          if (coop) this.net?.sendEv({ t: "ann", x: `${p.hero.name} ВОСКРЕС`, s: "союзник вернул его в бой!" });
          this.audio.sfx("win");
        }
      }
      if (this.players.length > 0 && this.players.every((p) => !p.alive)) { this.gameOver(); return; }

      // рассылка состояния клиентам
      if (coop) {
        this.netSendT -= dt;
        if (this.netSendT <= 0) { this.netSendT = 0.1; this.sendSnap(); }
      }
    } else {
      // клиент: интерполяция мира из снапшотов + отправка своего ввода
      this.updateClientEntities(dt);
      this.netSendT -= dt;
      if (this.netSendT <= 0 && this.net && this.hostPeerId) {
        this.netSendT = 0.066;
        this.net.sendInp({ x: Math.round(this.px), y: Math.round(this.py), fx: +this.facing.toFixed(2), wk: +this.walkPhase.toFixed(2), mv: this.me.moving }, this.hostPeerId);
      }
    }

    this.updateFx(dt);

    this.shake *= Math.pow(0.001, dt);
    if (this.netMode === "off" && this.hp <= 0) this.gameOver();
  }

  /** Движение локального игрока: инерция, дэш, прыжок Даши, маунты, границы мира. */
  private updateLocalMovement(dt: number): void {
    // сейсмический прыжок Даши: дуга к точке прицела, приземление — взрывные волны
    if (this.me.leapT > 0) {
      this.me.leapT -= dt;
      const t = 1 - Math.max(0, this.me.leapT / 0.38);
      this.px = this.me.leapFromX + (this.me.leapToX - this.me.leapFromX) * t;
      this.py = this.me.leapFromY + (this.me.leapToY - this.me.leapFromY) * t;
      this.walkPhase += dt * 2;
      this.me.moving = true;
      if (this.me.leapT <= 0 && this.netMode !== "client") this.leapLand(this.me);
      this.px = Math.max(40, Math.min(WORLD_SIZE - 40, this.px));
      this.py = Math.max(40, Math.min(WORLD_SIZE - 40, this.py));
      return;
    }
    let sp = this.hero.speed * (1 + 0.1 * this.me.buys[3]);
    if (this.speedBuffT > 0) sp *= 1.25;
    if (this.mountT > 0) sp *= 1.35;
    if (this.rageT > 0) sp *= 1.4;
    if (this.spinT > 0) sp *= 0.5;
    let moving = false;
    if (this.dashT > 0) {
      this.dashT -= dt;
      moving = true;
      this.me.trail.push({ x: this.px, y: this.py, life: 0.35 });
      if (this.me.trail.length > 40) this.me.trail.shift();
      const dsp = this.hero.id === "maxim" ? 1050 : this.hero.id === "nikita" ? 1400 : 820;
      this.px += this.dashDx * dsp * dt;
      this.py += this.dashDy * dsp * dt;
      this.pvx = this.dashDx * dsp; this.pvy = this.dashDy * dsp;
      if (this.dashDmgMul > 0 && this.netMode !== "client") {
        for (const e of this.enemies) {
          if (this.dashHits.has(e)) continue;
          const d = Math.hypot(e.x - this.px, e.y - this.py);
          if (d < e.radius + 34) {
            this.dashHits.add(e);
            this.damageEnemy(e, this.basicDmg(this.me) * this.dashDmgMul, this.dashDx * 340, this.dashDy * 340, this.me);
          }
        }
      }
      if (this.hero.id === "maxim") this.spawnParticles(this.px, this.py, 2, "#9fd8ff", 120);
      if (this.hero.id === "nikita") {
        // ледяной след под коньками
        this.decals.push({ x: this.px, y: this.py + 10, r: 16, color: "#9fd4f0", alpha: 0.35 });
        if (this.decals.length > 250) this.decals.shift();
        this.spawnParticles(this.px, this.py, 2, "#cfeaff", 100);
      }
    } else {
      const ix = this.input.moveX, iz = this.input.moveZ;
      const len = Math.hypot(ix, iz) || 1;
      const want = Math.abs(ix) + Math.abs(iz) > 0;
      const tx = (ix / len) * sp * (want ? 1 : 0);
      const ty = (-iz / len) * sp * (want ? 1 : 0);
      // инерция: разгон и торможение занимают ~0.09 секунды
      const k = Math.min(1, dt * 14);
      this.pvx += (tx - this.pvx) * k;
      this.pvy += (ty - this.pvy) * k;
      this.px += this.pvx * dt;
      this.py += this.pvy * dt;
      moving = want || Math.hypot(this.pvx, this.pvy) > 14;
    }
    // темп шага привязан к реальной скорости: на разгоне шаг медленный, ноги не скользят
    const spdK = Math.min(1.3, Math.hypot(this.pvx, this.pvy) / Math.max(1, sp));
    if (moving) this.walkPhase += dt * (this.dashT > 0 ? 2.2 : 0.35 + 0.75 * spdK);
    this.me.moving = moving;
    this.px = Math.max(40, Math.min(WORLD_SIZE - 40, this.px));
    this.py = Math.max(40, Math.min(WORLD_SIZE - 40, this.py));
  }

  /** Локальная попытка каста: на клиенте уходит хосту, иначе исполняется сразу. */
  /** Враг под курсором (для ближней атаки ЛКМ, как в Diablo 3). */
  private hoveredEnemy(): Enemy | null {
    let best: Enemy | null = null, bd = Infinity;
    for (const e of this.enemies) {
      if (e.charmT > 0) continue;
      const d = Math.hypot(e.x - this.aimX, e.y - this.aimY);
      if (d < e.radius + 18 && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  private tryCast(k: "basic" | "q" | "e" | "r" | "t" | "f"): void {
    // ближняя атака Никиты: бьёт только по наведённому врагу и разворачивается точно к нему
    if (k === "basic" && this.hero.id === "nikita") {
      const he = this.hoveredEnemy();
      if (!he) return;
      this.facing = Math.atan2(he.y - this.py, he.x - this.px);
    }
    if (k === "t" && this.me.sk.t === 0) {
      this.floaters.push({ x: this.px, y: this.py - 34, text: this.me.level < ULT_UNLOCK_LEVEL ? `УЛЬТ ОТКРОЕТСЯ НА ${ULT_UNLOCK_LEVEL} УРОВНЕ` : "ВЛОЖИ ОЧКО В УЛЬТ — КЛАВИША 4", color: "#ff9a5a", life: 1.2 });
      return;
    }
    if (this.netMode === "client") {
      if (!this.net || !this.hostPeerId) return;
      const cost = { basic: 0, q: 30, e: 25, r: 60, t: 80, f: 0 }[k];
      if (this.mana < cost) {
        this.floaters.push({ x: this.px, y: this.py - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
        return;
      }
      this.net.sendCast({ k, dir: this.facing }, this.hostPeerId);
      this.swingT = 0.18; // мгновенный отклик анимации; урон посчитает хост
      // оптимистичный кулдаун — снапшот хоста поправит
      if (k === "basic") this.cdBasic = 0.25;
      else if (k === "q") this.cdQ = this.effCd(this.me, "q");
      else if (k === "e") this.cdE = this.effCd(this.me, "e");
      else if (k === "r") this.cdR = this.effCd(this.me, "r");
      else if (k === "t") this.cdT = this.effCd(this.me, "t");
      else this.cdF = SATORU.cooldown;
      // предсказание движения для рывков/прыжков (позиция — наша, клиентская)
      if (k === "q" && this.hero.id === "nikita") {
        this.dashT = 0.5; this.dashDx = Math.cos(this.facing); this.dashDy = Math.sin(this.facing);
        this.dashDmgMul = 0; // урон начислит хост
      }
      if (k === "t" && this.hero.id === "dasha") {
        const dist = 380;
        this.me.leapT = 0.38;
        this.me.leapFromX = this.px; this.me.leapFromY = this.py;
        this.me.leapToX = Math.max(40, Math.min(WORLD_SIZE - 40, this.px + Math.cos(this.facing) * dist));
        this.me.leapToY = Math.max(40, Math.min(WORLD_SIZE - 40, this.py + Math.sin(this.facing) * dist));
      }
      return;
    }
    this.executeCast(this.me, k, this.facing);
  }

  /** Выполнение способности игрока p (на хосте/в соло). */
  private executeCast(p: PlayerEnt, k: string, dir: number): void {
    const before = { q: p.cdQ, e: p.cdE, r: p.cdR, t: p.cdT, f: p.cdF };
    if (k === "basic") this.basicAttack(p, dir);
    else if (k === "q") this.castQ(p, dir);
    else if (k === "e") this.castE(p, dir);
    else if (k === "r") this.castR(p, dir);
    else if (k === "t") { if (p.sk.t > 0) this.castUlt(p, dir); }
    else if (k === "f") this.castSatoru(p);
    // визуал для остальных клиентов
    if (this.netMode === "host" && k !== "basic") {
      const fired = (k === "q" && p.cdQ !== before.q) || (k === "e" && p.cdE !== before.e)
        || (k === "r" && p.cdR !== before.r) || (k === "t" && p.cdT !== before.t) || (k === "f" && p.cdF !== before.f);
      if (fired) this.net?.sendEv({ t: "castfx", h: p.hero.id, k, x: p.x, y: p.y, dir });
    }
  }

  /** Экран выбора героя: соло, создание лобби, вход по коду. */
  private updateSelect(): void {
    if (this.selScreen === "join") {
      // важен порядок нажатий: две буквы в одном кадре не должны переставляться
      for (const code of this.input.drainPresses()) {
        if (/^Key[A-Z]$/.test(code) && this.joinCode.length < 5) { this.joinCode += code[3]; this.audio.sfx("ui"); }
        else if (/^Digit[0-9]$/.test(code) && this.joinCode.length < 5) { this.joinCode += code[5]; this.audio.sfx("ui"); }
        else if (code === "Backspace") { this.joinCode = this.joinCode.slice(0, -1); this.audio.sfx("ui"); }
        else if (code === "Escape") { this.selScreen = "heroes"; this.lobbyError = ""; this.audio.sfx("ui"); }
        else if ((code === "Enter" || code === "NumpadEnter") && this.joinCode.length === 5) this.joinLobby(this.joinCode);
      }
      return;
    }
    for (let i = 0; i < HEROES.length; i++) {
      if (this.input.consumeAction(`Digit${i + 1}`)) { this.selIndex = i; this.audio.sfx("ui"); }
    }
    if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
      this.audio.sfx("ui");
      this.netMode = "off";
      this.startRun(HEROES[this.selIndex]);
    }
    if (this.input.consumeAction("KeyC")) { this.createLobby(); }
    if (this.input.consumeAction("KeyJ")) { this.selScreen = "join"; this.joinCode = ""; this.lobbyError = ""; this.input.drainPresses(); this.audio.sfx("ui"); }
  }

  /** Множитель урона навыка: +18% за уровень, +15% за Фолиант чар, ×1.5 под берсерком. */
  private skillAmp(p: PlayerEnt, k: "q" | "e" | "r" | "t"): number {
    return (1 + 0.18 * Math.max(0, p.sk[k] - 1)) * (1 + 0.15 * p.buys[2]) * (p.berserkT > 0 ? 1.5 : 1);
  }

  /** Эффективная перезарядка: −5% за уровень навыка, −10% за Песочные часы; Перчатка рапиры — без перезарядки. */
  private effCd(p: PlayerEnt, k: "q" | "e" | "r" | "t"): number {
    if (p.cdRushT > 0) return 0.05;
    const base = k === "t" ? p.hero.ult.cooldown : p.hero[k].cooldown;
    const lvl = Math.max(1, p.sk[k]);
    return Math.max(base * 0.35, base * (1 - 0.05 * (lvl - 1)) * Math.pow(0.9, p.buys[4]));
  }

  /** Прокачка навыка очком (как в Dota 2): макс. 10 уровней, ульт — с 6 уровня героя. */
  private upgradeSkill(p: PlayerEnt, k: "q" | "e" | "r" | "t"): void {
    if (p.skillPts <= 0 || p.sk[k] >= SKILL_MAX) return;
    if (k === "t" && p.level < ULT_UNLOCK_LEVEL) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 40, text: `УЛЬТ С ${ULT_UNLOCK_LEVEL} УРОВНЯ`, color: "#ff9a5a", life: 1.2 });
      return;
    }
    p.skillPts--; p.sk[k]++;
    const name = k === "t" ? p.hero.ult.name : p.hero[k].name;
    if (p.isLocal) {
      this.floaters.push({ x: p.x, y: p.y - 40, text: `${name} → ур. ${p.sk[k]}`, color: "#ffd24a", life: 1.2 });
      this.audio.sfx("win");
    }
    if (this.netMode === "host" && !p.isLocal) this.net?.sendEv({ t: "ann", x: `${p.hero.name}: ${name} — ур. ${p.sk[k]}`, s: "" });
  }

  /** Запрос на прокачку: локально (соло/хост) или пакетом хосту. */
  private requestSkillUp(k: "q" | "e" | "r" | "t"): void {
    if (this.netMode === "client") {
      if (this.net && this.hostPeerId) this.net.sendReq({ k: "skillup", v: { q: 0, e: 1, r: 2, t: 3 }[k] }, this.hostPeerId);
      return;
    }
    this.upgradeSkill(this.me, k);
  }

  /** Покупка в магазине: локально (соло/хост) или запросом хосту. */
  private requestBuy(i: number): void {
    if (this.netMode === "client") {
      if (this.net && this.hostPeerId) this.net.sendReq({ k: "buy", v: i }, this.hostPeerId);
      return;
    }
    this.buyItem(this.me, i);
  }

  private buyItem(p: PlayerEnt, i: number): void {
    if (i < 0 || i >= SHOP.length) return;
    const price = shopPrice(i, p.buys[i]);
    if (p.gold < price) {
      if (p.isLocal) { this.floaters.push({ x: p.x, y: p.y - 40, text: "НЕ ХВАТАЕТ ЗОЛОТА", color: "#e84a4a", life: 1 }); this.audio.sfx("hit"); }
      return;
    }
    p.gold -= price; p.buys[i]++;
    if (i === 0) { p.maxHp += 40; p.hp = p.maxHp; }
    const msg = `${p.hero.name}: ${SHOP[i].name} ×${p.buys[i]}`;
    if (this.netMode === "host") this.net?.sendEv({ t: "ann", x: msg, s: SHOP[i].desc });
    if (p.isLocal) { this.announce(msg, SHOP[i].desc); this.audio.sfx("win"); }
  }

  /** Применение подобранного лута. */
  private applyLoot(p: PlayerEnt, kind: LootKind): void {
    const def = LOOT[kind];
    if (kind === "rush") p.cdRushT = 15;
    else if (kind === "berserk") p.berserkT = 12;
    else if (kind === "aegis") p.invulnT = 5;
    else p.mana = p.maxMana;
    this.floaters.push({ x: p.x, y: p.y - 50, text: `${def.name}: ${def.desc}`, color: def.color, life: 1.4 });
    this.spawnWave(p.x, p.y, 120, def.color, 0, 14, 0.4);
    if (p.isLocal) this.audio.sfx("win");
    if (this.netMode === "host" && !p.isLocal) this.net?.sendEv({ t: "ann", x: `${p.hero.name} поднял: ${def.name}`, s: def.desc });
  }

  private basicDmg(p: PlayerEnt): number {
    const base = { nikita: 40, maxim: 18, dasha: 9, vika: 18 }[p.hero.id];
    return base * p.dmgMul * (1 + 0.15 * p.buys[1]) * (p.berserkT > 0 ? 1.5 : 1) * (p.hero.id === "nikita" && p.rageT > 0 ? 1.8 : 1);
  }

  /** Урон конусом перед игроком: Катон, Инсендио, конусный замах. */
  private coneHit(p: PlayerEnt, dir: number, range: number, half: number, dmgMul: number, knock: number, color: string, burnDmg = 0): void {
    let hits = 0;
    for (const e of this.enemies) {
      if (e.charmT > 0) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d > range + e.radius) continue;
      const ang = Math.atan2(e.y - p.y, e.x - p.x);
      let diff = ang - dir;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) < half) {
        this.damageEnemy(e, this.basicDmg(p) * dmgMul, Math.cos(ang) * knock, Math.sin(ang) * knock, p);
        if (burnDmg > 0) { e.burnT = 3; e.burnDmg = burnDmg; e.burnAcc = 0; e.burnOwner = p; }
        hits++;
      }
    }
    this.cones.push({ x: p.x, y: p.y, dir, half, range, life: 0.28, maxLife: 0.28, color });
    if (hits > 0) this.addLight(p.x + Math.cos(dir) * range * 0.5, p.y + Math.sin(dir) * range * 0.5, range, 0.3);
  }

  /** Ближайший живой игрок к точке (цель для врагов и сфер). */
  private nearestPlayer(x: number, y: number): PlayerEnt | null {
    let best: PlayerEnt | null = null;
    let bd = Infinity;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private basicAttack(p: PlayerEnt, dir: number): void {
    if (p.hero.id === "nikita") {
      p.cdBasic = 0.55 * (p.rageT > 0 ? 0.6 : 1);
      p.swingT = 0.2;
      let hit = false;
      for (const e of this.enemies) {
        if (e.charmT > 0) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        const ang = Math.atan2(e.y - p.y, e.x - p.x);
        let diff = ang - dir;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (d < 115 + e.radius && Math.abs(diff) < 1.1) {
          this.damageEnemy(e, this.basicDmg(p), Math.cos(ang) * 260, Math.sin(ang) * 260, p);
          hit = true;
        }
      }
      if (p.isLocal) this.audio.sfx(hit ? "hit" : "move");
    } else {
      const spec = {
        maxim: { sp: 640, r: 10, cd: 0.4, color: "#8fd0ff", kind: "chakra" },
        dasha: { sp: 980, r: 4, cd: 0.14, color: "#ffd24a", kind: "bullet" },
        vika: { sp: 660, r: 8, cd: 0.38, color: "#b58cff", kind: "bolt" },
      }[p.hero.id];
      p.cdBasic = spec.cd;
      p.swingT = 0.15; // взмах рукой при броске/выстреле/касте
      this.projs.push({
        x: p.x + Math.cos(dir) * 26, y: p.y + Math.sin(dir) * 26,
        vx: Math.cos(dir) * spec.sp, vy: Math.sin(dir) * spec.sp,
        dmg: this.basicDmg(p), r: spec.r, friendly: true, pierce: false,
        life: 0.9, color: spec.color, kind: spec.kind, disarm: false, hitSet: null, owner: p,
      });
      if (p.isLocal) this.audio.sfx("move");
    }
  }

  private castQ(p: PlayerEnt, dir: number): void {
    if (p.mana < 30) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    p.mana -= 30;
    if (p.hero.id === "nikita") {
      // Ледяной прорыв: долгий рывок на коньках сквозь толпу
      p.cdQ = this.effCd(p, "q");
      p.dashT = 0.5; p.dashDx = Math.cos(dir); p.dashDy = Math.sin(dir);
      p.dashDmgMul = 2.5 * this.skillAmp(p, "q"); p.dashHits = new Set();
      p.swingT = 0.2;
      this.audio.sfx("explosion");
    } else if (p.hero.id === "maxim") {
      // Катон: огненный конус с поджогом
      p.cdQ = this.effCd(p, "q");
      p.swingT = 0.25;
      this.coneHit(p, dir, 270, 0.62, 2.8 * this.skillAmp(p, "q"), 200, "#ff7a3c", this.basicDmg(p) * 0.7 * this.skillAmp(p, "q"));
      this.spawnParticles(p.x + Math.cos(dir) * 90, p.y + Math.sin(dir) * 90, 22, "#ff9a3c", 300);
      this.audio.sfx("explosion");
    } else if (p.hero.id === "dasha") {
      // Дробовик: 8 дробин широким конусом
      p.cdQ = this.effCd(p, "q");
      p.swingT = 0.2;
      for (let i = 0; i < 8; i++) {
        const a = dir + (Math.random() - 0.5) * 0.9;
        this.projs.push({
          x: p.x + Math.cos(a) * 26, y: p.y + Math.sin(a) * 26,
          vx: Math.cos(a) * 820, vy: Math.sin(a) * 820,
          dmg: this.basicDmg(p) * 0.9 * this.skillAmp(p, "q"), r: 5, friendly: true, pierce: false,
          life: 0.34, color: "#ffb02e", kind: "bullet", disarm: false, hitSet: null, owner: p,
        });
      }
      this.cones.push({ x: p.x, y: p.y, dir, half: 0.5, range: 120, life: 0.18, maxLife: 0.18, color: "#ffd24a" });
      this.shake = Math.min(14, this.shake + 5);
      this.audio.sfx("hit");
    } else {
      // Империус: ближайший к прицелу враг (не босс) переходит на сторону героев
      const aimX = p.x + Math.cos(dir) * 320, aimY = p.y + Math.sin(dir) * 320;
      let target: Enemy | null = null;
      let bd = 200;
      for (const e of this.enemies) {
        if (e.boss || e.charmT > 0) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) > 430) continue;
        const d = Math.hypot(e.x - aimX, e.y - aimY);
        if (d < bd) { bd = d; target = e; }
      }
      if (!target) {
        if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 34, text: "НЕТ ЦЕЛИ", color: "#b58cff", life: 0.7 });
        p.mana += 30; // не тратим ману впустую
        return;
      }
      p.cdQ = this.effCd(p, "q");
      p.swingT = 0.25;
      target.charmT = 8 + 0.5 * (p.sk.q - 1);
      target.charmOwner = p;
      target.windup = 0;
      this.spawnParticles(target.x, target.y - 20, 20, "#3ddc84", 220);
      this.spawnWave(target.x, target.y, 90, "#3ddc84", 0, 14, 0.4);
      this.floaters.push({ x: target.x, y: target.y - 40, text: "ИМПЕРИУС!", color: "#3ddc84", life: 1 });
      this.audio.sfx("win");
    }
  }

  private castE(p: PlayerEnt, dir: number): void {
    if (p.mana < 25) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    p.mana -= 25;
    if (p.hero.id === "nikita") {
      // Конусный замах клюшкой
      p.cdE = this.effCd(p, "e");
      p.swingT = 0.28;
      this.coneHit(p, dir, 185, 0.75, 3.0 * this.skillAmp(p, "e"), 520, "#cfeaff");
      this.shake = Math.min(14, this.shake + 6);
      this.audio.sfx("hit");
    } else if (p.hero.id === "maxim") {
      // Призыв: жаба — маунт-давилка (дольше с уровнем навыка)
      p.cdE = this.effCd(p, "e");
      p.mountT = 10 + 0.4 * (p.sk.e - 1); p.mountDmgT = 0;
      this.spawnWave(p.x, p.y, 160, "#7ab54a", 0, 20, 0.5);
      this.addLight(p.x, p.y, 240, 0.3);
      this.audio.sfx("explosion");
    } else if (p.hero.id === "dasha") {
      // Крутящийся стрелок: 6 секунд огня во все стороны
      p.cdE = this.effCd(p, "e");
      p.spinT = 6 + 0.3 * (p.sk.e - 1); p.spinAng = dir; p.spinFireT = 0;
      this.audio.sfx("hit");
    } else {
      // Инсендио: конус пламени из палочки
      p.cdE = this.effCd(p, "e");
      p.swingT = 0.25;
      this.coneHit(p, dir, 250, 0.55, 2.6 * this.skillAmp(p, "e"), 160, "#ff9a3c", this.basicDmg(p) * 0.6 * this.skillAmp(p, "e"));
      this.spawnParticles(p.x + Math.cos(dir) * 80, p.y + Math.sin(dir) * 80, 20, "#ff8a3c", 280);
      this.audio.sfx("explosion");
    }
  }

  private castR(p: PlayerEnt, dir: number): void {
    if (p.mana < 60) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    p.mana -= 60;
    p.cdR = this.effCd(p, "r");
    p.swingT = 0.3;
    if (p.hero.id === "nikita" || p.hero.id === "dasha" || p.hero.id === "vika") {
      // Замбони / Бэтмобиль / Гиппогриф: маунт-давилка (дольше с уровнем навыка)
      p.mountT = 10 + 0.4 * (p.sk.r - 1); p.mountDmgT = 0;
      const color = { nikita: "#7ec8ff", dasha: "#3a3a42", vika: "#c9b18a" }[p.hero.id];
      this.spawnWave(p.x, p.y, 180, color, 0, 22, 0.5);
      this.addLight(p.x, p.y, 300, 0.35);
      this.audio.sfx("explosion");
    } else {
      // Теневой клон Максима
      this.clones.push({
        x: p.x + Math.cos(dir + 1.6) * 60, y: p.y + Math.sin(dir + 1.6) * 60,
        t: 12 + 0.5 * (p.sk.r - 1), shootT: 0.3, walk: 0, owner: p, nid: this.nidSeq++,
      });
      this.spawnParticles(p.x, p.y, 30, "#9fd8ff", 300);
      this.addLight(p.x, p.y, 260, 0.3);
      this.audio.sfx("win");
    }
    void dir;
  }

  /** Ультимейт героя (клавиша T). */
  private castUlt(p: PlayerEnt, dir: number): void {
    if (p.mana < 80) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    p.mana -= 80;
    p.cdT = this.effCd(p, "t");
    p.swingT = 0.35;
    if (p.hero.id === "nikita") {
      // ЯРОСТЬ ХОККЕИСТА: сила, скорость, темп атаки, размер
      p.rageT = 10 + 0.5 * (p.sk.t - 1);
      this.spawnWave(p.x, p.y, 260, "#ff5a3c", 0, 26, 0.6);
      this.spawnParticles(p.x, p.y, 36, "#ff8a5a", 340);
      this.addLight(p.x, p.y, 360, 0.5);
      this.shake = Math.min(18, this.shake + 10);
      if (p.isLocal) this.announce("ЯРОСТЬ ХОККЕИСТА!", "10 секунд неудержимой силы");
      this.audio.sfx("explosion");
    } else if (p.hero.id === "maxim") {
      // Большой расенган: гигантская сфера в прицел
      this.projs.push({
        x: p.x + Math.cos(dir) * 44, y: p.y + Math.sin(dir) * 44,
        vx: Math.cos(dir) * 700, vy: Math.sin(dir) * 700,
        dmg: this.basicDmg(p) * 2.2 * this.skillAmp(p, "t"), r: 34, friendly: true, pierce: true,
        life: 0.95, color: "#7ec8ff", kind: "rasenshuriken", disarm: false, hitSet: new Set(), owner: p,
      });
      this.addLight(p.x, p.y, 300, 0.3);
      this.audio.sfx("explosion");
    } else if (p.hero.id === "dasha") {
      // Сейсмический прыжок в точку прицела
      const dist = Math.min(380, Math.hypot(Math.cos(dir) * 400, Math.sin(dir) * 400));
      p.leapT = 0.38;
      p.leapFromX = p.x; p.leapFromY = p.y;
      p.leapToX = Math.max(40, Math.min(WORLD_SIZE - 40, p.x + Math.cos(dir) * dist));
      p.leapToY = Math.max(40, Math.min(WORLD_SIZE - 40, p.y + Math.sin(dir) * dist));
      p.iframes = 0.6;
      this.audio.sfx("hit");
    } else {
      // Огненный дракон: 5 секунд летает и испепеляет
      this.dragons.push({ x: p.x, y: p.y, t: 5 + 0.3 * (p.sk.t - 1), ang: 0, tickT: 0, owner: p });
      if (p.isLocal) this.announce("ОГНЕННЫЙ ДРАКОН!", "летит испепелять врагов");
      this.addLight(p.x, p.y, 400, 0.6);
      this.audio.sfx("explosion");
    }
  }

  /** Приземление Даши после сейсмического прыжка: три взрывные волны. */
  private leapLand(p: PlayerEnt): void {
    this.spawnWave(p.x, p.y, 300, "#ffd24a", this.basicDmg(p) * 4 * this.skillAmp(p, "t"), 34, 0.55, p);
    this.spawnWave(p.x, p.y, 200, "#ffb02e", this.basicDmg(p) * 2 * this.skillAmp(p, "t"), 22, 0.4, p);
    this.spawnWave(p.x, p.y, 120, "#ffffff", 0, 14, 0.3);
    this.spawnParticles(p.x, p.y, 40, "#ffd24a", 400);
    this.addLight(p.x, p.y, 420, 0.5);
    this.shake = Math.min(22, this.shake + 14);
    this.audio.sfx("explosion");
    if (this.netMode === "host") this.net?.sendEv({ t: "boom", x: p.x, y: p.y });
  }

  private castSatoru(p: PlayerEnt): void {
    p.cdF = SATORU.cooldown;
    this.satorus = this.satorus.filter((s) => s.pid !== p.pid);
    this.satorus.push({ x: p.x - 60, y: p.y - 60, life: SATORU_DURATION, swipeCd: 0, pid: p.pid });
    if (p.isLocal) {
      this.announce("САТОРУ В ДЕЛЕ!", "кот пришёл на помощь");
    } else if (this.netMode === "host") {
      this.net?.sendEv({ t: "ann", x: "САТОРУ В ДЕЛЕ!", s: `кот ${p.hero.name} пришёл на помощь` });
    }
    this.spawnParticles(p.x, p.y - 40, 24, "#e8e8e8", 240);
    this.audio.sfx("win");
  }

  /** Ударная волна: зрелищное кольцо; при dmg > 0 бьёт каждого врага один раз. */
  private spawnWave(x: number, y: number, maxR: number, color: string, dmg = 0, width = 26, dur = 0.45, owner?: PlayerEnt): void {
    this.waves.push({ x, y, r: 10, maxR, life: dur, maxLife: dur, color, dmg, width, hitSet: dmg > 0 ? new Set() : null, owner });
  }

  /** Вспышка света на слое освещения (взрывы, заклинания). */
  private addLight(x: number, y: number, r: number, life = 0.25): void {
    if (this.tempLights.length < 12) this.tempLights.push({ x, y, r, life, maxLife: life });
  }

  // ---------- враги ----------

  /** Начать волну n: состав, скейлинг, босс каждую третью волну. */
  private startWave(n2: number, coop: boolean): void {
    this.wave = n2;
    this.hpMul = 1 + (n2 - 1) * 0.16;
    this.dmgMulE = 1 + (n2 - 1) * 0.10;
    this.waveState = "fight";
    this.spawnT = 0.5;
    const base = 8 + n2 * 4 + (coop ? (this.players.length - 1) * 4 : 0);
    this.waveSpawnLeft = base;
    const bossWave = n2 % 3 === 0;
    if (bossWave) this.spawnEnemy(true);
    const sub = bossWave ? "БОСС-ВОЛНА — держитесь!" : `врагов: ${base}`;
    this.announce(`ВОЛНА ${n2}`, sub);
    if (coop) this.net?.sendEv({ t: "ann", x: `ВОЛНА ${n2}`, s: sub });
    this.audio.sfx("ui");
  }

  private spawnEnemy(boss: boolean): void {
    const anchor = this.players.filter((p) => p.alive)[Math.floor(Math.random() * Math.max(1, this.players.filter((p) => p.alive).length))] ?? this.me;
    const ang = Math.random() * Math.PI * 2;
    const dist = boss ? 600 : 560 + Math.random() * 320;
    const x = Math.max(60, Math.min(WORLD_SIZE - 60, anchor.x + Math.cos(ang) * dist));
    const y = Math.max(60, Math.min(WORLD_SIZE - 60, anchor.y + Math.sin(ang) * dist));
    const pool = this.map === COOP_MAP ? ALL_ENEMY_KINDS : this.map.enemies;
    const kind = pool[Math.floor(Math.random() * pool.length)];
    if (boss) {
      let name = this.map.bossName;
      let color = this.map.bossColor;
      let sprite = this.enemySpriteId();
      if (this.map === COOP_MAP) {
        // кооп на общей арене: боссы со всех карт выходят по очереди
        const cb = COOP_BOSSES[Math.floor((this.wave - 1) / 3) % COOP_BOSSES.length];
        name = cb.name; color = cb.color; sprite = cb.sprite;
      }
      this.enemies.push({
        x, y, kind, boss: true, name,
        hp: 620 * this.hpMul, maxHp: 620 * this.hpMul,
        speed: 76, dmg: 26 * this.dmgMulE, radius: 38, xp: 250,
        attackCd: 0, shootCd: 2, burstCd: 4, flash: 0, disarmT: 0, kx: 0, ky: 0,
        anim: 0, sprite, windup: 0, nid: this.nidSeq++, telCd: 3, sumCd: 9,
        charmT: 0, burnT: 0, burnAcc: 0, burnDmg: 0,
      });
      this.announce(`БОСС: ${name}`, "постарайся выжить!");
      if (this.netMode === "host") this.net?.sendEv({ t: "ann", x: `БОСС: ${name}`, s: "постарайтесь выжить!" });
      void color;
    } else {
      this.enemies.push({
        x, y, kind, boss: false, name: kind.name,
        hp: kind.hp * this.hpMul, maxHp: kind.hp * this.hpMul,
        speed: kind.speed * (1 + (this.wave - 1) * 0.02), dmg: kind.dmg * this.dmgMulE,
        radius: kind.radius, xp: kind.xp,
        attackCd: 0, shootCd: 1 + Math.random() * 1.5, burstCd: 0, flash: 0, disarmT: 0, kx: 0, ky: 0, telCd: 0, sumCd: 0,
        anim: Math.random() * 10, sprite: this.map === COOP_MAP ? kindSprite(kind) : (kind.spriteVar ?? this.enemySpriteId()), windup: 0, nid: this.nidSeq++,
        charmT: 0, burnT: 0, burnAcc: 0, burnDmg: 0,
      });
    }
  }

  private updateEnemies(dt: number): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.flash -= dt; e.attackCd -= dt; e.shootCd -= dt; e.burstCd -= dt; e.disarmT -= dt;
      e.anim += dt * (0.6 + e.speed / 90);
      // поджог (Катон / Инсендио / дракон): тики урона раз в 0.5 с
      if (e.burnT > 0) {
        e.burnT -= dt; e.burnAcc += dt;
        if (e.burnAcc >= 0.5) {
          e.burnAcc -= 0.5;
          this.spawnParticles(e.x, e.y - 10, 3, "#ff8a3c", 120);
          this.damageEnemy(e, e.burnDmg * 0.5, 0, 0, e.burnOwner);
          if (e.hp <= 0) continue;
        }
      }
      // нокбэк
      e.x += e.kx * dt; e.y += e.ky * dt;
      e.kx *= Math.pow(0.0001, dt); e.ky *= Math.pow(0.0001, dt);
      // Империус: подчинённый враг дерётся с бывшими союзниками
      if (e.charmT > 0) {
        e.charmT -= dt;
        let tgt2: Enemy | null = null;
        let bd2 = Infinity;
        for (const o of this.enemies) {
          if (o === e || o.charmT > 0) continue;
          const d2 = (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y);
          if (d2 < bd2) { bd2 = d2; tgt2 = o; }
        }
        if (tgt2) {
          const dx2 = tgt2.x - e.x, dy2 = tgt2.y - e.y;
          const d2 = Math.hypot(dx2, dy2) || 1;
          if (e.kind.ranged) {
            if (d2 > 260) { e.x += (dx2 / d2) * e.speed * dt; e.y += (dy2 / d2) * e.speed * dt; }
            if (e.shootCd <= 0 && d2 < 520) {
              e.shootCd = 2.0;
              this.projs.push({
                x: e.x, y: e.y, vx: (dx2 / d2) * 380, vy: (dy2 / d2) * 380,
                dmg: e.dmg * 2, r: 6, friendly: true, pierce: false,
                life: 1.6, color: "#3ddc84", kind: "enemy", disarm: false, hitSet: null, owner: e.charmOwner,
              });
            }
          } else {
            if (d2 > e.radius + tgt2.radius + 8) { e.x += (dx2 / d2) * e.speed * dt; e.y += (dy2 / d2) * e.speed * dt; }
            else if (e.attackCd <= 0) {
              e.attackCd = 0.8;
              this.damageEnemy(tgt2, e.dmg * 2, (dx2 / d2) * 200, (dy2 / d2) * 200, e.charmOwner);
              this.spawnParticles(tgt2.x, tgt2.y, 4, "#3ddc84", 160);
            }
          }
        }
        e.x = Math.max(30, Math.min(WORLD_SIZE - 30, e.x));
        e.y = Math.max(30, Math.min(WORLD_SIZE - 30, e.y));
        continue;
      }
      const tgt = this.nearestPlayer(e.x, e.y);
      if (!tgt) continue;
      const dx = tgt.x - e.x, dy = tgt.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const slow = e.disarmT > 0 ? 0.5 : 1;
      if (e.windup > 0) {
        // замах: враг замирает, затем бьёт, если цель ещё рядом
        e.windup -= dt;
        if (e.windup <= 0 && d < e.radius + 36) this.hurtPlayer(tgt, e.dmg);
      } else if (e.disarmT <= 0) {
        if (e.kind.ranged && !e.boss) {
          if (d > 320) { e.x += (dx / d) * e.speed * slow * dt; e.y += (dy / d) * e.speed * slow * dt; }
          else if (d < 220) { e.x -= (dx / d) * e.speed * 0.7 * dt; e.y -= (dy / d) * e.speed * 0.7 * dt; }
          if (e.shootCd <= 0 && d < 520) {
            e.shootCd = 2.3;
            this.projs.push({
              x: e.x, y: e.y, vx: (dx / d) * 380, vy: (dy / d) * 380,
              dmg: e.dmg, r: 6, friendly: false, pierce: false,
              life: 1.6, color: e.kind.accent, kind: "enemy", disarm: false, hitSet: null,
            });
          }
        } else {
          if (d > e.radius + 22) { e.x += (dx / d) * e.speed * slow * dt; e.y += (dy / d) * e.speed * slow * dt; }
          // скиллы босса: телеграф «кольца смерти» под целью и призыв миньонов
          if (e.boss) {
            e.telCd -= dt; e.sumCd -= dt;
            if (e.telCd <= 0) {
              e.telCd = 6.5;
              this.telegraphs.push({ x: tgt.x, y: tgt.y, r: 150, t: 1.3, maxT: 1.3, dmg: e.dmg * 1.6, kind: "boss" });
            }
            if (e.sumCd <= 0 && this.enemies.length < 55) {
              e.sumCd = 12;
              this.spawnEnemy(false); this.spawnEnemy(false);
              this.spawnParticles(e.x, e.y, 24, "#b04ae8", 280);
              this.floaters.push({ x: e.x, y: e.y - 60, text: "ПРИЗЫВ!", color: "#b04ae8", life: 1 });
            }
          }
          if (e.boss && e.burstCd <= 0) {
            e.burstCd = 5;
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              this.projs.push({
                x: e.x, y: e.y, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300,
                dmg: e.dmg * 0.6, r: 7, friendly: false, pierce: false,
                life: 1.8, color: this.map.bossColor, kind: "enemy", disarm: false, hitSet: null,
              });
            }
          }
        }
        // контактный урон: сначала замах (телеграф), потом сам удар
        if (d < e.radius + 24 && e.attackCd <= 0) {
          e.attackCd = 1.0;
          e.windup = e.boss ? 0.42 : 0.3;
        }
      }
      e.x = Math.max(30, Math.min(WORLD_SIZE - 30, e.x));
      e.y = Math.max(30, Math.min(WORLD_SIZE - 30, e.y));
    }
    // рассредоточение: враги отталкиваются друг от друга и не слипаются в один спрайт
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.radius + b.radius + 4;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < rr * rr) {
          const d = Math.sqrt(d2);
          const push = ((rr - d) / d) * 0.5 * Math.min(1, dt * 12);
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
    }
  }

  private hurtPlayer(p: PlayerEnt, dmg: number): void {
    if (p.iframes > 0) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 30, text: "УВЕРНУЛСЯ", color: "#9fd8ff", life: 0.7 });
      return;
    }
    if (p.shieldT > 0) {
      if (p.isLocal) {
        this.floaters.push({ x: p.x, y: p.y - 30, text: "ПРОТЕГО!", color: "#b58cff", life: 0.7 });
        this.audio.sfx("ui");
      }
      return;
    }
    if (p.invulnT > 0) {
      if (p.isLocal) this.floaters.push({ x: p.x, y: p.y - 30, text: "НЕУЯЗВИМ", color: "#ffd24a", life: 0.5 });
      return;
    }
    p.hp -= dmg * Math.pow(0.88, p.buys[5]);
    p.hurtFlash = 0.25;
    this.decals.push({ x: p.x + (Math.random() - 0.5) * 20, y: p.y + 14, r: 7 + Math.random() * 6, color: "#6e1010", alpha: 0.45 });
    if (this.decals.length > 250) this.decals.shift();
    if (p.isLocal) {
      this.shake = Math.min(16, this.shake + 5);
      this.audio.sfx("hit");
    }
    this.spawnParticles(p.x, p.y, 8, "#e84a4a", 200);
  }

  private damageEnemy(e: Enemy, dmg: number, kx = 0, ky = 0, owner?: PlayerEnt): void {
    e.hp -= dmg;
    e.flash = 0.12;
    e.kx += kx; e.ky += ky;
    if (this.floaters.length < 24) // текст в программном рендере дорогой — ограничиваем
      this.floaters.push({ x: e.x, y: e.y - e.radius - 8, text: String(Math.round(dmg)), color: "#ffe28a", life: 0.7 });
    this.spawnParticles(e.x, e.y, 4, e.kind.accent, 160);
    if (e.hp <= 0) this.killEnemy(e, owner);
  }

  private killEnemy(e: Enemy, owner?: PlayerEnt): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    if (e.nid !== undefined) this.enemyByNid.delete(e.nid);
    this.kills++;
    const killer = owner ?? this.me;
    killer.kills++;
    killer.xp += e.xp;
    // хит-стоп: игра на мгновение замирает — убийство чувствуется весомым
    this.hitStop = Math.max(this.hitStop, e.boss ? 0.1 : 0.03);
    // труп падает и растворяется
    this.corpses.push({
      x: e.x, y: e.y, sprite: e.sprite,
      life: 1.4, flip: this.px > e.x, scale: (e.boss ? 2 : 1) * (e.kind.scaleMul ?? 1),
    });
    if (this.corpses.length > 30) this.corpses.shift();
    // кровавое пятно остаётся на земле
    this.decals.push({ x: e.x, y: e.y, r: e.boss ? 46 : 18 + Math.random() * 14, color: "#6e1010", alpha: 0.55 });
    if (this.decals.length > 250) this.decals.shift();
    this.floaters.push({ x: e.x, y: e.y - 20, text: `+${e.xp} XP`, color: "#8ef0b0", life: 0.9 });
    this.spawnParticles(e.x, e.y, e.boss ? 40 : 14, e.kind.accent, e.boss ? 380 : 240);
    if (e.boss) {
      this.announce(`${e.name} ПОВЕРЖЕН!`, "+150 XP и сферы здоровья");
      if (this.netMode === "host") this.net?.sendEv({ t: "ann", x: `${e.name} ПОВЕРЖЕН!`, s: "+150 XP и сферы здоровья" });
      for (let k = 0; k < 3; k++) this.orbs.push({ x: e.x + (k - 1) * 40, y: e.y + 30, heal: 25, t: 0 });
      this.spawnWave(e.x, e.y, 260, "#ffd24a", 0, 22, 0.6);
      this.addLight(e.x, e.y, 360, 0.5);
      this.shake = Math.min(20, this.shake + 12);
      this.audio.sfx("win");
    } else {
      if (Math.random() < 0.26) this.orbs.push({ x: e.x, y: e.y, heal: 15, t: 0 });
      this.audio.sfx("explosion");
    }
    // золото падает всегда, лут — с шансом (с босса — гарантированно)
    this.golds.push({ x: e.x + (Math.random() - 0.5) * 30, y: e.y + (Math.random() - 0.5) * 30, v: e.boss ? 60 : 3 + Math.floor(Math.random() * 6), t: 0 });
    if (Math.random() < (e.boss ? 1 : 0.1)) {
      const kinds: LootKind[] = ["rush", "berserk", "aegis", "mana"];
      this.loots.push({ x: e.x, y: e.y, kind: kinds[Math.floor(Math.random() * kinds.length)], t: 0 });
    }
  }

  private updateProjs(dt: number): void {
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      let dead = p.life <= 0 || p.x < 0 || p.x > WORLD_SIZE || p.y < 0 || p.y > WORLD_SIZE;
      if (!dead && p.friendly) {
        for (const e of this.enemies) {
          if (e.charmT > 0 || p.hitSet?.has(e)) continue;
          if (Math.hypot(e.x - p.x, e.y - p.y) < e.radius + p.r) {
            if (p.disarm) e.disarmT = 3;
            const ang = Math.atan2(p.vy, p.vx);
            this.damageEnemy(e, p.dmg, Math.cos(ang) * 140, Math.sin(ang) * 140, p.owner);
            if (p.kind === "chakra") {
              // сгусток чакры Максима: маленький взрыв при попадании
              this.spawnWave(p.x, p.y, 70, "#8fd0ff", p.dmg * 0.5, 14, 0.3, p.owner);
              this.addLight(p.x, p.y, 120, 0.15);
            }
            if (p.pierce) p.hitSet?.add(e);
            else { dead = true; break; }
          }
        }
      } else if (!dead && !p.friendly) {
        for (const pl of this.players) {
          if (!pl.alive) continue;
          if (Math.hypot(pl.x - p.x, pl.y - p.y) < 22 + p.r) {
            this.hurtPlayer(pl, p.dmg);
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        if (p.kind === "rasenshuriken") {
          // взрыв Расенгана: масштаб от размера сферы (ульт больше)
          const scale = p.r / 26;
          this.spawnWave(p.x, p.y, 330 * scale, "#7ec8ff", this.basicDmg(p.owner ?? this.me) * 5 * scale, 34, 0.55, p.owner);
          this.spawnWave(p.x, p.y, 210 * scale, "#ffffff", 0, 16, 0.4);
          this.spawnParticles(p.x, p.y, 36, "#7ec8ff", 420);
          this.spawnParticles(p.x, p.y, 14, "#ffffff", 300);
          this.addLight(p.x, p.y, 400 * scale, 0.4);
          this.shake = Math.min(20, this.shake + 12 * scale);
          this.audio.sfx("explosion");
          if (this.netMode === "host") this.net?.sendEv({ t: "boom", x: p.x, y: p.y });
        } else if (p.kind !== "bullet") this.spawnParticles(p.x, p.y, 3, p.color, 120);
        if (p.nid !== undefined) this.projByNid.delete(p.nid);
        this.projs.splice(i, 1);
      }
    }
  }

  private updateSatoru(dt: number): void {
    for (let si = this.satorus.length - 1; si >= 0; si--) {
      const s = this.satorus[si];
      s.life -= dt; s.swipeCd -= dt;
      if (s.life <= 0) {
        this.spawnParticles(s.x, s.y, 20, "#e8e8e8", 220);
        this.satorus.splice(si, 1);
        continue;
      }
      const owner = this.players.find((p) => p.pid === s.pid) ?? this.me;
      let target: Enemy | null = null;
      let best = 950;
      for (const e of this.enemies) {
        if (e.charmT > 0) continue;
        const d = Math.hypot(e.x - s.x, e.y - s.y);
        if (d < best) { best = d; target = e; }
      }
      if (target) {
        const d = best || 1;
        if (d > 64) { s.x += ((target.x - s.x) / d) * 430 * dt; s.y += ((target.y - s.y) / d) * 430 * dt; }
        else if (s.swipeCd <= 0) {
          s.swipeCd = 0.55;
          for (const e of this.enemies) {
            if (e.charmT > 0) continue;
            if (Math.hypot(e.x - s.x, e.y - s.y) < 78 + e.radius) {
              const ang = Math.atan2(e.y - s.y, e.x - s.x);
              this.damageEnemy(e, this.basicDmg(owner) * 1.6, Math.cos(ang) * 260, Math.sin(ang) * 260, owner);
            }
          }
          this.floaters.push({ x: s.x, y: s.y - 30, text: "МРРР!", color: "#ffffff", life: 0.6 });
          this.spawnParticles(s.x, s.y, 10, "#f0f0f0", 240);
          this.audio.sfx("hit");
        }
      } else {
        const d = Math.hypot(owner.x - s.x, owner.y - s.y) || 1;
        if (d > 90) { s.x += ((owner.x - s.x) / d) * 380 * dt; s.y += ((owner.y - s.y) / d) * 380 * dt; }
      }
    }
  }

  /** Маунты (замбони/жаба/бэтмобиль/гиппогриф): контактный урон каждые 0.35 с. */
  private updateMounts(dt: number): void {
    for (const p of this.players) {
      if (!p.alive || p.mountT <= 0) continue;
      p.mountT -= dt;
      p.mountDmgT -= dt;
      if (p.mountDmgT > 0) continue;
      p.mountDmgT = 0.35;
      for (const e of this.enemies) {
        if (e.charmT > 0) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < 60 + e.radius) {
          const ang = Math.atan2(e.y - p.y, e.x - p.x);
          const mk = p.hero.id === "maxim" ? "e" : "r";
          this.damageEnemy(e, this.basicDmg(p) * 1.5 * this.skillAmp(p, mk), Math.cos(ang) * 420, Math.sin(ang) * 420, p);
        }
      }
      this.spawnParticles(p.x, p.y + 12, 2, "#c9c9c9", 90);
    }
  }

  /** Крутящийся стрелок Даши: пули по кругу 6 секунд. */
  private updateSpin(dt: number): void {
    for (const p of this.players) {
      if (!p.alive || p.spinT <= 0) continue;
      p.spinT -= dt;
      p.spinAng += dt * 8.5;
      p.spinFireT -= dt;
      if (p.spinFireT <= 0) {
        p.spinFireT = 0.13;
        const a = p.spinAng;
        this.projs.push({
          x: p.x + Math.cos(a) * 26, y: p.y + Math.sin(a) * 26,
          vx: Math.cos(a) * 950, vy: Math.sin(a) * 950,
          dmg: this.basicDmg(p) * 0.7 * this.skillAmp(p, "e"), r: 4, friendly: true, pierce: false,
          life: 0.6, color: "#ffb02e", kind: "bullet", disarm: false, hitSet: null, owner: p,
        });
      }
    }
  }

  /** Теневые клоны Максима: держат дистанцию и стреляют сюрикенами. */
  private updateClones(dt: number): void {
    for (let i = this.clones.length - 1; i >= 0; i--) {
      const c = this.clones[i];
      c.t -= dt; c.shootT -= dt;
      if (c.t <= 0) {
        this.spawnParticles(c.x, c.y, 20, "#9fd8ff", 240);
        this.clones.splice(i, 1);
        continue;
      }
      let target: Enemy | null = null;
      let bd = 850;
      for (const e of this.enemies) {
        if (e.charmT > 0) continue;
        const d = Math.hypot(e.x - c.x, e.y - c.y);
        if (d < bd) { bd = d; target = e; }
      }
      if (target) {
        const dx = target.x - c.x, dy = target.y - c.y;
        const d = bd || 1;
        if (d > 220) { c.x += (dx / d) * 260 * dt; c.y += (dy / d) * 260 * dt; c.walk += dt * 1.6; }
        else if (d < 120) { c.x -= (dx / d) * 200 * dt; c.y -= (dy / d) * 200 * dt; c.walk += dt * 1.6; }
        if (c.shootT <= 0) {
          c.shootT = 0.55;
          this.projs.push({
            x: c.x + (dx / d) * 24, y: c.y + (dy / d) * 24,
            vx: (dx / d) * 700, vy: (dy / d) * 700,
            dmg: this.basicDmg(c.owner) * 0.8 * this.skillAmp(c.owner, "r"), r: 7, friendly: true, pierce: false,
            life: 0.9, color: "#d8e2e8", kind: "shuriken", disarm: false, hitSet: null, owner: c.owner,
          });
        }
      }
      c.x = Math.max(30, Math.min(WORLD_SIZE - 30, c.x));
      c.y = Math.max(30, Math.min(WORLD_SIZE - 30, c.y));
    }
  }

  /** Огненный дракон Вики: кружит вокруг хозяйки и жжёт область. */
  private updateDragons(dt: number): void {
    for (let i = this.dragons.length - 1; i >= 0; i--) {
      const dr = this.dragons[i];
      dr.t -= dt; dr.tickT -= dt;
      dr.ang += dt * 2.4;
      dr.x = dr.owner.x + Math.cos(dr.ang) * 200;
      dr.y = dr.owner.y + Math.sin(dr.ang) * 130;
      if (dr.t <= 0) {
        this.spawnParticles(dr.x, dr.y, 26, "#ff8a3c", 300);
        this.dragons.splice(i, 1);
        continue;
      }
      this.spawnParticles(dr.x, dr.y, 2, "#ff8a3c", 140);
      if (dr.tickT <= 0) {
        dr.tickT = 0.25;
        this.addLight(dr.x, dr.y, 220, 0.3);
        for (const e of this.enemies) {
          if (e.charmT > 0) continue;
          if (Math.hypot(e.x - dr.x, e.y - dr.y) < 130 + e.radius) {
            const ang = Math.atan2(e.y - dr.y, e.x - dr.x);
            this.damageEnemy(e, this.basicDmg(dr.owner) * 0.7 * this.skillAmp(dr.owner, "t"), Math.cos(ang) * 120, Math.sin(ang) * 120, dr.owner);
            e.burnT = 2; e.burnDmg = this.basicDmg(dr.owner) * 0.5 * this.skillAmp(dr.owner, "t"); e.burnOwner = dr.owner;
          }
        }
      }
    }
  }

  private updateFx(dt: number): void {
    // ударные волны
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      wv.life -= dt;
      const t = 1 - Math.max(0, wv.life / wv.maxLife);
      wv.r = 10 + (wv.maxR - 10) * (1 - Math.pow(1 - t, 2.2));
      if (wv.dmg > 0 && wv.hitSet) {
        for (const e of this.enemies) {
          if (wv.hitSet.has(e)) continue;
          const d = Math.hypot(e.x - wv.x, e.y - wv.y);
          if (Math.abs(d - wv.r) < wv.width + e.radius) {
            wv.hitSet.add(e);
            const ang = Math.atan2(e.y - wv.y, e.x - wv.x);
            this.damageEnemy(e, wv.dmg, Math.cos(ang) * 300, Math.sin(ang) * 300, wv.owner);
          }
        }
      }
      if (wv.life <= 0) this.waves.splice(i, 1);
    }
    // временные источники света
    for (let i = this.tempLights.length - 1; i >= 0; i--) {
      this.tempLights[i].life -= dt;
      if (this.tempLights[i].life <= 0) this.tempLights.splice(i, 1);
    }
    // вспышки конусных атак
    for (let i = this.cones.length - 1; i >= 0; i--) {
      this.cones[i].life -= dt;
      if (this.cones[i].life <= 0) this.cones.splice(i, 1);
    }
    // отложенные залпы («Тотальный отстрел» Даши)
    for (let i = this.volleys.length - 1; i >= 0; i--) {
      const v = this.volleys[i];
      v.t -= dt;
      if (v.t > 0) continue;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + v.ang0;
        this.projs.push({
          x: v.p.x + Math.cos(a) * 30, y: v.p.y + Math.sin(a) * 30,
          vx: Math.cos(a) * 900, vy: Math.sin(a) * 900,
          dmg: this.basicDmg(v.p) * 1.1, r: 4, friendly: true, pierce: false,
          life: 0.65, color: "#ffb02e", kind: "bullet", disarm: false, hitSet: null, owner: v.p,
        });
      }
      this.spawnParticles(v.p.x, v.p.y, 10, "#ffd24a", 260);
      this.addLight(v.p.x, v.p.y, 240, 0.15);
      this.audio.sfx("hit");
      this.volleys.splice(i, 1);
    }
    // следы рывков всех игроков
    for (const pl of this.players) {
      for (let i = pl.trail.length - 1; i >= 0; i--) {
        pl.trail[i].life -= dt;
        if (pl.trail[i].life <= 0) pl.trail.splice(i, 1);
      }
    }
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      this.corpses[i].life -= dt;
      if (this.corpses[i].life <= 0) this.corpses.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.pow(0.01, dt); p.vy *= Math.pow(0.01, dt);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt; f.y -= 46 * dt;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
    for (let i = this.announces.length - 1; i >= 0; i--) {
      this.announces[i].life -= dt;
      if (this.announces[i].life <= 0) this.announces.splice(i, 1);
    }
  }

  private spawnParticles(x: number, y: number, n: number, color: string, speed: number): void {
    if (this.particles.length > 220) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.35 + Math.random() * 0.4, maxLife: 0.75, color, size: 2 + Math.random() * 4,
      });
    }
  }

  // ---------- сеть: снапшоты ----------

  /** Хост рассылает состояние мира (10 раз в секунду). */
  private sendSnap(): void {
    if (!this.net) return;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const pl: SnapMsg["pl"] = {};
    for (const p of this.players) {
      pl[p.pid] = {
        h: p.hero.id, x: r1(p.x), y: r1(p.y), fx: +p.facing.toFixed(2), wk: +p.walkPhase.toFixed(2), mv: p.moving,
        hp: Math.ceil(p.hp), mh: p.maxHp, mn: Math.floor(p.mana), lv: p.level, dm: +p.dmgMul.toFixed(2),
        sw: +Math.max(0, p.swingT).toFixed(2), sh: +Math.max(0, p.shieldT).toFixed(1), da: +Math.max(0, p.dashT).toFixed(2), al: p.alive,
        mo: +Math.max(0, p.mountT).toFixed(1), rg: +Math.max(0, p.rageT).toFixed(1), spn: +Math.max(0, p.spinT).toFixed(1),
        cb: +Math.max(0, p.cdBasic).toFixed(1), cq: +Math.max(0, p.cdQ).toFixed(1), ce: +Math.max(0, p.cdE).toFixed(1),
        cr: +Math.max(0, p.cdR).toFixed(1), ct: +Math.max(0, p.cdT).toFixed(1), cf: +Math.max(0, p.cdF).toFixed(1),
        g: p.gold, pts: p.skillPts, sk: [p.sk.q, p.sk.e, p.sk.r, p.sk.t], bu: p.buys,
        ru: +Math.max(0, p.cdRushT).toFixed(1), bs: +Math.max(0, p.berserkT).toFixed(1), iv: +Math.max(0, p.invulnT).toFixed(1),
        k: p.kills, rp: +p.reviveProg.toFixed(2),
      };
    }
    const en: SnapMsg["en"] = [];
    for (const e of this.enemies) {
      if (e.nid === undefined) e.nid = this.nidSeq++;
      en.push({
        i: e.nid, k: ALL_ENEMY_KINDS.indexOf(e.kind), s: SPRITE_IDS.indexOf(e.sprite),
        x: r1(e.x), y: r1(e.y), hp: Math.ceil(e.hp), mhp: Math.ceil(e.maxHp), b: e.boss, w: e.windup > 0, c: e.charmT > 0,
      });
    }
    const pr: SnapMsg["pr"] = [];
    for (const p of this.projs) {
      if (p.nid === undefined) p.nid = this.nidSeq++;
      pr.push({ i: p.nid, k: p.kind, x: r1(p.x), y: r1(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), r: p.r, c: p.color, f: p.friendly });
    }
    this.net.sendSnap({
      t: r1(this.time), wave: this.wave, kills: this.kills,
      ws: this.waveState === "break" ? 1 : 0, bt: +this.breakT.toFixed(1),
      gold: this.golds.map((g) => [Math.round(g.x), Math.round(g.y), g.v]),
      loot: this.loots.map((l) => [Math.round(l.x), Math.round(l.y), l.kind]),
      tel: this.telegraphs.map((tg) => [Math.round(tg.x), Math.round(tg.y), tg.r, +tg.t.toFixed(2), tg.kind === "meteor" ? 1 : 0]),
      pl, en, pr,
      orb: this.orbs.map((o) => [Math.round(o.x), Math.round(o.y)]),
      sat: this.satorus.map((s) => ({ p: s.pid, x: r1(s.x), y: r1(s.y), l: +s.life.toFixed(1) })),
      cl: this.clones.map((c) => ({ x: r1(c.x), y: r1(c.y), wk: +c.walk.toFixed(2) })),
      dr: this.dragons.map((d) => ({ x: r1(d.x), y: r1(d.y), ang: +d.ang.toFixed(2) })),
    });
  }

  /** Клиент применяет снапшот: статы себе, позиции — остальным. */
  private applySnap(s: SnapMsg): void {
    this.kills = s.kills;
    if (s.wave !== this.prevWave) {
      this.prevWave = s.wave;
      this.wave = s.wave;
      this.announce(`ВОЛНА ${s.wave}`, "врагов больше, и они сильнее!");
      this.audio.sfx("explosion");
    }
    const newWs = s.ws === 1 ? "break" : "fight";
    if (newWs !== this.waveState) {
      this.waveState = newWs;
      if (newWs === "break") this.shopOpen = false;
    }
    this.breakT = s.bt;
    this.golds = s.gold.map(([x, y, v]) => ({ x, y, v, t: 0 }));
    this.loots = s.loot.map(([x, y, kind]) => ({ x, y, kind: kind as LootKind, t: 0 }));
    this.telegraphs = s.tel.map(([x, y, r, t2, kd]) => ({ x, y, r, t: t2, maxT: Math.max(t2, 0.4), dmg: 0, kind: kd === 1 ? "meteor" as const : "boss" as const }));
    // игроки
    for (const [pid, sp] of Object.entries(s.pl)) {
      let p = this.players.find((pl) => pl.pid === pid);
      if (!p) {
        p = makePlayer(pid, heroById(sp.h), pid === this.myPid);
        p.x = sp.x; p.y = sp.y; p.tx = sp.x; p.ty = sp.y;
        this.players.push(p);
      }
      if (p.isLocal) {
        const prevHp = p.hp, prevLv = p.level;
        p.hp = sp.hp; p.maxHp = sp.mh; p.mana = sp.mn; p.level = sp.lv; p.dmgMul = sp.dm;
        p.gold = sp.g; p.skillPts = sp.pts; p.buys = sp.bu;
        const prevSk = p.sk;
        p.sk = { q: sp.sk[0], e: sp.sk[1], r: sp.sk[2], t: sp.sk[3] };
        p.cdRushT = sp.ru; p.berserkT = sp.bs; p.invulnT = sp.iv;
        p.kills = sp.k; p.reviveProg = sp.rp;
        for (const k of ["q", "e", "r", "t"] as const) {
          if (p.sk[k] > prevSk[k]) {
            const nm = k === "t" ? p.hero.ult.name : p.hero[k].name;
            this.floaters.push({ x: p.x, y: p.y - 40, text: `${nm} → ур. ${p.sk[k]}`, color: "#ffd24a", life: 1.2 });
          }
        }
        p.shieldT = sp.sh; p.swingT = Math.max(p.swingT, 0);
        p.cdBasic = sp.cb; p.cdQ = sp.cq; p.cdE = sp.ce; p.cdR = sp.cr; p.cdT = sp.ct; p.cdF = sp.cf;
        p.mountT = sp.mo; p.rageT = sp.rg; p.spinT = sp.spn;
        if (sp.da > 0 && p.dashT <= 0) { p.dashT = sp.da; } // дэш, начатый на хосте по нашему же запросу
        if (sp.hp < prevHp) { p.hurtFlash = 0.25; this.shake = Math.min(16, this.shake + 5); this.audio.sfx("hit"); }
        if (sp.lv > prevLv) {
          this.announce(`УРОВЕНЬ ${sp.lv}!`, sp.lv === ULT_UNLOCK_LEVEL ? "УЛЬТИМЕЙТ ДОСТУПЕН — вложи очко (клавиша 4)!" : "+1 очко навыка — прокачка клавишами 1-4");
          this.spawnParticles(p.x, p.y, 40, "#ffd24a", 320);
          this.spawnWave(p.x, p.y, 200, "#ffd24a", 0, 18, 0.5);
          this.addLight(p.x, p.y, 300, 0.4);
          this.audio.sfx("win");
        }
        if (this.prevAlive && !sp.al) { this.announce("ВЫ ПАЛИ", "союзники могут воскресить тебя — или жди перерыва"); this.audio.sfx("lose"); }
        if (!this.prevAlive && sp.al) { this.announce("ТЫ ВОСКРЕС", "вернись в бой!"); this.audio.sfx("win"); }
        this.prevAlive = sp.al;
        p.alive = sp.al;
      } else {
        p.tx = sp.x; p.ty = sp.y; p.facing = sp.fx; p.walkPhase = sp.wk; p.moving = sp.mv;
        p.hp = sp.hp; p.maxHp = sp.mh; p.level = sp.lv;
        p.shieldT = sp.sh; p.dashT = sp.da; p.swingT = sp.sw; p.alive = sp.al;
        p.kills = sp.k; p.reviveProg = sp.rp;
        p.mountT = sp.mo; p.rageT = sp.rg; p.spinT = sp.spn;
      }
    }
    // враги
    const seen = new Set<number>();
    for (const se of s.en) {
      seen.add(se.i);
      let e = this.enemyByNid.get(se.i);
      if (!e) {
        const kind = ALL_ENEMY_KINDS[se.k] ?? ALL_ENEMY_KINDS[0];
        e = {
          x: se.x, y: se.y, tx: se.x, ty: se.y, hp: se.hp, maxHp: se.mhp,
          kind, boss: se.b, name: se.b ? "" : kind.name,
          speed: kind.speed, dmg: kind.dmg, radius: se.b ? 36 : kind.radius, xp: kind.xp,
          attackCd: 0, shootCd: 0, burstCd: 0, flash: 0, disarmT: 0, kx: 0, ky: 0, telCd: 0, sumCd: 0,
          anim: Math.random() * 10, sprite: SPRITE_IDS[se.s] ?? "enemy-hockey", windup: 0, nid: se.i,
          charmT: se.c ? 3 : 0, burnT: 0, burnAcc: 0, burnDmg: 0,
        };
        this.enemyByNid.set(se.i, e);
        this.enemies.push(e);
      }
      e.tx = se.x; e.ty = se.y;
      if (se.hp < e.hp) { e.flash = 0.12; this.spawnParticles(se.x, se.y, 3, e.kind.accent, 140); }
      e.hp = se.hp; e.maxHp = se.mhp;
      e.charmT = se.c ? Math.max(e.charmT, 0.5) : 0;
      if (se.w && e.windup <= 0) e.windup = 0.25;
      if (se.b && !e.boss) e.boss = true;
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.nid !== undefined && !seen.has(e.nid)) {
        this.clientKillFx(e);
        this.enemyByNid.delete(e.nid);
        this.enemies.splice(i, 1);
      }
    }
    // снаряды: позиция из снапшота, между ними — экстраполяция по скорости
    const seenPr = new Set<number>();
    for (const sp of s.pr) {
      seenPr.add(sp.i);
      let pr = this.projByNid.get(sp.i);
      if (!pr) {
        pr = {
          x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy, dmg: 0, r: sp.r,
          friendly: sp.f, pierce: false, life: 3, color: sp.c, kind: sp.k,
          disarm: false, hitSet: null, nid: sp.i,
        };
        this.projByNid.set(sp.i, pr);
        this.projs.push(pr);
      } else {
        pr.x = sp.x; pr.y = sp.y; pr.vx = sp.vx; pr.vy = sp.vy; pr.life = 3;
      }
    }
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const pr = this.projs[i];
      if (pr.nid !== undefined && !seenPr.has(pr.nid)) {
        if (pr.kind === "rasenshuriken") this.rasenBoomFx(pr.x, pr.y);
        else if (pr.kind !== "bullet") this.spawnParticles(pr.x, pr.y, 3, pr.color, 120);
        this.projByNid.delete(pr.nid);
        this.projs.splice(i, 1);
      }
    }
    // сферы здоровья и коты
    this.orbs = s.orb.map(([x, y]) => ({ x, y, heal: 15, t: 0 }));
    const seenSat = new Set<string>();
    for (const ss of s.sat) {
      seenSat.add(ss.p);
      let cat = this.satorus.find((c) => c.pid === ss.p);
      if (!cat) {
        cat = { x: ss.x, y: ss.y, life: ss.l, swipeCd: 0, pid: ss.p };
        this.satorus.push(cat);
        this.spawnParticles(ss.x, ss.y - 40, 24, "#e8e8e8", 240);
        this.audio.sfx("win");
      }
      cat.x = ss.x; cat.y = ss.y; cat.life = ss.l;
    }
    this.satorus = this.satorus.filter((c) => seenSat.has(c.pid));
    // клоны и драконы — чисто визуальные на клиенте
    this.clones = (s.cl ?? []).map((c) => ({ x: c.x, y: c.y, t: 1, shootT: 0, walk: c.wk, owner: this.me }));
    this.dragons = (s.dr ?? []).map((d) => ({ x: d.x, y: d.y, t: 1, ang: d.ang, tickT: 0, owner: this.me }));
  }

  /** Эффекты смерти врага на клиенте (снапшот просто перестаёт его присылать). */
  private clientKillFx(e: Enemy): void {
    this.corpses.push({
      x: e.tx ?? e.x, y: e.ty ?? e.y, sprite: e.sprite,
      life: 1.4, flip: this.px > e.x, scale: (e.boss ? 2 : 1) * (e.kind.scaleMul ?? 1),
    });
    if (this.corpses.length > 30) this.corpses.shift();
    this.decals.push({ x: e.tx ?? e.x, y: e.ty ?? e.y, r: e.boss ? 46 : 18 + Math.random() * 14, color: "#6e1010", alpha: 0.55 });
    if (this.decals.length > 250) this.decals.shift();
    this.spawnParticles(e.tx ?? e.x, e.ty ?? e.y, e.boss ? 40 : 14, e.kind.accent, e.boss ? 380 : 240);
    this.audio.sfx("explosion");
    if (e.boss) {
      this.spawnWave(e.tx ?? e.x, e.ty ?? e.y, 260, "#ffd24a", 0, 22, 0.6);
      this.addLight(e.tx ?? e.x, e.ty ?? e.y, 360, 0.5);
      this.shake = Math.min(20, this.shake + 12);
    }
  }

  /** Взрыв Расен-сюрикена на клиенте. */
  private rasenBoomFx(x: number, y: number): void {
    this.spawnWave(x, y, 330, "#7ec8ff", 0, 34, 0.55);
    this.spawnWave(x, y, 210, "#ffffff", 0, 16, 0.4);
    this.spawnParticles(x, y, 36, "#7ec8ff", 420);
    this.addLight(x, y, 400, 0.4);
    this.shake = Math.min(20, this.shake + 10);
    this.audio.sfx("explosion");
  }

  /** Сетевые события от хоста (анонсы, чужие касты). */
  private applyEv(d: EvMsg): void {
    if (d.t === "ann") {
      this.announce(d.x, d.s);
      this.audio.sfx("explosion");
    } else if (d.t === "castfx") {
      this.spawnCastFx(d.h, d.k, d.x, d.y, d.dir);
    } else if (d.t === "boom") {
      this.rasenBoomFx(d.x, d.y);
    } else if (d.t === "pause") {
      this.netPaused = d.on;
      this.announce(d.on ? "ПАУЗА" : "БОЙ ПРОДОЛЖАЕТСЯ", d.on ? "хост поставил паузу для всего лобби" : "");
      this.audio.sfx("ui");
    } else if (d.t === "over") {
      this.overStats = { time: d.time, kills: d.kills, level: this.level, wave: d.wave };
      this.state = "over";
      this.leaveNetAfter();
      this.audio.sfx("lose");
      this.audio.stopMusic();
    }
  }

  /** Визуал чужого каста на клиенте (урона нет — его считает хост). */
  private spawnCastFx(heroId: string, k: string, x: number, y: number, dir: number): void {
    const ax = x + Math.cos(dir) * 70, ay = y + Math.sin(dir) * 70;
    if (k === "q") {
      if (heroId === "maxim") {
        // Катон: оранжевое пламя конусом
        this.spawnParticles(ax, ay, 30, "#ff8c3a", 320);
        this.spawnParticles(ax, ay, 14, "#ffd24a", 220);
        this.addLight(ax, ay, 280, 0.3);
        this.audio.sfx("explosion");
      } else if (heroId === "dasha") {
        // Дробовик: вспышка выстрела
        this.spawnParticles(x + Math.cos(dir) * 34, y + Math.sin(dir) * 34, 16, "#ffd24a", 260);
        this.addLight(x, y, 180, 0.15);
        this.audio.sfx("hit");
      } else if (heroId === "vika") {
        // Империус: зелёная вспышка подчинения
        this.spawnParticles(x, y, 24, "#3ddc84", 240);
        this.spawnWave(x, y, 170, "#3ddc84", 0, 14, 0.35);
        this.audio.sfx("win");
      } else {
        // Ледяной прорыв Никиты
        this.spawnParticles(x, y, 28, "#7ec8ff", 340);
        this.spawnWave(x, y, 180, "#bfe4ff", 0, 16, 0.35);
        this.audio.sfx("move");
      }
    } else if (k === "e") {
      if (heroId === "vika") {
        // Инсендио: конус пламени
        this.spawnParticles(ax, ay, 30, "#ff6a2a", 320);
        this.addLight(ax, ay, 280, 0.3);
        this.audio.sfx("explosion");
      } else if (heroId === "maxim") {
        // Призыв жабы: зелёный дым
        this.spawnParticles(x, y, 32, "#7ab54a", 240);
        this.spawnWave(x, y, 150, "#7ab54a", 0, 14, 0.3);
        this.audio.sfx("win");
      } else if (heroId === "dasha") {
        // Крутящийся стрелок: кольцо вспышек
        this.spawnParticles(x, y, 22, "#ffd24a", 280);
        this.audio.sfx("hit");
      } else {
        // Конусный замах Никиты
        this.spawnWave(x, y, 210, "#bfe4ff", 0, 18, 0.3);
        this.audio.sfx("hit");
      }
    } else if (k === "r") {
      if (heroId === "maxim") {
        // Теневой клон: голубой дым
        this.spawnParticles(x, y, 36, "#9fd8ff", 280);
        this.spawnWave(x, y, 140, "#9fd8ff", 0, 14, 0.3);
      } else {
        // Маунты: дым и свет призыва
        this.spawnParticles(x, y, 26, "#c9c9c9", 220);
        this.addLight(x, y, 220, 0.25);
      }
      this.audio.sfx("win");
    } else if (k === "t") {
      // Ультимейты
      if (heroId === "nikita") {
        this.spawnParticles(x, y, 36, "#ff3a2a", 340);
        this.spawnWave(x, y, 240, "#ff3a2a", 0, 22, 0.5);
        this.addLight(x, y, 320, 0.4);
      } else if (heroId === "maxim") {
        this.spawnParticles(x, y, 30, "#7ec8ff", 320);
        this.addLight(x, y, 300, 0.35);
      } else if (heroId === "dasha") {
        this.spawnWave(x, y, 300, "#c9a15a", 0, 26, 0.5);
        this.spawnParticles(x, y, 30, "#ffd24a", 300);
        this.addLight(x, y, 340, 0.4);
      } else {
        this.spawnParticles(x, y, 36, "#ff8c3a", 340);
        this.addLight(x, y, 360, 0.45);
      }
      this.audio.sfx("explosion");
    } else if (k === "f") {
      // Зов САТОРУ: белый дым и звон
      this.spawnParticles(x, y - 40, 24, "#e8e8e8", 240);
      this.audio.sfx("win");
    } else if (k === "lvl") {
      this.spawnParticles(x, y, 40, "#ffd24a", 320);
      this.spawnWave(x, y, 200, "#ffd24a", 0, 18, 0.5);
      this.addLight(x, y, 300, 0.4);
    }
  }

  /** Клиентское движение сущностей между снапшотами. */
  private updateClientEntities(dt: number): void {
    for (const p of this.players) {
      if (p.isLocal) continue;
      const k = Math.min(1, dt * 15);
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      p.swingT -= dt; p.shieldT -= dt; p.dashT -= dt;
    }
    for (const e of this.enemies) {
      const k = Math.min(1, dt * 12);
      e.x += ((e.tx ?? e.x) - e.x) * k;
      e.y += ((e.ty ?? e.y) - e.y) * k;
      e.anim += dt * (0.6 + e.speed / 90);
      e.flash -= dt; e.windup -= dt;
    }
    for (const pr of this.projs) {
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
    }
  }

  // ---------- клики ----------

  private setLobbyHero(i: number): void {
    this.selIndex = i;
    this.audio.sfx("ui");
    if (this.netMode === "host") {
      const lp = this.lobbyPlayers.find((p) => p.pid === this.myPid);
      if (lp) lp.hero = HEROES[i].id;
      this.broadcastLobby();
    } else if (this.net && this.hostPeerId) {
      this.net.sendHero({ pid: this.myPid, hero: HEROES[i].id } as never);
    }
  }

  private onClick(cx: number, cy: number): void {
    if (this.state === "select") {
      if (this.selScreen === "join") return; // там всё с клавиатуры
      for (const b of this.menuBtns) {
        if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
          this.audio.sfx("ui");
          if (b.act === "solo") { this.netMode = "off"; this.startRun(HEROES[this.selIndex]); }
          else if (b.act === "create") this.createLobby();
          else if (b.act === "join") { this.selScreen = "join"; this.joinCode = ""; this.lobbyError = ""; this.input.drainPresses(); }
          return;
        }
      }
      for (let i = 0; i < this.cardRects.length; i++) {
        const r = this.cardRects[i];
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          if (this.selIndex === i) { this.audio.sfx("ui"); this.netMode = "off"; this.startRun(HEROES[i]); }
          else { this.selIndex = i; this.audio.sfx("ui"); }
          return;
        }
      }
    } else if (this.state === "lobby") {
      for (let i = 0; i < this.cardRects.length; i++) {
        const r = this.cardRects[i];
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { this.setLobbyHero(i); return; }
      }
      for (const b of this.menuBtns) {
        if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
          if (b.act === "start" && this.netMode === "host" && this.lobbyPlayers.length >= 2) { this.audio.sfx("ui"); this.hostStartCoop(); }
          else if (b.act === "leave") { this.leaveNet(); this.state = "select"; this.selScreen = "heroes"; this.audio.sfx("ui"); }
          return;
        }
      }
    } else if (this.state === "over") {
      this.state = "select";
      this.selScreen = "heroes";
      this.audio.sfx("ui");
    }
  }

  // ---------- камера ----------

  /** Точка, за которой следует камера: живой локальный игрок, иначе наблюдение за командой. */
  private camTarget(): PlayerEnt {
    if (this.me.alive) return this.me;
    return this.players.find((p) => p.alive) ?? this.me;
  }

  private camX(): number { return Math.max(0, Math.min(WORLD_SIZE - this.w, this.camTarget().x - this.w / 2)); }
  private camY(): number { return Math.max(0, Math.min(WORLD_SIZE - this.h, this.camTarget().y - this.h / 2)); }

  /** Позиция игрока для self-check (W = вперёд = z уменьшается). */
  probe(): { x: number; y: number; z: number } {
    return { x: this.px, y: 0, z: this.py };
  }

  /** Текущее состояние для автотестов. */
  get stateName(): string { return this.state; }

  /** Сетевая диагностика для автотестов коопа. */
  netInfo(): { mode: string; code: string; lobby: number; enemies: number; players: number } {
    return {
      mode: this.netMode, code: this.net?.code ?? "",
      lobby: this.lobbyPlayers.length, enemies: this.enemies.length, players: this.players.length,
    };
  }

  /** Отладочные хуки для автопроверки (не используются в игре). */
  debugBoss(): void { if (this.netMode !== "client") this.spawnEnemy(true); }
  debugHeal(): void { this.hp = this.maxHp = 9999; this.mana = this.maxMana; }
  debugGold(): void { this.me.gold += 500; }
  debugLvl(): void { this.me.xp = this.me.xpNext; }
  debugWave(): void {
    for (const e of this.enemies) { if (e.nid !== undefined) this.enemyByNid.delete(e.nid); }
    this.enemies = []; this.waveSpawnLeft = 0;
  }
  debugInfo2(): Record<string, unknown> {
    return { ws: this.waveState, bt: +this.breakT.toFixed(1), gold: this.me.gold, pts: this.me.skillPts, sk: this.me.sk, buys: this.me.buys, shop: this.shopOpen, tg: this.telegraphs.length, kills: this.me.kills, paused: this.netPaused, met: this.meteorAnnounced };
  }
  /** Отладка прицела: мировая точка под курсором и её обратная проекция на экран. */
  debugAim(): Record<string, unknown> {
    const scr = this.r3d ? this.r3d.project(this.aimX, 0, this.aimY, this.w, this.h) : null;
    return { aimX: this.aimX, aimY: this.aimY, facing: this.facing, scrX: scr?.x, scrY: scr?.y };
  }
  debugInfo(): Record<string, unknown> {
    return {
      state: this.state, px: this.px, py: this.py, camX: this.camX(), camY: this.camY(),
      shake: this.shake, projs: this.projs.length, waves: this.waves.length,
      cones: this.cones.length, lights: this.tempLights.length, mapReady: !!this.mapCanvas,
      cdT: this.me.cdT, mana: this.me.mana,
    };
  }

  // ---------- рендер ----------

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.state === "select") { if (this.glCanvas) this.glCanvas.style.display = "none"; this.renderSelect(ctx); return; }
    if (this.state === "lobby") { if (this.glCanvas) this.glCanvas.style.display = "none"; this.renderLobby(ctx); return; }
    const camX = this.camX() + (Math.random() - 0.5) * this.shake;
    const camY = this.camY() + (Math.random() - 0.5) * this.shake;
    let tSec = performance.now();

    // 3D-путь: мир рисует WebGL, поверх — 2D-оверлей и HUD
    if (this.r3d) {
      if (this.glCanvas) this.glCanvas.style.display = "";
      ctx.clearRect(0, 0, this.w, this.h);
      this.r3d.render(this.view3d(), this.w, this.h);
      this.drawOverlay3d(ctx);
      if (!this.skipSec.has("hud")) this.renderHud(ctx);
      this.perfSec[4] += performance.now() - tSec;
      return;
    }

    // карта всегда перекрывает весь экран (камера зажата в мир) — полный fillRect нужен только при тряске
    if (this.shake > 0.3 || this.w > WORLD_SIZE || this.h > WORLD_SIZE) {
      ctx.fillStyle = "#0a0c10";
      ctx.fillRect(0, 0, this.w, this.h);
    }
    if (this.mapCanvas) ctx.drawImage(this.mapCanvas, -camX, -camY);
    this.perfSec[0] += performance.now() - tSec; tSec = performance.now();

    // декали: кровь и следы боёв остаются на локации
    if (!this.skipSec.has("decals"))
      for (const d of this.decals) {
        const x = d.x - camX, y = d.y - camY;
        if (x < -60 || x > this.w + 60 || y < -60 || y > this.h + 60) continue;
        ctx.globalAlpha = d.alpha;
        ctx.fillStyle = d.color;
        ctx.beginPath(); ctx.ellipse(x, y, d.r, d.r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      }
    ctx.globalAlpha = 1;

    // сферы здоровья
    for (const o of this.orbs) {
      const pulse = 1 + Math.sin(o.t * 6) * 0.15;
      ctx.fillStyle = "rgba(230,60,60,0.25)";
      ctx.beginPath(); ctx.arc(o.x - camX, o.y - camY, 14 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e83c3c";
      ctx.beginPath(); ctx.arc(o.x - camX, o.y - camY, 8 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(o.x - camX - 4, o.y - camY - 1.5, 8, 3);
      ctx.fillRect(o.x - camX - 1.5, o.y - camY - 4, 3, 8);
    }

    // золото
    for (const gd of this.golds) {
      const pulse3 = 1 + Math.sin(this.time * 5 + gd.x) * 0.15;
      const gx = gd.x - camX, gy = gd.y - camY;
      if (gx < -30 || gx > this.w + 30 || gy < -30 || gy > this.h + 30) continue;
      ctx.fillStyle = "rgba(255,210,74,0.28)";
      ctx.beginPath(); ctx.arc(gx, gy, 11 * pulse3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd24a";
      ctx.beginPath(); ctx.arc(gx, gy, 6 * pulse3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#a87a1e";
      ctx.beginPath(); ctx.arc(gx, gy, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // лут (кристаллы)
    for (const lt of this.loots) {
      const lx2 = lt.x - camX, ly4 = lt.y - camY + Math.sin(this.time * 3 + lt.x) * 4;
      if (lx2 < -40 || lx2 > this.w + 40 || ly4 < -40 || ly4 > this.h + 40) continue;
      const col2 = LOOT[lt.kind].color;
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = col2;
      ctx.beginPath(); ctx.arc(lx2, ly4, 18, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(lx2, ly4);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = col2;
      ctx.fillRect(-7, -7, 14, 14);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-7, -7, 14, 14);
      ctx.restore();
    }

    // телеграфы: красные зоны метеоритов и атак боссов
    for (const tg of this.telegraphs) {
      const tx2 = tg.x - camX, ty2 = tg.y - camY;
      if (tx2 < -tg.r - 40 || tx2 > this.w + tg.r + 40 || ty2 < -tg.r - 40 || ty2 > this.h + tg.r + 40) continue;
      const prog = Math.max(0, Math.min(1, 1 - tg.t / tg.maxT));
      ctx.globalAlpha = 0.22 + 0.12 * Math.sin(this.time * 10);
      ctx.fillStyle = tg.kind === "meteor" ? "#ff6a2c" : "#e83c3c";
      ctx.beginPath(); ctx.arc(tx2, ty2, tg.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = tg.kind === "meteor" ? "#ffb02e" : "#ff5a3c";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(tx2, ty2, tg.r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tx2, ty2, Math.max(4, tg.r * (1 - prog)), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // трупы врагов — падают и растворяются
    if (!this.skipSec.has("corpses"))
      for (const c of this.corpses) {
        const x = c.x - camX, y = c.y - camY;
        if (x < -80 || x > this.w + 80 || y < -100 || y > this.h + 80) continue;
        const t = Math.max(0, c.life / 1.4);
        const img = this.sprites.get(c.sprite);
        if (img && img.complete && img.naturalWidth > 0) {
          const hh = 56 * c.scale;
          const w = hh * (img.width / img.height);
          ctx.save();
          ctx.translate(x, y + 8);
          ctx.rotate((c.flip ? -1 : 1) * (1 - t) * 1.4);
          ctx.globalAlpha = t * 0.75;
          ctx.drawImage(img, -w / 2, -hh, w, hh);
          ctx.restore();
        }
      }

    // след рывка: у Максима — молнии Чидори, у остальных — шлейф
    for (const pl of this.players) {
      if (pl.trail.length <= 1) continue;
      if (pl.hero.id === "maxim") {
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? "rgba(126,200,255,0.35)" : "rgba(240,250,255,0.8)";
          ctx.lineWidth = pass === 0 ? 7 : 2.5;
          ctx.beginPath();
          let first = true;
          for (const tp of pl.trail) {
            const jx = tp.x - camX + (Math.random() - 0.5) * 10;
            const jy = tp.y - camY - 20 + (Math.random() - 0.5) * 10;
            if (first) { ctx.moveTo(jx, jy); first = false; } else ctx.lineTo(jx, jy);
          }
          ctx.stroke();
        }
      } else {
        for (const tp of pl.trail) {
          ctx.globalAlpha = tp.life / 0.35 * 0.3;
          ctx.fillStyle = pl.hero.themeColor;
          ctx.beginPath(); ctx.arc(tp.x - camX, tp.y - camY - 14, 14, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    for (const e of this.enemies) {
      // отсечение вне экрана — в программном рендере каждый лишний спрайт дорог
      if (this.skipSec.has("enemies")) break;
      const sx = e.x - camX, sy = e.y - camY;
      if (sx < -120 || sx > this.w + 120 || sy < -160 || sy > this.h + 120) continue;
      this.drawEnemy(ctx, e, camX, camY);
    }
    for (const s of this.satorus) this.drawSatoru(ctx, s, camX, camY);
    for (const c of this.clones) this.drawClone(ctx, c, camX, camY);
    for (const p of this.players) {
      if (p.isLocal) this.drawPlayer(ctx, camX, camY);
      else this.drawRemotePlayer(ctx, p, camX, camY);
    }
    this.perfSec[1] += performance.now() - tSec; tSec = performance.now();

    // снаряды
    for (const p of this.skipSec.has("projs") ? [] : this.projs) {
      const x = p.x - camX, y = p.y - camY;
      if (p.kind === "bullet") {
        ctx.strokeStyle = p.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x - p.vx * 0.025, y - p.vy * 0.025); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = "#fff8e0";
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "shuriken") {
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.life * 20);
        ctx.fillStyle = p.color;
        for (let k = 0; k < 4; k++) { ctx.rotate(Math.PI / 2); ctx.fillRect(0, -2, p.r + 4, 4); }
        ctx.restore();
      } else if (p.kind === "puck") {
        ctx.strokeStyle = "rgba(126,200,255,0.5)"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x - p.vx * 0.05, y - p.vy * 0.05); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = "#101010";
        ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#7ec8ff"; ctx.lineWidth = 2; ctx.stroke();
      } else if (p.kind === "expelliarmus") {
        // красный луч с белым ядром
        const ang = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        const bg = ctx.createLinearGradient(-70, 0, 10, 0);
        bg.addColorStop(0, "rgba(255,82,82,0)");
        bg.addColorStop(1, "rgba(255,82,82,0.9)");
        ctx.strokeStyle = bg; ctx.lineWidth = 12; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-70, 0); ctx.lineTo(0, 0); ctx.stroke();
        ctx.strokeStyle = "rgba(255,230,230,0.95)"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(6, 0); ctx.stroke();
        ctx.restore();
      } else if (p.kind === "rasenshuriken") {
        // гигантская крутящаяся сфера чакры с лезвиями
        const rot = p.life * 18;
        const gr = p.r * 2.2;
        ctx.drawImage(this.glowSprite("rgba(126,200,255,0.95)"), x - gr, y - gr, gr * 2, gr * 2);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.fillStyle = "rgba(220,240,255,0.9)";
        for (let k = 0; k < 4; k++) {
          ctx.rotate(Math.PI / 2);
          ctx.beginPath();
          ctx.moveTo(0, 0); ctx.lineTo(p.r * 1.9, -5); ctx.lineTo(p.r * 1.9, 5);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(x, y, p.r * 0.55, 0, Math.PI * 2); ctx.fill();
      } else {
        const ang = Math.atan2(p.vy, p.vx);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = p.r;
        ctx.beginPath(); ctx.moveTo(x - Math.cos(ang) * 26, y - Math.sin(ang) * 26); ctx.lineTo(x, y); ctx.stroke();
        ctx.globalAlpha = 1;
        const gr = p.r * 2.4;
        ctx.drawImage(this.glowSprite(p.color), x - gr, y - gr, gr * 2, gr * 2);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(x, y, p.r * 0.45, 0, Math.PI * 2); ctx.fill();
      }
    }

    // частицы
    for (const p of this.skipSec.has("particles") ? [] : this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - camX - p.size / 2, p.y - camY - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // всплывающий текст
    ctx.textAlign = "center";
    ctx.font = "bold 15px Arial";
    for (const f of this.skipSec.has("floaters") ? [] : this.floaters) {
      ctx.globalAlpha = Math.min(1, f.life / 0.4);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x - camX, f.y - camY);
    }
    ctx.globalAlpha = 1;
    this.perfSec[2] += performance.now() - tSec; tSec = performance.now();

    // вспышки конусных атак (Катон, Инсендио, дробовик)
    for (const c of this.cones) {
      const a = Math.max(0, c.life / c.maxLife);
      const x = c.x - camX, y = c.y - camY;
      ctx.globalAlpha = a * 0.45;
      const cg = ctx.createRadialGradient(x, y, 10, x, y, c.range);
      cg.addColorStop(0, "#ffffff");
      cg.addColorStop(0.3, c.color);
      cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, c.range * (1.15 - a * 0.15), c.dir - c.half, c.dir + c.half);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ударные волны (ультимейты, взрывы)
    for (const wv of this.waves) {
      const x = wv.x - camX, y = wv.y - camY;
      if (x < -wv.maxR || x > this.w + wv.maxR || y < -wv.maxR || y > this.h + wv.maxR) continue;
      const a = Math.max(0, wv.life / wv.maxLife);
      ctx.globalAlpha = a * 0.35;
      ctx.strokeStyle = wv.color;
      ctx.lineWidth = wv.width * a * 2.4 + 4;
      ctx.beginPath(); ctx.arc(x, y, wv.r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = a * 0.95;
      ctx.lineWidth = wv.width * a * 0.6 + 2;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(x, y, wv.r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // огненные драконы
    for (const dr of this.dragons) this.drawDragon(ctx, dr, camX, camY);

    if (!this.skipSec.has("light")) this.renderLighting(ctx, camX, camY);
    this.perfSec[3] += performance.now() - tSec; tSec = performance.now();
    if (!this.skipSec.has("hud")) this.renderHud(ctx);
    this.perfSec[4] += performance.now() - tSec;
  }

  /** Диабловское освещение: тьма вокруг, круги света у героя, кота, снарядов и сфер. */
  /** Снимок мира для 3D-рендера (ссылки на живые массивы — без копий). */
  private view3d(): View3D {
    return {
      time: this.time,
      mapCanvas: this.mapCanvas,
      mapId: this.map.id,
      target: { x: this.camTarget().x, y: this.camTarget().y },
      shake: this.shake,
      players: this.players,
      enemies: this.enemies,
      corpses: this.corpses,
      projs: this.projs,
      volleys: this.volleys,
      particles: this.particles,
      waves: this.waves,
      cones: this.cones,
      telegraphs: this.telegraphs,
      decals: this.decals,
      orbs: this.orbs,
      golds: this.golds,
      loots: this.loots,
      satorus: this.satorus,
      clones: this.clones,
      dragons: this.dragons,
      tempLights: this.tempLights,
      meHeroId: this.hero.id,
      bake: (id, cat) => this.bakePuppet(id, cat),
      faceOf: (heroId) => this.faces.get(heroId),
      lootColor: (kind) => LOOT[kind as LootKind].color,
      skip: (sec) => this.skipSec.has(sec),
    };
  }

  /** 2D-оверлей поверх 3D: полоски HP, имена, флотеры — через проекцию мировых координат. */
  private drawOverlay3d(ctx: CanvasRenderingContext2D): void {
    const r3 = this.r3d!;
    ctx.textAlign = "center";
    // враги: полоски HP и статусы
    for (const e of this.enemies) {
      const scale = (e.boss ? 2.1 : 1) * (e.kind.scaleMul ?? 1);
      const hh = e.radius * 3.6 * scale;
      const top = r3.project(e.x, hh + 16, e.y, this.w, this.h);
      if (!top.vis) continue;
      if (e.hp < e.maxHp) {
        const wpx = e.radius * 2.2 * scale;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(top.x - wpx / 2, top.y - 3, wpx, 5);
        ctx.fillStyle = e.boss ? "#e84a4a" : "#5ee87a";
        ctx.fillRect(top.x - wpx / 2, top.y - 3, wpx * Math.max(0, e.hp / e.maxHp), 5);
      }
      if (e.disarmT > 0) { ctx.fillStyle = "#ff5252"; ctx.font = "bold 13px Georgia"; ctx.fillText("ОБЕЗОРУЖЕН", top.x, top.y - 8); }
      if (e.charmT > 0) { ctx.fillStyle = "#3ddc84"; ctx.font = "bold 11px Georgia"; ctx.fillText("ПОДЧИНЁН", top.x, top.y - 8); }
    }
    // кольцо наведения ЛКМ (ближний бой Никиты): подсветка цели под курсором
    if (this.me.alive && this.hero.id === "nikita") {
      const he = this.hoveredEnemy();
      if (he) {
        const c0 = r3.project(he.x, 2, he.y, this.w, this.h);
        const cx = r3.project(he.x + he.radius * 1.4, 2, he.y, this.w, this.h);
        const cz = r3.project(he.x, 2, he.y + he.radius * 1.4, this.w, this.h);
        if (c0.vis) {
          ctx.strokeStyle = "rgba(255,84,60,0.9)";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.ellipse(c0.x, c0.y, Math.max(8, Math.abs(cx.x - c0.x)), Math.max(4, Math.abs(cz.y - c0.y)), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    // удалённые игроки: имя, HP, воскрешение
    for (const p of this.players) {
      if (p.isLocal) continue;
      const sp = r3.project(p.x, 94, p.y, this.w, this.h);
      if (!sp.vis) continue;
      ctx.fillStyle = p.alive ? "#ffe9b0" : "#8a8078";
      ctx.font = "bold 13px Georgia";
      ctx.fillText(p.hero.name, sp.x, sp.y);
      if (p.alive && p.hp < p.maxHp) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(sp.x - 26, sp.y + 5, 52, 5);
        ctx.fillStyle = "#5ee87a";
        ctx.fillRect(sp.x - 26, sp.y + 5, 52 * Math.max(0, p.hp / p.maxHp), 5);
      }
      if (!p.alive) {
        ctx.fillStyle = "#c8352a";
        ctx.font = "bold 12px Georgia";
        ctx.fillText("ПАЛ", sp.x, sp.y - 14);
        if (this.netMode !== "off") {
          if (p.reviveProg > 0) {
            ctx.strokeStyle = "#7ee87a";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y + 30, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.reviveProg);
            ctx.stroke();
            ctx.fillStyle = "#7ee87a";
            ctx.font = "11px Georgia";
            ctx.fillText("воскрешение…", sp.x, sp.y + 62);
          } else {
            ctx.fillStyle = "rgba(126,232,122,0.55)";
            ctx.font = "11px Georgia";
            ctx.fillText("встань рядом — воскресишь", sp.x, sp.y + 62);
          }
        }
      }
    }
    // локальный павший герой
    if (!this.me.alive) {
      const sp = r3.project(this.px, 92, this.py, this.w, this.h);
      if (sp.vis) {
        ctx.fillStyle = "#c8352a";
        ctx.font = "bold 14px Georgia";
        ctx.fillText("ВЫ ПАЛИ", sp.x, sp.y);
      }
    }
    // флотеры
    if (!this.skipSec.has("floaters")) {
      ctx.font = "bold 15px Arial";
      for (const f of this.floaters) {
        const sp = r3.project(f.x, 70, f.y, this.w, this.h);
        if (!sp.vis) continue;
        ctx.globalAlpha = Math.min(1, f.life / 0.4);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, sp.x, sp.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  private renderLighting(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const lc = this.lightCtx;
    if (!lc || !this.lightCanvas) return;
    const darkness = { arena: 0.42, odintsovo: 0.55, school: 0.62, hogwarts: 0.68 }[this.map.id];
    lc.setTransform(this.dpr * 0.35, 0, 0, this.dpr * 0.35, 0, 0);
    lc.globalCompositeOperation = "source-over";
    lc.clearRect(0, 0, this.w, this.h);
    lc.fillStyle = `rgba(3,5,10,${darkness})`;
    lc.fillRect(0, 0, this.w, this.h);
    lc.globalCompositeOperation = "destination-out";
    const light = (x: number, y: number, r: number, strength = 1) => {
      const g = lc.createRadialGradient(x, y, r * 0.15, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${strength})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      lc.fillStyle = g;
      lc.beginPath(); lc.arc(x, y, r, 0, Math.PI * 2); lc.fill();
    };
    for (const p of this.players) {
      if (p.alive) light(p.x - camX, p.y - camY, this.map.id === "arena" ? 240 : 300);
    }
    for (const s of this.satorus) light(s.x - camX, s.y - camY, 170, 0.9);
    for (const e of this.enemies) if (e.boss) light(e.x - camX, e.y - camY, 140, 0.8);
    // вспышки взрывов и заклинаний
    for (const tl of this.tempLights) light(tl.x - camX, tl.y - camY, tl.r, Math.min(1.1, (tl.life / tl.maxLife) * 1.2));
    // запечённая виньетка по краям экрана
    lc.globalCompositeOperation = "source-over";
    if (this.vignette) lc.drawImage(this.vignette, 0, 0, this.w, this.h);
    ctx.drawImage(this.lightCanvas, 0, 0, this.w, this.h);
  }

  private drawFace(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, r: number): void {
    const img = this.faces.get(id);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    else { ctx.fillStyle = "#888"; ctx.fill(); }
    ctx.restore();
  }

  /** id спрайта врагов текущей карты. */
  private enemySpriteId(): string {
    return { arena: "enemy-hockey", odintsovo: "enemy-akatsuki", school: "enemy-gnome", hogwarts: "enemy-deatheater" }[this.map.id];
  }

  /** Предзапечённое радиальное свечение 64×64 (цвет в центре → прозрачность к краю). */
  private glowSprite(color: string): HTMLCanvasElement {
    let c = this.glowCache.get(color);
    if (!c) {
      c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      const g = c.getContext("2d");
      if (g) {
        const gr = g.createRadialGradient(32, 32, 1, 32, 32, 32);
        gr.addColorStop(0, color);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 64, 64);
      }
      this.glowCache.set(color, c);
    }
    return c;
  }

  private drawSprite(
    ctx: CanvasRenderingContext2D, id: string, x: number, y: number,
    height: number, opts: { flip?: boolean; bob?: number; tilt?: number; filter?: string; alpha?: number; scalePulse?: number } = {},
  ): void {
    const img = this.sprites.get(id);
    const ok = img && img.complete && img.naturalWidth > 0;
    const w = ok ? height * (img.width / img.height) : height * 0.65;
    ctx.save();
    ctx.translate(x, y); // y — точка опоры (ступни)
    if (opts.bob) ctx.translate(0, opts.bob);
    if (opts.tilt) ctx.rotate(opts.tilt);
    if (opts.flip) ctx.scale(-1, 1);
    if (opts.scalePulse) ctx.scale(opts.scalePulse, opts.scalePulse);
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    if (opts.filter) ctx.filter = opts.filter;
    if (ok) ctx.drawImage(img, -w / 2, -height, w, height);
    else {
      ctx.fillStyle = "#888";
      ctx.beginPath(); ctx.arc(0, -height / 2, height / 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** Рисует часть тела с поворотом вокруг сустава (в координатах спрайта). */
  private drawPart(
    ctx: CanvasRenderingContext2D, id: string, name: string,
    rig: Record<string, [number, number, number, number]>, W: number, H: number, angle: number,
  ): void {
    const rect = rig[name];
    if (!rect) return;
    const img = this.parts.get(`${id}-${name}`);
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const [x0, y0, x1, y1] = rect;
    const isLeg = name.startsWith("leg");
    const pnx = isLeg ? (x0 + x1) / 2 : name === "armL" ? x1 - 0.07 : x0 + 0.07;
    const pny = isLeg ? y0 + 0.02 : y0 + 0.05;
    ctx.save();
    ctx.translate(pnx * W - W / 2, pny * H - H);
    ctx.rotate(angle);
    ctx.drawImage(img, -(pnx - x0) * W, -(pny - y0) * H, (x1 - x0) * W, (y1 - y0) * H);
    ctx.restore();
  }

  /**
   * Кукольная анимация: ноги шагают в противофазе, руки качаются,
   * при ударе правая рука замахивается. Опора — ступни (y — уровень пола).
   * Быстрый путь: рисует один предзапечённый кадр (один drawImage на персонажа).
   */
  private drawPuppet(
    ctx: CanvasRenderingContext2D, id: string, x: number, y: number, height: number,
    o: { flip?: boolean; walk?: number; filter?: string; alpha?: number; attackT?: number; scalePulse?: number; cat?: boolean } = {},
  ): void {
    if (!o.filter) {
      const b = this.bakePuppet(id, !!o.cat);
      if (b) {
        const TWO_PI = Math.PI * 2;
        const atk = Math.min(1, Math.max(0, o.attackT ?? 0));
        let img: HTMLCanvasElement;
        if (atk > 0.02) img = b.attack[Math.min(3, Math.floor(atk * 4))];
        else {
          const ph = (((o.walk ?? 0) % TWO_PI) + TWO_PI) % TWO_PI;
          img = b.walk[Math.floor((ph / TWO_PI) * 12) % 12];
        }
        const sc = (height / b.H) * (o.scalePulse ?? 1);
        ctx.save();
        ctx.translate(x, y);
        if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
        if (o.flip) ctx.scale(-1, 1);
        ctx.drawImage(img, (-b.W / 2) * sc, -b.H * sc, b.W * sc, b.H * sc);
        ctx.restore();
        return;
      }
    }
    this.drawPuppetRaw(ctx, id, x, y, height, o);
  }

  /** Запекает кадры шага и удара для спрайта (один раз, лениво). */
  private bakePuppet(id: string, cat: boolean): { walk: HTMLCanvasElement[]; attack: HTMLCanvasElement[]; W: number; H: number } | undefined {
    const key = id + (cat ? "|cat" : "");
    const hit = this.baked.get(key);
    if (hit) return hit;
    const torso = this.parts.get(`${id}-torso`);
    if (!torso || !torso.complete || torso.naturalWidth === 0) return undefined; // части ещё грузятся — повторим позже
    const srcH = torso.naturalHeight;
    const H = 160;
    const W = Math.max(2, Math.round((torso.naturalWidth / srcH) * H));
    const mk = (walk: number, attackT: number): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const c2 = c.getContext("2d");
      if (c2) this.drawPuppetRaw(c2, id, W / 2, H, H, { walk, attackT, cat });
      return c;
    };
    const walk: HTMLCanvasElement[] = [];
    for (let i = 0; i < 12; i++) walk.push(mk((i / 12) * Math.PI * 2, 0));
    const attack: HTMLCanvasElement[] = [];
    for (let i = 0; i < 4; i++) attack.push(mk(0, (i + 1) / 4));
    const entry = { walk, attack, W, H };
    this.baked.set(key, entry);
    return entry;
  }

  /** Прямая отрисовка куклы из частей (используется при запекании и как запасной путь). */
  private drawPuppetRaw(
    ctx: CanvasRenderingContext2D, id: string, x: number, y: number, height: number,
    o: { flip?: boolean; walk?: number; filter?: string; alpha?: number; attackT?: number; scalePulse?: number; cat?: boolean } = {},
  ): void {
    const torso = this.parts.get(`${id}-torso`);
    if (!torso || !torso.complete || torso.naturalWidth === 0) {
      this.drawSprite(ctx, id, x, y, height, { flip: o.flip, filter: o.filter, alpha: o.alpha, scalePulse: o.scalePulse });
      return;
    }
    const W = torso.naturalWidth, H = torso.naturalHeight;
    const rig = o.cat ? RIG_CAT : RIG_HUMANOID;
    ctx.save();
    ctx.translate(x, y);
    if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
    if (o.filter) ctx.filter = o.filter;
    if (o.flip) ctx.scale(-1, 1);
    if (o.scalePulse) ctx.scale(o.scalePulse, o.scalePulse);
    ctx.scale(height / H, height / H);
    const sw = Math.sin(o.walk ?? 0);
    const atk = Math.min(1, Math.max(0, o.attackT ?? 0));
    // ноги — за торсом, в противофазе
    this.drawPart(ctx, id, "legL", rig, W, H, sw * (o.cat ? 0.7 : 0.55));
    this.drawPart(ctx, id, "legR", rig, W, H, -sw * (o.cat ? 0.7 : 0.55));
    ctx.drawImage(torso, -W / 2, -H, W, H);
    if (!o.cat) {
      this.drawPart(ctx, id, "armL", rig, W, H, -sw * 0.45);
      this.drawPart(ctx, id, "armR", rig, W, H, sw * 0.45 - Math.sin(atk * Math.PI) * 1.5);
    }
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const x = this.px - camX, y = this.py - camY;
    if (!this.me.alive) {
      // призрак павшего героя в коопе
      ctx.save();
      ctx.globalAlpha = 0.3;
      this.drawPuppet(ctx, "hero-" + this.hero.id, x, y + 26, 76, { flip: false, walk: 0 });
      ctx.restore();
      ctx.textAlign = "center";
      ctx.fillStyle = "#c8352a";
      ctx.font = "bold 14px Georgia";
      ctx.fillText("ВЫ ПАЛИ", x, y - 60);
      return;
    }
    // тень
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath(); ctx.ellipse(x, y + 20, 22, 8, 0, 0, Math.PI * 2); ctx.fill();

    const moving = Math.abs(this.input.moveX) + Math.abs(this.input.moveZ) > 0 || this.dashT > 0;
    const flip = Math.cos(this.facing) < 0;
    const pulse = this.swingT > 0 ? 1 + this.swingT * 0.35 : 1;
    const filter = this.hurtFlash > 0 ? "brightness(2.4) saturate(0.6)" : "";
    const walk = moving ? this.walkPhase * 11 : 0;
    const attackT = this.swingT > 0 ? 1 - Math.min(1, this.swingT / 0.18) : 0;
    // лёгкое покачивание на месте
    const idleBob = moving ? 0 : Math.sin(this.time * 2) * 1.2;

    // маунт под героем (замбони / жаба / бэтмобиль / гиппогриф)
    const mounted = this.me.mountT > 0;
    if (mounted) this.drawMount(ctx, this.hero.id, x, y + 30, flip);
    // ярость Никиты: красная аура и рост
    const raging = this.me.rageT > 0;
    if (raging) {
      const gr = 95;
      ctx.globalAlpha = 0.5 + Math.sin(this.time * 10) * 0.15;
      ctx.drawImage(this.glowSprite("rgba(255,60,30,0.85)"), x - gr, y - 20 - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;
    }
    this.drawPuppet(ctx, "hero-" + this.hero.id, x, y + 26 + idleBob - (mounted ? 34 : 0), 76, { flip, walk: mounted ? 0 : walk, filter, scalePulse: pulse * (raging ? 1.35 : 1), attackT });

    // дуга замаха клюшкой (Никита): белый веер по направлению удара
    if (this.hero.id === "nikita" && this.swingT > 0) {
      const t = 1 - Math.min(1, this.swingT / 0.18);
      const sweep = this.facing - 1.0 + t * 2.0;
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(x, y - 14, 64, sweep - 0.5, sweep); ctx.stroke();
      ctx.globalAlpha = 0.4 * (1 - t);
      ctx.lineWidth = 16;
      ctx.strokeStyle = "#bfe4ff";
      ctx.beginPath(); ctx.arc(x, y - 14, 60, sweep - 0.6, sweep); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // купол Протего
    if (this.shieldT > 0) {
      const a = 0.35 + Math.sin(this.time * 9) * 0.12;
      const g = ctx.createRadialGradient(x, y - 20, 10, x, y - 20, 48);
      g.addColorStop(0, "rgba(181,140,255,0)");
      g.addColorStop(0.8, `rgba(181,140,255,${a * 0.5})`);
      g.addColorStop(1, `rgba(220,190,255,${a})`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, y - 18, 40, 52, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(230,210,255,${a + 0.25})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y - 18, 40, 52, 0, 0, Math.PI * 2); ctx.stroke();
    }

    // вихрь Расенгана во время каста
    if (this.hero.id === "maxim" && this.swingT > 0) {
      const t = this.swingT / 0.25;
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = `rgba(126,200,255,${0.75 - k * 0.2})`;
        ctx.lineWidth = 5 - k;
        ctx.beginPath();
        ctx.arc(x, y - 10, 24 + k * 14 + (1 - t) * 30, this.time * 12 + k * 2.1, this.time * 12 + k * 2.1 + 4.2);
        ctx.stroke();
      }
    }

    // дуга замаха клюшкой
    if (this.hero.id === "nikita" && this.swingT > 0) {
      const t = 1 - this.swingT / 0.18;
      const a0 = this.facing - 0.9 + t * 1.8;
      ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - t)})`;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(x, y, 78, a0 - 0.35, a0 + 0.35); ctx.stroke();
      ctx.strokeStyle = `rgba(126,200,255,${0.5 * (1 - t)})`;
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(x, y, 70, a0 - 0.3, a0 + 0.3); ctx.stroke();
    }

    // вспышка урона
    if (this.hurtFlash > 0) {
      ctx.fillStyle = `rgba(230,50,50,${this.hurtFlash * 0.7})`;
      ctx.beginPath(); ctx.arc(x, y - 16, 30, 0, Math.PI * 2); ctx.fill();
    }
  }

  private drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, camX: number, camY: number): void {
    const x = e.x - camX, y = e.y - camY;
    if (x < -80 || x > this.w + 80 || y < -100 || y > this.h + 80) return;
    const r = e.radius;
    const scale = (e.boss ? 2.1 : 1) * (e.kind.scaleMul ?? 1);
    const hh = r * 3.6 * scale;

    // тень
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 1.1 * scale, r * 0.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
    // телеграф замаха: красная пульсация под врагом перед ударом
    if (e.windup > 0) {
      ctx.globalAlpha = 0.3 + 0.25 * Math.sin(this.time * 30);
      ctx.drawImage(this.glowSprite("rgba(255,60,40,0.9)"), x - r * 1.7, y - r * 1.7, r * 3.4, r * 3.4);
      ctx.globalAlpha = 1;
    }
    // аура босса
    if (e.boss) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.glowSprite("rgba(200,50,30,0.28)"), x - hh * 0.9, y - hh / 2 - hh * 0.9, hh * 1.8, hh * 1.8);
      ctx.globalAlpha = 1;
    }

    const flip = this.px < e.x;
    // выпад при атаке
    let lx = 0, ly = 0;
    if (e.attackCd > 0.7) {
      const t = (e.attackCd - 0.7) / 0.3;
      const d = Math.hypot(this.px - e.x, this.py - e.y) || 1;
      lx = ((this.px - e.x) / d) * 12 * Math.sin(t * Math.PI);
      ly = ((this.py - e.y) / d) * 12 * Math.sin(t * Math.PI);
    }
    const attackT = e.attackCd > 0.7 ? (e.attackCd - 0.7) / 0.3 : 0;
    this.drawPuppet(ctx, e.sprite, x + lx, y + r * 0.9 + ly, hh, { flip, walk: e.anim * 7, attackT });
    // вспышка урона — белое свечение поверх спрайта (без ctx.filter)
    if (e.flash > 0) {
      const a = Math.min(1, e.flash / 0.12);
      ctx.globalAlpha = 0.6 * a;
      ctx.drawImage(this.glowSprite("rgba(255,255,255,0.9)"), x + lx - hh * 0.75, y - hh * 0.45 + ly - hh * 0.75, hh * 1.5, hh * 1.5);
      ctx.globalAlpha = 1;
    }

    if (e.disarmT > 0) {
      ctx.fillStyle = "#ff5252";
      ctx.font = "bold 13px Georgia";
      ctx.textAlign = "center";
      ctx.fillText("ОБЕЗОРУЖЕН", x, y - hh - 14);
    }
    // подчинённый Империусом: зелёное кольцо союзника
    if (e.charmT > 0) {
      ctx.strokeStyle = `rgba(61,220,132,${0.55 + Math.sin(this.time * 6) * 0.2})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 1.5 * scale, r * 0.55 * scale, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#3ddc84";
      ctx.font = "bold 11px Georgia";
      ctx.textAlign = "center";
      ctx.fillText("ПОДЧИНЁН", x, y - hh - 26);
    }
    // полоса HP
    if (e.hp < e.maxHp) {
      const wpx = r * 2.2 * scale;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x - wpx / 2, y - hh - 8, wpx, 5);
      ctx.fillStyle = e.boss ? "#ff7a1a" : "#e84a4a";
      ctx.fillRect(x - wpx / 2, y - hh - 8, wpx * Math.max(0, e.hp / e.maxHp), 5);
    }
    if (e.boss) {
      ctx.fillStyle = "#ffd24a";
      ctx.font = "bold 14px Georgia";
      ctx.textAlign = "center";
      ctx.fillText(e.name, x, y - hh - 24);
    }
  }

  /** Удалённый игрок в коопе: кукла его героя, имя и полоса HP над головой. */
  private drawRemotePlayer(ctx: CanvasRenderingContext2D, p: PlayerEnt, camX: number, camY: number): void {
    const x = p.x - camX, y = p.y - camY;
    if (x < -100 || x > this.w + 100 || y < -140 || y > this.h + 100) return;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath(); ctx.ellipse(x, y + 20, 22, 8, 0, 0, Math.PI * 2); ctx.fill();
    const flip = Math.cos(p.facing) < 0;
    const walk = p.moving ? p.walkPhase * 11 : 0;
    const attackT = p.swingT > 0 ? 1 - Math.min(1, p.swingT / 0.18) : 0;
    const idleBob = p.moving ? 0 : Math.sin(this.time * 2) * 1.2;
    ctx.save();
    if (!p.alive) ctx.globalAlpha = 0.3;
    const mounted = p.mountT > 0 && p.alive;
    if (mounted) this.drawMount(ctx, p.hero.id, x, y + 30, flip);
    if (p.rageT > 0 && p.alive) {
      const gr = 95;
      ctx.globalAlpha = 0.5 + Math.sin(this.time * 10) * 0.15;
      ctx.drawImage(this.glowSprite("rgba(255,60,30,0.85)"), x - gr, y - 20 - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;
    }
    this.drawPuppet(ctx, "hero-" + p.hero.id, x, y + 26 + idleBob - (mounted ? 34 : 0), 76, { flip, walk: mounted ? 0 : walk, attackT, scalePulse: p.rageT > 0 ? 1.35 : 1 });
    ctx.restore();
    // купол Протего чужого игрока
    if (p.shieldT > 0 && p.alive) {
      const a = 0.35 + Math.sin(this.time * 9) * 0.12;
      ctx.strokeStyle = `rgba(230,210,255,${a + 0.25})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y - 18, 40, 52, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // имя и HP
    ctx.textAlign = "center";
    ctx.fillStyle = p.alive ? "#ffe9b0" : "#8a8078";
    ctx.font = "bold 13px Georgia";
    ctx.fillText(p.hero.name, x, y - 66);
    if (p.alive && p.hp < p.maxHp) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x - 26, y - 60, 52, 5);
      ctx.fillStyle = "#5ee87a";
      ctx.fillRect(x - 26, y - 60, 52 * Math.max(0, p.hp / p.maxHp), 5);
    }
    if (!p.alive) {
      ctx.fillStyle = "#c8352a";
      ctx.font = "bold 12px Georgia";
      ctx.fillText("ПАЛ", x, y - 80);
      if (this.netMode !== "off") {
        if (p.reviveProg > 0) {
          ctx.strokeStyle = "#7ee87a";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(x, y - 30, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.reviveProg);
          ctx.stroke();
          ctx.fillStyle = "#7ee87a";
          ctx.font = "11px Georgia";
          ctx.fillText("воскрешение…", x, y - 94);
        } else {
          ctx.fillStyle = "rgba(126,232,122,0.55)";
          ctx.font = "11px Georgia";
          ctx.fillText("встань рядом — воскресишь", x, y - 94);
        }
      }
    }
  }

  /** Теневой клон Максима: полупрозрачная голубая копия героя. */
  private drawClone(ctx: CanvasRenderingContext2D, c: CloneEnt, camX: number, camY: number): void {
    const x = c.x - camX, y = c.y - camY;
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath(); ctx.ellipse(x, y + 20, 20, 7, 0, 0, Math.PI * 2); ctx.fill();
    this.drawPuppet(ctx, "hero-maxim", x, y + 26, 70, { walk: c.walk * 11, alpha: 0.65, filter: "hue-rotate(160deg) brightness(1.3)" });
    ctx.fillStyle = "rgba(159,216,255,0.8)";
    ctx.font = "bold 11px Georgia";
    ctx.textAlign = "center";
    ctx.fillText("КЛОН", x, y - 56);
  }

  /** Огненный дракон: светящееся тело, крылья и шлейф пламени. */
  private drawDragon(ctx: CanvasRenderingContext2D, dr: DragonEnt, camX: number, camY: number): void {
    const x = dr.x - camX, y = dr.y - camY;
    const flap = Math.sin(this.time * 14) * 0.6;
    const dir = dr.ang + Math.PI / 2;
    // свечение
    const gr = 90;
    ctx.drawImage(this.glowSprite("rgba(255,120,40,0.85)"), x - gr, y - gr, gr * 2, gr * 2);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir);
    // крылья
    ctx.fillStyle = "rgba(255,140,60,0.85)";
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.rotate(side * (0.5 + flap * 0.4));
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(side * 70, -22);
      ctx.lineTo(side * 46, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // тело и голова
    ctx.fillStyle = "#ff6a2a";
    ctx.beginPath(); ctx.ellipse(0, 0, 34, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(38, -4, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe08a";
    ctx.beginPath(); ctx.arc(42, -6, 4, 0, Math.PI * 2); ctx.fill();
    // пасть с пламенем
    ctx.fillStyle = "rgba(255,220,120,0.9)";
    ctx.beginPath();
    ctx.moveTo(48, 0); ctx.lineTo(78 + Math.random() * 14, -6); ctx.lineTo(78 + Math.random() * 14, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** Маунт под героем: замбони, жаба, бэтмобиль или гиппогриф. */
  private drawMount(ctx: CanvasRenderingContext2D, heroId: string, x: number, y: number, flip: boolean): void {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    if (heroId === "nikita") {
      // замбони: синяя машина с баком и щёткой
      ctx.fillStyle = "#2a5a9a";
      ctx.fillRect(-46, -26, 92, 26);
      ctx.fillStyle = "#3a7ac0";
      ctx.fillRect(-34, -44, 44, 22);
      ctx.fillStyle = "#bfe4ff";
      ctx.fillRect(-30, -40, 20, 14);
      ctx.fillStyle = "#1a1a1e";
      ctx.beginPath(); ctx.arc(-28, 2, 10, 0, Math.PI * 2); ctx.arc(28, 2, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#8a8a92";
      ctx.fillRect(40, -12, 16, 12); // щётка
    } else if (heroId === "maxim") {
      // жаба: зелёное тело, глаза
      ctx.fillStyle = "#5a8a3a";
      ctx.beginPath(); ctx.ellipse(0, -18, 52, 26, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#7ab54a";
      ctx.beginPath(); ctx.ellipse(0, -10, 44, 16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(22, -40, 9, 0, Math.PI * 2); ctx.arc(40, -38, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1a1a1e";
      ctx.beginPath(); ctx.arc(24, -40, 4, 0, Math.PI * 2); ctx.arc(42, -38, 4, 0, Math.PI * 2); ctx.fill();
    } else if (heroId === "dasha") {
      // бэтмобиль: чёрная машина с плавниками
      ctx.fillStyle = "#14141a";
      ctx.beginPath();
      ctx.moveTo(-52, 0); ctx.lineTo(-38, -22); ctx.lineTo(20, -26); ctx.lineTo(52, -8); ctx.lineTo(52, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#2a2a34";
      ctx.fillRect(-44, -34, 12, 26); // плавник
      ctx.fillStyle = "#ffd24a";
      ctx.fillRect(46, -14, 8, 6); // фара
      ctx.fillStyle = "#0a0a0e";
      ctx.beginPath(); ctx.arc(-24, 2, 11, 0, Math.PI * 2); ctx.arc(26, 2, 11, 0, Math.PI * 2); ctx.fill();
    } else {
      // гиппогриф: серо-коричневое тело с крыльями
      const flap = Math.sin(this.time * 10) * 8;
      ctx.fillStyle = "#8a7a5a";
      ctx.beginPath(); ctx.ellipse(0, -18, 46, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#c9b18a";
      ctx.beginPath(); ctx.arc(40, -34, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e8d9a0";
      ctx.beginPath(); ctx.moveTo(50, -34); ctx.lineTo(64, -30); ctx.lineTo(50, -26); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(200,180,140,0.85)";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-6, -30);
        ctx.lineTo(-30 - flap, -62);
        ctx.lineTo(10, -40);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawSatoru(ctx: CanvasRenderingContext2D, s: SatoruEnt, camX: number, camY: number): void {
    const x = s.x - camX, y = s.y - camY;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(x, y + 16, 26, 9, 0, 0, Math.PI * 2); ctx.fill();
    // бегущий кот: лапы перебирают в противофазе
    const owner = this.players.find((p) => p.pid === s.pid) ?? this.me;
    const flip = Math.cos(Math.atan2(owner.y - s.y, owner.x - s.x)) < 0;
    this.drawPuppet(ctx, "satoru", x, y + 18, 56, { flip, walk: this.time * 16, cat: true });
    // удар когтями — дуги
    if (s.swipeCd > 0.35) {
      const t = (s.swipeCd - 0.35) / 0.2;
      ctx.strokeStyle = `rgba(255,255,255,${t})`;
      ctx.lineWidth = 3;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.arc(x + 20, y - 6, 26 + k * 6, -0.6 + k * 0.15, 0.6 + k * 0.15);
        ctx.stroke();
      }
    }
    // оставшееся время
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 12px Georgia";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.ceil(s.life)}`, x, y - 46);
  }

  // ---------- HUD ----------

  private renderHud(ctx: CanvasRenderingContext2D): void {
    if (this.state === "over") { this.renderOver(ctx); return; }
    const w = this.w, h = this.h;

    // верх: готическая табличка — волна, время, убийства
    ctx.textAlign = "center";
    const tg = ctx.createLinearGradient(0, 8, 0, 56);
    tg.addColorStop(0, "#241d16");
    tg.addColorStop(1, "#120e0a");
    ctx.fillStyle = tg;
    ctx.fillRect(w / 2 - 200, 8, 400, 48);
    ctx.strokeStyle = "#8a6d3b"; ctx.lineWidth = 2.5;
    ctx.strokeRect(w / 2 - 200, 8, 400, 48);
    ctx.strokeStyle = "rgba(138,109,59,0.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(w / 2 - 196, 12, 392, 40);
    ctx.fillStyle = "#e8d9b0";
    ctx.font = "bold 17px Georgia";
    const mm = Math.floor(this.time / 60), ss = Math.floor(this.time % 60);
    ctx.fillText(`Волна ${this.wave}   •   ${mm}:${String(ss).padStart(2, "0")}   •   Убийств: ${this.kills}`, w / 2, 37);

    // состояние волны: перерыв (прокачка/магазин) или счётчик оставшихся
    if (this.waveState === "break") {
      const pulse = 0.7 + 0.3 * Math.sin(this.time * 5);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = "#7ee87a";
      ctx.font = "bold 16px Georgia";
      ctx.fillText(`ПЕРЕРЫВ — ВОЛНА ${this.wave + 1} ЧЕРЕЗ ${Math.ceil(this.breakT)}`, w / 2, 74);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(232,217,176,0.75)";
      ctx.font = "13px Georgia";
      ctx.fillText("1-4 — прокачать навыки • B — магазин", w / 2, 93);
    } else {
      const left = this.waveSpawnLeft + this.enemies.filter((e) => e.charmT <= 0).length;
      ctx.fillStyle = "rgba(232,217,176,0.6)";
      ctx.font = "13px Georgia";
      ctx.fillText(left > 0 ? `до конца волны: ${left} врагов` : "волна зачищена", w / 2, 74);
    }

    // команда в коопе (слева сверху)
    if (this.netMode !== "off") {
      ctx.textAlign = "left";
      let ty = 20;
      ctx.fillStyle = "rgba(232,217,176,0.55)";
      ctx.font = "bold 11px Georgia";
      ctx.fillText("ЛИДЕРБОРД (убийства)", 16, ty - 2);
      ty += 16;
      const ranked = [...this.players].sort((a, b) => b.kills - a.kills);
      for (const p of ranked) {
        ctx.fillStyle = "rgba(10,8,6,0.72)";
        ctx.fillRect(14, ty - 13, 220, 30);
        ctx.strokeStyle = p.isLocal ? "#c9a15a" : "#4a3f32";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(14, ty - 13, 220, 30);
        ctx.fillStyle = p.alive ? "#f0e6d0" : "#7a7066";
        ctx.font = "bold 12px Georgia";
        ctx.fillText(`${p.hero.name}${p.isLocal ? " (ты)" : ""} • ${p.level} • \u2620${p.kills}`, 22, ty + 6);
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(150, ty - 6, 72, 7);
        ctx.fillStyle = p.alive ? "#5ee87a" : "#5a2020";
        ctx.fillRect(150, ty - 6, 72 * Math.max(0, p.hp / p.maxHp), 7);
        ty += 38;
      }
      ctx.textAlign = "center";
    }

    // босс
    const boss = this.enemies.find((e) => e.boss);
    if (boss) {
      ctx.fillStyle = "#120c08";
      ctx.fillRect(w / 2 - 220, 88, 440, 26);
      ctx.strokeStyle = "#8a6d3b"; ctx.lineWidth = 2;
      ctx.strokeRect(w / 2 - 220, 88, 440, 26);
      const bg = ctx.createLinearGradient(w / 2 - 218, 0, w / 2 + 218, 0);
      bg.addColorStop(0, "#7a1408");
      bg.addColorStop(0.5, "#c8352a");
      bg.addColorStop(1, "#7a1408");
      ctx.fillStyle = bg;
      ctx.fillRect(w / 2 - 218, 90, 436 * Math.max(0, boss.hp / boss.maxHp), 22);
      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 14px Georgia";
      ctx.fillText(boss.name, w / 2, 106);
    }

    // анонсы
    ctx.textAlign = "center";
    for (let i = 0; i < this.announces.length; i++) {
      const a = this.announces[i];
      const alpha = Math.min(1, a.life / 0.5, (a.max - a.life) / 0.2);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = "#ffd24a";
      ctx.font = "bold 34px Georgia";
      ctx.fillText(a.text, w / 2, 178 + i * 60);
      if (a.sub) {
        ctx.fillStyle = "#e8d9b0";
        ctx.font = "18px Georgia";
        ctx.fillText(a.sub, w / 2, 206 + i * 60);
      }
    }
    ctx.globalAlpha = 1;

    // ---- низ: диабловский пояс со сферами ----
    const orbR = 58;
    const orbY = h - orbR - 12;
    this.drawOrb(ctx, 26 + orbR, orbY, orbR, Math.max(0, this.hp / this.maxHp), "#5c0a0a", "#e83c3c", `${Math.max(0, Math.ceil(this.hp))}`);
    this.drawOrb(ctx, w - 26 - orbR, orbY, orbR, this.mana / this.maxMana, "#0a1e5c", "#3c7ae8", `${Math.floor(this.mana)}`);
    // золото над левой сферой
    ctx.fillStyle = "#ffd24a";
    ctx.font = "bold 16px Georgia";
    ctx.fillText(`\u25C9 ${this.me.gold}`, 26 + orbR, orbY - orbR - 12);

    // центральная панель
    const pw = 560, ph = 108;
    const px = w / 2 - pw / 2, py = h - ph - 4;
    const pg = ctx.createLinearGradient(0, py, 0, py + ph);
    pg.addColorStop(0, "#2a2320");
    pg.addColorStop(0.5, "#17120f");
    pg.addColorStop(1, "#0d0a08");
    ctx.fillStyle = pg;
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "#8a6d3b"; ctx.lineWidth = 3;
    ctx.strokeRect(px, py, pw, ph);
    ctx.strokeStyle = "#3a2f22"; ctx.lineWidth = 1;
    ctx.strokeRect(px + 4, py + 4, pw - 8, ph - 8);
    // «крылья» панели
    ctx.fillStyle = "#17120f";
    ctx.strokeStyle = "#8a6d3b";
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(px + (dir < 0 ? 0 : pw), py + ph);
      ctx.quadraticCurveTo(px + (dir < 0 ? -34 : pw + 34), py + ph * 0.6, px + (dir < 0 ? -20 : pw + 20), py + 10);
      ctx.lineTo(px + (dir < 0 ? 0 : pw), py + 10);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    // герой и уровень
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd24a";
    ctx.font = "bold 14px Georgia";
    ctx.fillText(`${this.hero.name} • ур. ${this.level} • урон ×${this.dmgMul.toFixed(2)}`, w / 2, py + 20);

    // скиллы
    const slots: Array<{ label: string; name: string; cd: number; max: number; accent?: string; lvl?: number; locked?: boolean }> = [
      { label: "ЛКМ", name: this.hero.basicName, cd: 0, max: 1 },
      { label: "Q", name: this.hero.q.name, cd: Math.max(0, this.cdQ), max: this.hero.q.cooldown, lvl: this.me.sk.q },
      { label: "E", name: this.hero.e.name, cd: Math.max(0, this.cdE), max: this.hero.e.cooldown, lvl: this.me.sk.e },
      { label: "R", name: this.hero.r.name, cd: Math.max(0, this.cdR), max: this.hero.r.cooldown, lvl: this.me.sk.r },
      { label: "T", name: this.me.sk.t === 0 ? `ульт с ${ULT_UNLOCK_LEVEL} ур.` : this.hero.ult.name, cd: Math.max(0, this.cdT), max: this.hero.ult.cooldown, accent: "#ff9a5a", lvl: this.me.sk.t, locked: this.me.sk.t === 0 },
      { label: "F", name: SATORU.name, cd: Math.max(0, this.cdF), max: SATORU.cooldown, accent: "#ffd24a" },
    ];
    const sw = 56, gap = 10;
    const sx = w / 2 - (slots.length * (sw + gap) - gap) / 2;
    for (let i = 0; i < slots.length; i++) {
      const x = sx + i * (sw + gap), y = py + 30;
      const sg = ctx.createLinearGradient(0, y, 0, y + sw);
      sg.addColorStop(0, "#241d18");
      sg.addColorStop(1, "#100c0a");
      ctx.fillStyle = sg;
      ctx.fillRect(x, y, sw, sw);
      ctx.strokeStyle = slots[i].accent ?? "#a08040"; ctx.lineWidth = 2;
      ctx.strokeRect(x, y, sw, sw);
      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 14px Georgia";
      ctx.fillText(slots[i].label, x + sw / 2, y + 20);
      ctx.font = "9px Arial";
      ctx.fillStyle = "#b8a888";
      const nm = slots[i].name;
      ctx.fillText(nm.length > 12 ? nm.slice(0, 11) + "…" : nm, x + sw / 2, y + sw - 6);
      if (slots[i].cd > 0) {
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(x, y, sw, sw * (slots[i].cd / slots[i].max));
        ctx.fillStyle = "#fff";
        ctx.font = "bold 16px Georgia";
        ctx.fillText(slots[i].cd.toFixed(1), x + sw / 2, y + sw / 2 + 6);
      }
      const slvl = slots[i].lvl ?? 0;
      if (slvl > 0) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x + sw - 20, y, 20, 15);
        ctx.fillStyle = slvl >= SKILL_MAX ? "#7ee87a" : "#ffd24a";
        ctx.font = "bold 11px Georgia";
        ctx.textAlign = "right";
        ctx.fillText(`${slvl}`, x + sw - 4, y + 12);
        ctx.textAlign = "center";
      }
      if (slots[i].locked) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x, y, sw, sw);
        ctx.fillStyle = "#8f8272";
        ctx.font = "bold 20px Georgia";
        ctx.fillText("\uD83D\uDD12", x + sw / 2, y + sw / 2 + 7);
      }
    }

    // XP-полоса внизу панели
    ctx.fillStyle = "#0a0806";
    ctx.fillRect(px + 14, py + ph - 12, pw - 28, 7);
    ctx.fillStyle = "#b8a02e";
    ctx.fillRect(px + 14, py + ph - 12, (pw - 28) * Math.min(1, this.xp / this.xpNext), 7);

    // активные баффы (лут)
    const buffs: Array<{ t: number; label: string; color: string }> = [];
    if (this.me.cdRushT > 0) buffs.push({ t: this.me.cdRushT, label: "БЕЗ ПЕРЕЗАРЯДКИ", color: "#7ec8ff" });
    if (this.me.berserkT > 0) buffs.push({ t: this.me.berserkT, label: "БЕРСЕРК x1.5", color: "#ff5a3c" });
    if (this.me.invulnT > 0) buffs.push({ t: this.me.invulnT, label: "НЕУЯЗВИМОСТЬ", color: "#ffd24a" });
    ctx.textAlign = "center";
    for (let i = 0; i < buffs.length; i++) {
      const bxx = w / 2 + (i - (buffs.length - 1) / 2) * 180;
      ctx.fillStyle = "rgba(10,8,6,0.8)";
      ctx.fillRect(bxx - 85, py - 36, 170, 24);
      ctx.strokeStyle = buffs[i].color; ctx.lineWidth = 1.5;
      ctx.strokeRect(bxx - 85, py - 36, 170, 24);
      ctx.fillStyle = buffs[i].color;
      ctx.font = "bold 12px Georgia";
      ctx.fillText(`${buffs[i].label}  ${buffs[i].t.toFixed(0)}с`, bxx, py - 19);
    }

    // доступные очки навыков
    if (this.me.skillPts > 0) {
      const pulse2 = 0.65 + 0.35 * Math.sin(this.time * 6);
      ctx.globalAlpha = pulse2;
      ctx.fillStyle = "#ffd24a";
      ctx.font = "bold 15px Georgia";
      ctx.fillText(`Очков навыков: ${this.me.skillPts} — нажми 1 (Q)  2 (E)  3 (R)  4 (T)`, w / 2, py - 50);
      ctx.globalAlpha = 1;
    }

    // подсказки
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(240,230,208,0.45)";
    ctx.font = "12px Georgia";
    ctx.fillText("WASD — движение • Q/E/R — навыки • T — ульт • F — САТОРУ • 1-4 — прокачка • B — магазин • Esc — пауза • M — звук", w - 20, h - 126);

    if (this.shopOpen) this.renderShop(ctx);

    if (this.state === "pause") {
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8d9b0";
      ctx.font = "bold 44px Georgia";
      ctx.fillText("ПАУЗА", w / 2, h / 2 - 10);
      ctx.font = "18px Georgia";
      ctx.fillText("Esc — продолжить", w / 2, h / 2 + 30);
    }

    if (this.netPaused && this.state === "play") {
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8d9b0";
      ctx.font = "bold 44px Georgia";
      ctx.fillText("ПАУЗА", w / 2, h / 2 - 10);
      ctx.font = "18px Georgia";
      ctx.fillText(this.netMode === "host" ? "Esc — снять паузу" : "хост поставил паузу для всего лобби", w / 2, h / 2 + 30);
    }
  }

  /** Магазин экипировки (перерыв между волнами, клавиша B). */
  private renderShop(ctx: CanvasRenderingContext2D): void {
    const w = this.w, h = this.h;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, h);
    const mw = 780, mh = 430;
    const mx2 = w / 2 - mw / 2, my2 = h / 2 - mh / 2;
    const g2 = ctx.createLinearGradient(0, my2, 0, my2 + mh);
    g2.addColorStop(0, "#241d16");
    g2.addColorStop(1, "#100c0a");
    ctx.fillStyle = g2;
    ctx.fillRect(mx2, my2, mw, mh);
    ctx.strokeStyle = "#c9a15a"; ctx.lineWidth = 3;
    ctx.strokeRect(mx2, my2, mw, mh);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd24a";
    ctx.font = "bold 26px Georgia";
    ctx.fillText("МАГАЗИН ЭКИПИРОВКИ", w / 2, my2 + 42);
    ctx.fillStyle = "#e8d9b0";
    ctx.font = "15px Georgia";
    ctx.fillText(`Золото: \u25C9 ${this.me.gold}    •    клавиши 1-6 — купить    •    B / Esc — закрыть`, w / 2, my2 + 68);
    const cw3 = 240, ch3 = 148, gap3 = 14;
    for (let i = 0; i < SHOP.length; i++) {
      const it = SHOP[i];
      const cx2 = mx2 + 16 + (i % 3) * (cw3 + gap3);
      const cy2 = my2 + 88 + Math.floor(i / 3) * (ch3 + gap3);
      const owned = this.me.buys[i];
      const price = shopPrice(i, owned);
      const afford = this.me.gold >= price;
      ctx.fillStyle = afford ? "rgba(42,32,22,0.95)" : "rgba(20,16,12,0.95)";
      ctx.fillRect(cx2, cy2, cw3, ch3);
      ctx.strokeStyle = afford ? "#8a6d3b" : "#453723";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx2, cy2, cw3, ch3);
      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 15px Georgia";
      ctx.fillText(`${i + 1}. ${it.name}`, cx2 + cw3 / 2, cy2 + 26);
      ctx.fillStyle = "#b8a888";
      ctx.font = "12px Georgia";
      const words = it.desc.split(" ");
      let line = ""; let ly3 = cy2 + 50;
      for (const wd of words) {
        if ((line + " " + wd).trim().length > 30) { ctx.fillText(line.trim(), cx2 + cw3 / 2, ly3); ly3 += 16; line = wd; }
        else line += " " + wd;
      }
      if (line.trim()) ctx.fillText(line.trim(), cx2 + cw3 / 2, ly3);
      ctx.fillStyle = afford ? "#ffd24a" : "#e84a4a";
      ctx.font = "bold 15px Georgia";
      ctx.fillText(`\u25C9 ${price}`, cx2 + cw3 / 2, cy2 + ch3 - 32);
      ctx.fillStyle = "#8f8272";
      ctx.font = "12px Georgia";
      ctx.fillText(`куплено: ${owned}`, cx2 + cw3 / 2, cy2 + ch3 - 12);
    }
  }

  /** Сфера жизни/маны в стиле Diablo: металлическое кольцо, «жидкость», стеклянный блик. */
  private drawOrb(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, frac: number, deep: string, bright: string, text: string): void {
    frac = Math.max(0, Math.min(1, frac));
    // жидкость
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 6, 0, Math.PI * 2); ctx.clip();
    const lg = ctx.createLinearGradient(0, cy + r, 0, cy - r);
    lg.addColorStop(0, deep);
    lg.addColorStop(1, bright);
    ctx.fillStyle = "#120a0a";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    const lvl = cy + (r - 6) - frac * (r - 6) * 2;
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r);
    ctx.lineTo(cx - r, lvl);
    for (let x = cx - r; x <= cx + r; x += 6) {
      ctx.lineTo(x, lvl + Math.sin(x * 0.15 + this.time * 3) * 2.5);
    }
    ctx.lineTo(cx + r, cy + r);
    ctx.closePath(); ctx.fill();
    // стеклянный блик
    const hg = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 2, cx - r * 0.35, cy - r * 0.45, r * 0.9);
    hg.addColorStop(0, "rgba(255,255,255,0.35)");
    hg.addColorStop(0.4, "rgba(255,255,255,0.06)");
    hg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    // металлическое кольцо
    const rg = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    rg.addColorStop(0, "#8a8a92");
    rg.addColorStop(0.5, "#3a3a42");
    rg.addColorStop(1, "#6a6a72");
    ctx.strokeStyle = rg;
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r - 7, 0, Math.PI * 2); ctx.stroke();
    // значение
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px Georgia";
    ctx.textAlign = "center";
    ctx.fillText(text, cx, cy + 5);
  }

  private renderSelect(ctx: CanvasRenderingContext2D): void {
    const w = this.w, h = this.h;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#070509");
    g.addColorStop(0.6, "#140a0c");
    g.addColorStop(1, "#1e0e10");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(200,40,30,0.8)";
    ctx.shadowBlur = 26;
    ctx.fillStyle = "#c8352a";
    ctx.font = "bold 54px Georgia";
    ctx.fillText("СВАДЕБНАЯ ДИАБЛА", w / 2, 92);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(138,109,59,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2 - 320, 112); ctx.lineTo(w / 2 + 320, 112); ctx.stroke();
    ctx.fillStyle = "#d8cbaa";
    ctx.font = "18px Georgia";
    ctx.fillText("Выбери героя: клик / клавиши 1–4, старт — Space или повторный клик", w / 2, 140);

    const cw = 250, ch = 400, gap = 28;
    const total = HEROES.length * (cw + gap) - gap;
    const x0 = w / 2 - total / 2;
    const y0 = 170;
    this.cardRects = [];

    for (let i = 0; i < HEROES.length; i++) {
      const hero = HEROES[i];
      const x = x0 + i * (cw + gap);
      this.cardRects.push({ x, y: y0, w: cw, h: ch });
      const sel = i === this.selIndex;
      const hover = this.mx >= x && this.mx <= x + cw && this.my >= y0 && this.my <= y0 + ch;

      ctx.fillStyle = sel ? "rgba(52,26,20,0.95)" : "rgba(16,12,14,0.92)";
      ctx.fillRect(x, y0, cw, ch);
      ctx.strokeStyle = sel ? "#c9a15a" : hover ? "#7a6030" : "#3a2f28";
      ctx.lineWidth = sel ? 4 : 2;
      ctx.strokeRect(x, y0, cw, ch);
      ctx.strokeStyle = "rgba(138,109,59,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 5, y0 + 5, cw - 10, ch - 10);

      const himg = this.sprites.get("hero-" + hero.id);
      if (himg && himg.complete && himg.naturalWidth > 0) {
        const hh = 148, ww = hh * (himg.width / himg.height);
        ctx.drawImage(himg, x + cw / 2 - ww / 2, y0 + 8, ww, hh);
      } else {
        this.drawFace(ctx, hero.id, x + cw / 2, y0 + 78, 56);
        ctx.strokeStyle = sel ? "#c9a15a" : hero.themeColor; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x + cw / 2, y0 + 78, 56, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 26px Georgia";
      ctx.fillText(hero.name, x + cw / 2, y0 + 168);
      ctx.fillStyle = hero.themeColor;
      ctx.font = "15px Georgia";
      ctx.fillText(hero.title, x + cw / 2, y0 + 192);
      ctx.fillStyle = "#b8a888";
      ctx.font = "14px Georgia";
      ctx.fillText(hero.mapName, x + cw / 2, y0 + 218);
      ctx.fillText(`Оружие: ${hero.weaponName}`, x + cw / 2, y0 + 240);

      ctx.textAlign = "left";
      ctx.fillStyle = "#d8cbaa";
      ctx.font = "13px Georgia";
      ctx.fillText(`ЛКМ — ${hero.basicName}`, x + 16, y0 + 266);
      ctx.fillText(`Q — ${hero.q.name}`, x + 16, y0 + 285);
      ctx.fillText(`E — ${hero.e.name}`, x + 16, y0 + 304);
      ctx.fillText(`R — ${hero.r.name}`, x + 16, y0 + 323);
      ctx.fillStyle = "#ff9a5a";
      ctx.fillText(`T — ${hero.ult.name}`, x + 16, y0 + 342);
      ctx.fillStyle = "#c9a15a";
      ctx.fillText(`F — ${SATORU.name}`, x + 16, y0 + 361);
      ctx.textAlign = "center";

      const best = this.best[hero.id];
      ctx.fillStyle = "#8f8578";
      ctx.font = "12px Arial";
      ctx.fillText(
        best ? `рекорд: ${Math.floor(best.time / 60)}:${String(best.time % 60).padStart(2, "0")}, ${best.kills} уб., ур. ${best.level}` : "ещё не играл",
        x + cw / 2, y0 + 372,
      );
      ctx.fillStyle = "#6f6578";
      ctx.font = "bold 13px Arial";
      ctx.fillText(`[ ${i + 1} ]`, x + cw / 2, y0 + 388);
    }

    ctx.fillStyle = "#8f8272";
    ctx.font = "15px Georgia";
    ctx.fillText("Волны идут раундами с перерывами: прокачивай навыки (1-4) и покупай экипировку в магазине (B).", w / 2, y0 + ch + 44);
    ctx.fillText("Каждая третья волна — босс-волна. Из врагов падает золото и лут. Ультимейт открывается с 6 уровня.", w / 2, y0 + ch + 68);

    // кнопки режимов
    this.menuBtns = [];
    const bw = 220, bh = 52, bgap = 24;
    const bx = w / 2 - (3 * bw + 2 * bgap) / 2;
    const by = y0 + ch + 88;
    const btns: Array<{ act: string; label: string; sub: string; color: string }> = [
      { act: "solo", label: "ИГРАТЬ ОДНОМУ", sub: "Space", color: "#8a6d3b" },
      { act: "create", label: "СОЗДАТЬ ЛОББИ", sub: "C", color: "#3d6b3a" },
      { act: "join", label: "ВОЙТИ ПО КОДУ", sub: "J", color: "#3a5a7a" },
    ];
    for (let i = 0; i < btns.length; i++) {
      const x = bx + i * (bw + bgap);
      this.menuBtns.push({ x, y: by, w: bw, h: bh, act: btns[i].act });
      const hover = this.mx >= x && this.mx <= x + bw && this.my >= by && this.my <= by + bh;
      ctx.fillStyle = hover ? "rgba(50,38,26,0.95)" : "rgba(20,15,12,0.92)";
      ctx.fillRect(x, by, bw, bh);
      ctx.strokeStyle = hover ? "#e8d9b0" : btns[i].color;
      ctx.lineWidth = hover ? 3 : 2;
      ctx.strokeRect(x, by, bw, bh);
      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 16px Georgia";
      ctx.fillText(btns[i].label, x + bw / 2, by + 24);
      ctx.fillStyle = "#8f8272";
      ctx.font = "12px Georgia";
      ctx.fillText(`клавиша ${btns[i].sub}`, x + bw / 2, by + 42);
    }

    // экран ввода кода лобби
    if (this.selScreen === "join") {
      ctx.fillStyle = "rgba(4,3,6,0.88)";
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8d9b0";
      ctx.font = "bold 34px Georgia";
      ctx.fillText("ВВЕДИ КОД ЛОББИ", w / 2, h / 2 - 90);
      ctx.font = "16px Georgia";
      ctx.fillStyle = "#8f8272";
      ctx.fillText("Спроси код у друга, который создал лобби (клавиша C)", w / 2, h / 2 - 56);
      // окошко кода
      const cw2 = 320;
      ctx.fillStyle = "rgba(20,15,12,0.95)";
      ctx.fillRect(w / 2 - cw2 / 2, h / 2 - 30, cw2, 84);
      ctx.strokeStyle = "#c9a15a";
      ctx.lineWidth = 3;
      ctx.strokeRect(w / 2 - cw2 / 2, h / 2 - 30, cw2, 84);
      ctx.fillStyle = "#ffd24a";
      ctx.font = "bold 44px 'Courier New', monospace";
      const code = this.joinCode.padEnd(5, "·");
      ctx.fillText(code.split("").join(" "), w / 2, h / 2 + 26);
      ctx.fillStyle = "#8f8272";
      ctx.font = "15px Georgia";
      ctx.fillText("Enter — войти • Backspace — стереть • Esc — назад", w / 2, h / 2 + 90);
      if (this.lobbyError) {
        ctx.fillStyle = "#e84a4a";
        ctx.font = "bold 16px Georgia";
        ctx.fillText(this.lobbyError, w / 2, h / 2 + 124);
      }
    }
  }

  /** Экран лобби: код комнаты, список игроков, выбор героя. */
  private renderLobby(ctx: CanvasRenderingContext2D): void {
    const w = this.w, h = this.h;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#070509");
    g.addColorStop(0.6, "#0e0a14");
    g.addColorStop(1, "#101a12");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.fillStyle = "#c9a15a";
    ctx.font = "bold 40px Georgia";
    ctx.fillText("ЛОББИ", w / 2, 76);

    // код комнаты
    if (this.netMode === "host") {
      ctx.fillStyle = "#8f8272";
      ctx.font = "17px Georgia";
      ctx.fillText("Позови друзей: они жмут «Войти по коду» (J) и вводят:", w / 2, 116);
      ctx.fillStyle = "#ffd24a";
      ctx.font = "bold 58px 'Courier New', monospace";
      ctx.shadowColor = "rgba(255,210,74,0.5)";
      ctx.shadowBlur = 18;
      ctx.fillText((this.net?.code ?? "").split("").join(" "), w / 2, 178);
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = "#8f8272";
      ctx.font = "18px Georgia";
      ctx.fillText(
        this.hostPeerId ? `Подключено к лобби ${this.net?.code}` : `Подключение к ${this.net?.code}…`,
        w / 2, 150,
      );
    }

    // игроки
    ctx.fillStyle = "#e8d9b0";
    ctx.font = "bold 22px Georgia";
    ctx.fillText(`Игроки (${this.lobbyPlayers.length || 1}/6):`, w / 2, 232);
    ctx.font = "19px Georgia";
    const list = this.lobbyPlayers.length ? this.lobbyPlayers : [{ pid: this.myPid, hero: HEROES[this.selIndex].id, host: this.netMode === "host" }];
    for (let i = 0; i < list.length; i++) {
      const lp = list[i];
      const hh = heroById(lp.hero);
      const y = 268 + i * 34;
      ctx.fillStyle = lp.pid === this.myPid ? "#ffd24a" : "#d8cbaa";
      ctx.fillText(`${hh.name} — ${hh.title}${lp.host ? " 👑" : ""}${lp.pid === this.myPid ? " (ты)" : ""}`, w / 2, y);
    }

    // выбранная карта
    const lobbyMapName = this.lobbyMap === "coop" ? "ВСЕ АРЕНЫ (враги со всех карт)" : ((MAPS as Record<string, MapDef>)[this.lobbyMap]?.name ?? this.lobbyMap);
    ctx.fillStyle = "#e8d9b0";
    ctx.font = "bold 18px Georgia";
    ctx.fillText(`Карта: ${lobbyMapName}`, w / 2, 268 + list.length * 34 + 4);
    if (this.netMode === "host") {
      ctx.fillStyle = "#8f8272";
      ctx.font = "13px Georgia";
      ctx.fillText("← → — сменить карту", w / 2, 268 + list.length * 34 + 24);
    }

    // выбор героя — те же карточки, компактно
    const cw = 150, ch = 190, gap = 18;
    const total = HEROES.length * (cw + gap) - gap;
    const x0 = w / 2 - total / 2;
    const y0 = 268 + list.length * 34 + 44;
    this.cardRects = [];
    for (let i = 0; i < HEROES.length; i++) {
      const hero = HEROES[i];
      const x = x0 + i * (cw + gap);
      this.cardRects.push({ x, y: y0, w: cw, h: ch });
      const sel = i === this.selIndex;
      ctx.fillStyle = sel ? "rgba(52,26,20,0.95)" : "rgba(16,12,14,0.92)";
      ctx.fillRect(x, y0, cw, ch);
      ctx.strokeStyle = sel ? "#c9a15a" : "#3a2f28";
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.strokeRect(x, y0, cw, ch);
      const himg = this.sprites.get("hero-" + hero.id);
      if (himg && himg.complete && himg.naturalWidth > 0) {
        const hh2 = 104, ww = hh2 * (himg.width / himg.height);
        ctx.drawImage(himg, x + cw / 2 - ww / 2, y0 + 8, ww, hh2);
      }
      ctx.fillStyle = "#f0e6d0";
      ctx.font = "bold 17px Georgia";
      ctx.fillText(hero.name, x + cw / 2, y0 + 134);
      ctx.fillStyle = "#b8a888";
      ctx.font = "12px Georgia";
      ctx.fillText(hero.weaponName, x + cw / 2, y0 + 154);
      ctx.fillStyle = "#6f6578";
      ctx.font = "bold 12px Arial";
      ctx.fillText(`[ ${i + 1} ]`, x + cw / 2, y0 + 176);
    }

    // кнопки
    this.menuBtns = [];
    const by = y0 + ch + 26;
    if (this.netMode === "host") {
      const bw = 260, bh = 52;
      this.menuBtns.push({ x: w / 2 - bw / 2, y: by, w: bw, h: bh, act: "start" });
      const can = this.lobbyPlayers.length >= 2;
      ctx.fillStyle = can ? "rgba(40,60,30,0.95)" : "rgba(24,20,16,0.9)";
      ctx.fillRect(w / 2 - bw / 2, by, bw, bh);
      ctx.strokeStyle = can ? "#7ab54a" : "#4a3f32";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(w / 2 - bw / 2, by, bw, bh);
      ctx.fillStyle = can ? "#d8f0b0" : "#8f8272";
      ctx.font = "bold 20px Georgia";
      ctx.fillText(can ? "НАЧАТЬ БОЙ (Space)" : "ЖДЁМ ИГРОКОВ…", w / 2, by + 33);
    } else {
      ctx.fillStyle = "#8f8272";
      ctx.font = "17px Georgia";
      ctx.fillText("Ждём, пока хост начнёт бой…", w / 2, by + 30);
    }
    // выход
    const lw = 200, lh = 40;
    this.menuBtns.push({ x: w / 2 - lw / 2, y: by + 66, w: lw, h: lh, act: "leave" });
    ctx.fillStyle = "rgba(30,18,16,0.9)";
    ctx.fillRect(w / 2 - lw / 2, by + 66, lw, lh);
    ctx.strokeStyle = "#6a4a3a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(w / 2 - lw / 2, by + 66, lw, lh);
    ctx.fillStyle = "#c89a8a";
    ctx.font = "15px Georgia";
    ctx.fillText("Покинуть лобби (Esc)", w / 2, by + 91);

    if (this.lobbyError) {
      ctx.fillStyle = "#e84a4a";
      ctx.font = "bold 16px Georgia";
      ctx.fillText(this.lobbyError, w / 2, by + 132);
    }
  }

  private renderOver(ctx: CanvasRenderingContext2D): void {
    const w = this.w, h = this.h;
    ctx.fillStyle = "rgba(8,2,2,0.78)";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(200,40,30,0.9)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#c8352a";
    ctx.font = "bold 58px Georgia";
    ctx.fillText("ГЕРОЙ ПАЛ", w / 2, h / 2 - 120);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#f0e6d0";
    ctx.font = "22px Georgia";
    const s = this.overStats;
    const mm = Math.floor(s.time / 60), ss = Math.floor(s.time % 60);
    ctx.fillText(`${this.hero.name} • ${this.map.name}`, w / 2, h / 2 - 60);
    ctx.fillText(`Продержался: ${mm}:${String(ss).padStart(2, "0")}`, w / 2, h / 2 - 20);
    ctx.fillText(`Волна ${s.wave} • Убийств: ${s.kills} • Уровень ${s.level}`, w / 2, h / 2 + 12);
    const best = this.best[this.hero.id];
    if (best) {
      ctx.fillStyle = "#ffd24a";
      ctx.font = "17px Arial";
      ctx.fillText(`Рекорд героя: ${Math.floor(best.time / 60)}:${String(best.time % 60).padStart(2, "0")}, ${best.kills} уб., ур. ${best.level}`, w / 2, h / 2 + 48);
    }
    ctx.fillStyle = "#cfc4b0";
    ctx.font = "19px Arial";
    ctx.fillText("Enter или клик — к выбору героя", w / 2, h / 2 + 100);
  }
}
