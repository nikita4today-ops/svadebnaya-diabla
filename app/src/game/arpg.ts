/**
 * arpg.ts — «Свадебная Диабла»: изометрический hack-and-slash на 2D-canvas.
 * Четыре героя, четыре тематические локации, волны каждые 30 секунд,
 * боссы каждые 90 секунд, прокачка урона за убийства и кот САТОРУ на ульте.
 */

import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import {
  HEROES, MAPS, WORLD_SIZE, XP_BASE, WAVE_PERIOD, BOSS_PERIOD, SATORU_DURATION,
} from "./heroes";
import type { HeroDef, EnemyKindDef, MapDef } from "./heroes";
import { paintMap } from "./maps";

type GameState = "select" | "play" | "pause" | "over";

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
}

interface Corpse { x: number; y: number; sprite: string; life: number; flip: boolean; scale: number }

interface Proj {
  x: number; y: number; vx: number; vy: number;
  dmg: number; r: number; friendly: boolean; pierce: boolean;
  life: number; color: string; kind: string; disarm: boolean;
  hitSet: Set<Enemy> | null;
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; size: number }
interface Floater { x: number; y: number; text: string; color: string; life: number }
interface Orb { x: number; y: number; heal: number; t: number }
interface Announce { text: string; sub: string; life: number; max: number }

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
  private walkPhase = 0;
  private trail: Array<{ x: number; y: number; life: number }> = [];
  private corpses: Corpse[] = [];

  private hero: HeroDef = HEROES[0];
  private map: MapDef = MAPS.arena;
  private selIndex = 0;

  // игрок
  private px = WORLD_SIZE / 2; private py = WORLD_SIZE / 2;
  private facing = 0;
  private hp = 100; private maxHp = 100;
  private level = 1; private xp = 0; private xpNext = XP_BASE;
  private dmgMul = 1;
  private cdBasic = 0; private cdQ = 0; private cdE = 0; private cdR = 0;
  private mana = 100; private maxMana = 100;
  private dashT = 0; private dashDx = 0; private dashDy = 0; private dashDmgMul = 0; private dashHits = new Set<Enemy>();
  private iframes = 0; private shieldT = 0; private speedBuffT = 0;
  private swingT = 0; private hurtFlash = 0;

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
  private orbs: Orb[] = [];
  private announces: Announce[] = [];
  private time = 0; private kills = 0;
  private wave = 1; private hpMul = 1; private dmgMulE = 1;
  private spawnT = 0; private nextBossAt = BOSS_PERIOD;
  private bossAlive = false;
  private satoru: { x: number; y: number; life: number; swipeCd: number } | null = null;
  private shake = 0;
  private overStats = { time: 0, kills: 0, level: 1, wave: 1 };
  private best: BestMap = loadBest();

  // мышь
  private mx = 0; private my = 0; private mouseDown = false;
  private cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private unsub: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.input = new Input(canvas);
    this.resize();
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
    this.loop.stop();
    this.input.dispose();
    this.audio.dispose();
    for (const f of this.unsub) f();
    this.unsub = [];
  }

  // ---------- управление состоянием ----------

  private startRun(hero: HeroDef): void {
    this.hero = hero;
    this.map = MAPS[hero.mapId];
    this.mapCanvas = paintMap(hero.mapId);
    this.px = WORLD_SIZE / 2; this.py = WORLD_SIZE / 2;
    this.maxHp = hero.hp; this.hp = hero.hp;
    this.level = 1; this.xp = 0; this.xpNext = XP_BASE;
    this.dmgMul = 1;
    this.cdBasic = this.cdQ = this.cdE = this.cdR = 0;
    this.mana = this.maxMana;
    this.dashT = 0; this.iframes = 0; this.shieldT = 0; this.speedBuffT = 0;
    this.enemies = []; this.projs = []; this.particles = []; this.floaters = []; this.orbs = [];
    this.decals = [];
    this.time = 0; this.kills = 0;
    this.wave = 1; this.hpMul = 1; this.dmgMulE = 1;
    this.spawnT = 0.5; this.nextBossAt = BOSS_PERIOD; this.bossAlive = false;
    this.satoru = null; this.shake = 0;
    this.state = "play";
    this.audio.startMusic();
    this.announce(this.map.name.toUpperCase(), `${hero.name} в деле — ${this.map.subtitle}`);
  }

  private gameOver(): void {
    this.overStats = { time: this.time, kills: this.kills, level: this.level, wave: this.wave };
    const prev = this.best[this.hero.id];
    if (!prev || this.time > prev.time) {
      this.best[this.hero.id] = { time: Math.floor(this.time), kills: this.kills, level: this.level };
      saveBest(this.best);
    }
    this.state = "over";
    this.audio.sfx("lose");
    this.audio.stopMusic();
  }

  private announce(text: string, sub = ""): void {
    this.announces.push({ text, sub, life: 2.6, max: 2.6 });
  }

  // ---------- апдейт ----------

  private update(dt: number): void {
    // глобальные клавиши
    if (this.input.consumeAction("KeyM")) this.audio.toggleMute();
    if (this.state === "select") {
      for (let i = 0; i < HEROES.length; i++) {
        if (this.input.consumeAction(`Digit${i + 1}`)) { this.selIndex = i; this.audio.sfx("ui"); }
      }
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        this.audio.sfx("ui");
        this.startRun(HEROES[this.selIndex]);
      }
      return;
    }
    if (this.state === "over") {
      if (this.input.consumeAction("Enter") || this.input.consumeAction("Space")) { this.state = "select"; this.audio.sfx("ui"); }
      return;
    }
    if (this.input.consumeAction("Escape")) {
      this.state = this.state === "pause" ? "play" : "pause";
      this.audio.sfx("ui");
    }
    if (this.state === "pause") return;

    this.time += dt;

    // волны: каждые WAVE_PERIOD секунд врагов больше и они сильнее
    const w = Math.floor(this.time / WAVE_PERIOD) + 1;
    if (w !== this.wave) {
      this.wave = w;
      this.hpMul = Math.pow(1.15, w - 1);
      this.dmgMulE = Math.pow(1.11, w - 1);
      this.announce(`ВОЛНА ${w}`, "врагов больше, и они сильнее!");
      this.audio.sfx("explosion");
    }

    // таймеры игрока
    this.cdBasic -= dt; this.cdQ -= dt; this.cdE -= dt; this.cdR -= dt;
    this.mana = Math.min(this.maxMana, this.mana + 9 * dt);
    this.iframes -= dt; this.shieldT -= dt; this.speedBuffT -= dt;
    this.swingT -= dt; this.hurtFlash -= dt;

    // прицел
    const camX = this.camX(), camY = this.camY();
    this.facing = Math.atan2(camY + this.my - this.py, camX + this.mx - this.px);

    // движение
    let sp = this.hero.speed * (this.speedBuffT > 0 ? 1.25 : 1);
    let moving = false;
    if (this.dashT > 0) {
      this.dashT -= dt;
      moving = true;
      this.trail.push({ x: this.px, y: this.py, life: 0.35 });
      if (this.trail.length > 40) this.trail.shift();
      const dsp = this.hero.id === "maxim" ? 1050 : this.hero.id === "nikita" ? 900 : 820;
      this.px += this.dashDx * dsp * dt;
      this.py += this.dashDy * dsp * dt;
      if (this.dashDmgMul > 0) {
        for (const e of this.enemies) {
          if (this.dashHits.has(e)) continue;
          const d = Math.hypot(e.x - this.px, e.y - this.py);
          if (d < e.radius + 30) {
            this.dashHits.add(e);
            this.damageEnemy(e, this.basicDmg() * this.dashDmgMul, this.dashDx * 320, this.dashDy * 320);
          }
        }
      }
      if (this.hero.id === "maxim") this.spawnParticles(this.px, this.py, 2, "#9fd8ff", 120);
    } else {
      const ix = this.input.moveX, iz = this.input.moveZ;
      const len = Math.hypot(ix, iz) || 1;
      moving = Math.abs(ix) + Math.abs(iz) > 0;
      this.px += (ix / len) * sp * dt * (moving ? 1 : 0);
      this.py += (-iz / len) * sp * dt * (moving ? 1 : 0);
    }
    if (moving) this.walkPhase += dt * (this.dashT > 0 ? 2.2 : 1);
    this.px = Math.max(40, Math.min(WORLD_SIZE - 40, this.px));
    this.py = Math.max(40, Math.min(WORLD_SIZE - 40, this.py));

    // атаки
    if (this.mouseDown && this.cdBasic <= 0 && this.dashT <= 0) this.basicAttack();
    if (this.input.consumeAction("KeyQ") && this.cdQ <= 0) this.castQ();
    if (this.input.consumeAction("KeyE") && this.cdE <= 0) this.castE();
    if ((this.input.consumeAction("KeyR") || this.input.consumeAction("KeyF")) && this.cdR <= 0) this.castSatoru();

    // спавн
    const cap = Math.min(70, 6 + this.wave * 3);
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.enemies.length < cap) {
      this.spawnT = Math.max(0.7, 1.8 - this.wave * 0.08);
      const batch = Math.min(cap - this.enemies.length, 2 + Math.floor(this.wave / 2));
      for (let i = 0; i < batch; i++) this.spawnEnemy(false);
    }
    if (this.time >= this.nextBossAt) {
      this.nextBossAt += BOSS_PERIOD;
      this.spawnEnemy(true);
      this.announce(`БОСС: ${this.map.bossName}`, "постарайся выжить!");
      this.audio.sfx("lose");
    }

    this.updateEnemies(dt);
    this.updateProjs(dt);
    this.updateSatoru(dt);
    this.updateFx(dt);

    // сферы здоровья
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.t += dt;
      const d = Math.hypot(o.x - this.px, o.y - this.py);
      if (d < 110) { o.x += (this.px - o.x) / d * 300 * dt; o.y += (this.py - o.y) / d * 300 * dt; }
      if (d < 26) {
        this.hp = Math.min(this.maxHp, this.hp + o.heal);
        this.floaters.push({ x: this.px, y: this.py - 30, text: `+${o.heal}`, color: "#5ee87a", life: 0.9 });
        this.audio.sfx("pickup");
        this.orbs.splice(i, 1);
      } else if (o.t > 20) this.orbs.splice(i, 1);
    }

    // уровень
    if (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = Math.floor(XP_BASE * Math.pow(this.level, 1.32));
      this.dmgMul *= 1.22;
      this.maxHp += 15;
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.35);
      this.announce(`УРОВЕНЬ ${this.level}!`, "удары стали мощнее");
      this.spawnParticles(this.px, this.py, 40, "#ffd24a", 320);
      this.audio.sfx("win");
    }

    this.shake *= Math.pow(0.001, dt);
    if (this.hp <= 0) this.gameOver();
  }

  private basicDmg(): number {
    const base = { nikita: 26, maxim: 16, dasha: 14, vika: 18 }[this.hero.id];
    return base * this.dmgMul;
  }

  // ---------- атаки и способности ----------

  private basicAttack(): void {
    const dir = this.facing;
    if (this.hero.id === "nikita") {
      this.cdBasic = 0.42;
      this.swingT = 0.18;
      let hit = false;
      for (const e of this.enemies) {
        const d = Math.hypot(e.x - this.px, e.y - this.py);
        const ang = Math.atan2(e.y - this.py, e.x - this.px);
        let diff = ang - dir;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (d < 95 + e.radius && Math.abs(diff) < 0.95) {
          this.damageEnemy(e, this.basicDmg(), Math.cos(ang) * 220, Math.sin(ang) * 220);
          hit = true;
        }
      }
      this.audio.sfx(hit ? "hit" : "move");
    } else {
      const spec = {
        maxim: { sp: 720, r: 7, cd: 0.32, color: "#d8e2e8", kind: "shuriken" },
        dasha: { sp: 950, r: 4, cd: 0.2, color: "#ffd24a", kind: "bullet" },
        vika: { sp: 660, r: 8, cd: 0.38, color: "#b58cff", kind: "bolt" },
      }[this.hero.id];
      this.cdBasic = spec.cd;
      this.swingT = 0.15; // взмах рукой при броске/выстреле/касте
      this.projs.push({
        x: this.px + Math.cos(dir) * 26, y: this.py + Math.sin(dir) * 26,
        vx: Math.cos(dir) * spec.sp, vy: Math.sin(dir) * spec.sp,
        dmg: this.basicDmg(), r: spec.r, friendly: true, pierce: false,
        life: 0.9, color: spec.color, kind: spec.kind, disarm: false, hitSet: null,
      });
      this.audio.sfx("move");
    }
  }

  private castQ(): void {
    if (this.mana < 30) {
      this.floaters.push({ x: this.px, y: this.py - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    this.mana -= 30;
    const dir = this.facing;
    if (this.hero.id === "nikita") {
      this.cdQ = this.hero.q.cooldown;
      this.projs.push({
        x: this.px + Math.cos(dir) * 30, y: this.py + Math.sin(dir) * 30,
        vx: Math.cos(dir) * 1050, vy: Math.sin(dir) * 1050,
        dmg: this.basicDmg() * 3, r: 9, friendly: true, pierce: true,
        life: 1.1, color: "#1a1a1a", kind: "puck", disarm: false, hitSet: new Set(),
      });
      this.shake = Math.min(14, this.shake + 6);
      this.audio.sfx("explosion");
    } else if (this.hero.id === "maxim") {
      this.cdQ = this.hero.q.cooldown;
      this.swingT = 0.25;
      for (const e of this.enemies) {
        const d = Math.hypot(e.x - this.px, e.y - this.py);
        if (d < 150 + e.radius) {
          const ang = Math.atan2(e.y - this.py, e.x - this.px);
          this.damageEnemy(e, this.basicDmg() * 2.6, Math.cos(ang) * 380, Math.sin(ang) * 380);
        }
      }
      this.spawnParticles(this.px, this.py, 36, "#7ec8ff", 380);
      this.spawnParticles(this.px, this.py, 16, "#ffffff", 260);
      this.shake = Math.min(14, this.shake + 8);
      this.audio.sfx("explosion");
    } else if (this.hero.id === "dasha") {
      this.cdQ = this.hero.q.cooldown;
      for (let i = -2; i <= 2; i++) {
        const a = dir + i * 0.22;
        this.projs.push({
          x: this.px + Math.cos(a) * 26, y: this.py + Math.sin(a) * 26,
          vx: Math.cos(a) * 880, vy: Math.sin(a) * 880,
          dmg: this.basicDmg() * 0.9, r: 4, friendly: true, pierce: false,
          life: 0.7, color: "#ffb02e", kind: "bullet", disarm: false, hitSet: null,
        });
      }
      this.audio.sfx("hit");
    } else {
      this.cdQ = this.hero.q.cooldown;
      this.projs.push({
        x: this.px + Math.cos(dir) * 26, y: this.py + Math.sin(dir) * 26,
        vx: Math.cos(dir) * 820, vy: Math.sin(dir) * 820,
        dmg: this.basicDmg() * 2, r: 14, friendly: true, pierce: true,
        life: 0.9, color: "#ff5252", kind: "expelliarmus", disarm: true, hitSet: new Set(),
      });
      this.audio.sfx("ui");
    }
  }

  private castE(): void {
    if (this.mana < 25) {
      this.floaters.push({ x: this.px, y: this.py - 34, text: "НЕТ МАНЫ", color: "#5aa8ff", life: 0.7 });
      return;
    }
    this.mana -= 25;
    if (this.hero.id === "nikita") {
      this.cdE = this.hero.e.cooldown;
      this.dashT = 0.24; this.dashDx = Math.cos(this.facing); this.dashDy = Math.sin(this.facing);
      this.dashDmgMul = 1.6; this.dashHits = new Set();
      this.audio.sfx("hit");
    } else if (this.hero.id === "maxim") {
      this.cdE = this.hero.e.cooldown;
      this.dashT = 0.28; this.dashDx = Math.cos(this.facing); this.dashDy = Math.sin(this.facing);
      this.dashDmgMul = 2.2; this.dashHits = new Set();
      this.audio.sfx("explosion");
    } else if (this.hero.id === "dasha") {
      this.cdE = this.hero.e.cooldown;
      const ix = this.input.moveX, iz = this.input.moveZ;
      const has = Math.abs(ix) + Math.abs(iz) > 0;
      const dx = has ? ix / (Math.hypot(ix, iz) || 1) : Math.cos(this.facing);
      const dy = has ? -iz / (Math.hypot(ix, iz) || 1) : Math.sin(this.facing);
      this.dashT = 0.25; this.dashDx = dx; this.dashDy = dy; this.dashDmgMul = 0;
      this.iframes = 0.6; this.speedBuffT = 2;
      this.audio.sfx("ui");
    } else {
      this.cdE = this.hero.e.cooldown;
      this.shieldT = 3;
      this.spawnParticles(this.px, this.py, 20, "#b58cff", 180);
      this.audio.sfx("win");
    }
  }

  private castSatoru(): void {
    this.cdR = this.hero.ult.cooldown;
    this.satoru = { x: this.px - 60, y: this.py - 60, life: SATORU_DURATION, swipeCd: 0 };
    this.announce("САТОРУ В ДЕЛЕ!", "кот пришёл на помощь");
    this.spawnParticles(this.px, this.py - 40, 24, "#e8e8e8", 240);
    this.audio.sfx("win");
  }

  // ---------- враги ----------

  private spawnEnemy(boss: boolean): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = boss ? 600 : 560 + Math.random() * 320;
    const x = Math.max(60, Math.min(WORLD_SIZE - 60, this.px + Math.cos(ang) * dist));
    const y = Math.max(60, Math.min(WORLD_SIZE - 60, this.py + Math.sin(ang) * dist));
    const kind = this.map.enemies[Math.floor(Math.random() * this.map.enemies.length)];
    if (boss) {
      this.bossAlive = true;
      this.enemies.push({
        x, y, kind, boss: true, name: this.map.bossName,
        hp: 420 * this.hpMul, maxHp: 420 * this.hpMul,
        speed: 72, dmg: 20 * this.dmgMulE, radius: 36, xp: 150,
        attackCd: 0, shootCd: 2, burstCd: 4, flash: 0, disarmT: 0, kx: 0, ky: 0,
        anim: 0, sprite: this.enemySpriteId(),
      });
    } else {
      this.enemies.push({
        x, y, kind, boss: false, name: kind.name,
        hp: kind.hp * this.hpMul, maxHp: kind.hp * this.hpMul,
        speed: kind.speed * (1 + (this.wave - 1) * 0.02), dmg: kind.dmg * this.dmgMulE,
        radius: kind.radius, xp: kind.xp,
        attackCd: 0, shootCd: 1 + Math.random() * 1.5, burstCd: 0, flash: 0, disarmT: 0, kx: 0, ky: 0,
        anim: Math.random() * 10, sprite: kind.spriteVar ?? this.enemySpriteId(),
      });
    }
  }

  private updateEnemies(dt: number): void {
    this.bossAlive = false;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.boss) this.bossAlive = true;
      e.flash -= dt; e.attackCd -= dt; e.shootCd -= dt; e.burstCd -= dt; e.disarmT -= dt;
      e.anim += dt * (0.6 + e.speed / 90);
      // нокбэк
      e.x += e.kx * dt; e.y += e.ky * dt;
      e.kx *= Math.pow(0.0001, dt); e.ky *= Math.pow(0.0001, dt);
      const dx = this.px - e.x, dy = this.py - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const slow = e.disarmT > 0 ? 0.5 : 1;
      if (e.disarmT <= 0) {
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
        // контактный урон
        if (d < e.radius + 24 && e.attackCd <= 0) {
          e.attackCd = 1.0;
          this.hurtPlayer(e.dmg);
        }
      }
      e.x = Math.max(30, Math.min(WORLD_SIZE - 30, e.x));
      e.y = Math.max(30, Math.min(WORLD_SIZE - 30, e.y));
    }
  }

  private hurtPlayer(dmg: number): void {
    if (this.iframes > 0) {
      this.floaters.push({ x: this.px, y: this.py - 30, text: "УВЕРНУЛСЯ", color: "#9fd8ff", life: 0.7 });
      return;
    }
    if (this.shieldT > 0) {
      this.floaters.push({ x: this.px, y: this.py - 30, text: "ПРОТЕГО!", color: "#b58cff", life: 0.7 });
      this.audio.sfx("ui");
      return;
    }
    this.hp -= dmg;
    this.hurtFlash = 0.25;
    this.decals.push({ x: this.px + (Math.random() - 0.5) * 20, y: this.py + 14, r: 7 + Math.random() * 6, color: "#6e1010", alpha: 0.45 });
    if (this.decals.length > 250) this.decals.shift();
    this.shake = Math.min(16, this.shake + 5);
    this.spawnParticles(this.px, this.py, 8, "#e84a4a", 200);
    this.audio.sfx("hit");
  }

  private damageEnemy(e: Enemy, dmg: number, kx = 0, ky = 0): void {
    e.hp -= dmg;
    e.flash = 0.12;
    e.kx += kx; e.ky += ky;
    if (this.floaters.length < 24) // текст в программном рендере дорогой — ограничиваем
      this.floaters.push({ x: e.x, y: e.y - e.radius - 8, text: String(Math.round(dmg)), color: "#ffe28a", life: 0.7 });
    this.spawnParticles(e.x, e.y, 4, e.kind.accent, 160);
    if (e.hp <= 0) this.killEnemy(e);
  }

  private killEnemy(e: Enemy): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    this.kills++;
    this.xp += e.xp;
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
      for (let k = 0; k < 3; k++) this.orbs.push({ x: e.x + (k - 1) * 40, y: e.y + 30, heal: 25, t: 0 });
      this.audio.sfx("win");
    } else {
      if (Math.random() < 0.26) this.orbs.push({ x: e.x, y: e.y, heal: 15, t: 0 });
      this.audio.sfx("explosion");
    }
  }

  private updateProjs(dt: number): void {
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      let dead = p.life <= 0 || p.x < 0 || p.x > WORLD_SIZE || p.y < 0 || p.y > WORLD_SIZE;
      if (!dead && p.friendly) {
        for (const e of this.enemies) {
          if (p.hitSet?.has(e)) continue;
          if (Math.hypot(e.x - p.x, e.y - p.y) < e.radius + p.r) {
            if (p.disarm) e.disarmT = 3;
            const ang = Math.atan2(p.vy, p.vx);
            this.damageEnemy(e, p.dmg, Math.cos(ang) * 140, Math.sin(ang) * 140);
            if (p.pierce) p.hitSet?.add(e);
            else { dead = true; break; }
          }
        }
      } else if (!dead && !p.friendly) {
        if (Math.hypot(this.px - p.x, this.py - p.y) < 22 + p.r) {
          this.hurtPlayer(p.dmg);
          dead = true;
        }
      }
      if (dead) {
        if (p.kind !== "bullet") this.spawnParticles(p.x, p.y, 3, p.color, 120);
        this.projs.splice(i, 1);
      }
    }
  }

  private updateSatoru(dt: number): void {
    const s = this.satoru;
    if (!s) return;
    s.life -= dt; s.swipeCd -= dt;
    if (s.life <= 0) {
      this.spawnParticles(s.x, s.y, 20, "#e8e8e8", 220);
      this.satoru = null;
      return;
    }
    let target: Enemy | null = null;
    let best = 950;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d < best) { best = d; target = e; }
    }
    if (target) {
      const d = best || 1;
      if (d > 64) { s.x += ((target.x - s.x) / d) * 430 * dt; s.y += ((target.y - s.y) / d) * 430 * dt; }
      else if (s.swipeCd <= 0) {
        s.swipeCd = 0.55;
        for (const e of this.enemies) {
          if (Math.hypot(e.x - s.x, e.y - s.y) < 78 + e.radius) {
            const ang = Math.atan2(e.y - s.y, e.x - s.x);
            this.damageEnemy(e, this.basicDmg() * 1.6, Math.cos(ang) * 260, Math.sin(ang) * 260);
          }
        }
        this.floaters.push({ x: s.x, y: s.y - 30, text: "МРРР!", color: "#ffffff", life: 0.6 });
        this.spawnParticles(s.x, s.y, 10, "#f0f0f0", 240);
        this.audio.sfx("hit");
      }
    } else {
      const d = Math.hypot(this.px - s.x, this.py - s.y) || 1;
      if (d > 90) { s.x += ((this.px - s.x) / d) * 380 * dt; s.y += ((this.py - s.y) / d) * 380 * dt; }
    }
  }

  private updateFx(dt: number): void {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].life -= dt;
      if (this.trail[i].life <= 0) this.trail.splice(i, 1);
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

  // ---------- клики ----------

  private onClick(cx: number, cy: number): void {
    if (this.state === "select") {
      for (let i = 0; i < this.cardRects.length; i++) {
        const r = this.cardRects[i];
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          if (this.selIndex === i) { this.audio.sfx("ui"); this.startRun(HEROES[i]); }
          else { this.selIndex = i; this.audio.sfx("ui"); }
          return;
        }
      }
    } else if (this.state === "over") {
      this.state = "select";
      this.audio.sfx("ui");
    }
  }

  // ---------- камера ----------

  private camX(): number { return Math.max(0, Math.min(WORLD_SIZE - this.w, this.px - this.w / 2)); }
  private camY(): number { return Math.max(0, Math.min(WORLD_SIZE - this.h, this.py - this.h / 2)); }

  /** Позиция игрока для self-check (W = вперёд = z уменьшается). */
  probe(): { x: number; y: number; z: number } {
    return { x: this.px, y: 0, z: this.py };
  }

  /** Текущее состояние для автотестов. */
  get stateName(): string { return this.state; }

  /** Отладочные хуки для автопроверки (не используются в игре). */
  debugBoss(): void { this.nextBossAt = 0; }
  debugHeal(): void { this.hp = this.maxHp = 9999; }

  // ---------- рендер ----------

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.state === "select") { this.renderSelect(ctx); return; }
    const camX = this.camX() + (Math.random() - 0.5) * this.shake;
    const camY = this.camY() + (Math.random() - 0.5) * this.shake;
    let tSec = performance.now();

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
    if (this.trail.length > 1) {
      if (this.hero.id === "maxim") {
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? "rgba(126,200,255,0.35)" : "rgba(240,250,255,0.8)";
          ctx.lineWidth = pass === 0 ? 7 : 2.5;
          ctx.beginPath();
          let first = true;
          for (const tp of this.trail) {
            const jx = tp.x - camX + (Math.random() - 0.5) * 10;
            const jy = tp.y - camY - 20 + (Math.random() - 0.5) * 10;
            if (first) { ctx.moveTo(jx, jy); first = false; } else ctx.lineTo(jx, jy);
          }
          ctx.stroke();
        }
      } else {
        for (const tp of this.trail) {
          ctx.globalAlpha = tp.life / 0.35 * 0.3;
          ctx.fillStyle = this.hero.themeColor;
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
    if (this.satoru) this.drawSatoru(ctx, camX, camY);
    this.drawPlayer(ctx, camX, camY);
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
      } else {
        // магический болт / вражеский сгусток: ядро + свечение + хвост
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

    if (!this.skipSec.has("light")) this.renderLighting(ctx, camX, camY);
    this.perfSec[3] += performance.now() - tSec; tSec = performance.now();
    if (!this.skipSec.has("hud")) this.renderHud(ctx);
    this.perfSec[4] += performance.now() - tSec;
  }

  /** Диабловское освещение: тьма вокруг, круги света у героя, кота, снарядов и сфер. */
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
    light(this.px - camX, this.py - camY, this.map.id === "arena" ? 240 : 300);
    if (this.satoru) light(this.satoru.x - camX, this.satoru.y - camY, 170, 0.9);
    for (const e of this.enemies) if (e.boss) light(e.x - camX, e.y - camY, 140, 0.8);
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

    this.drawPuppet(ctx, "hero-" + this.hero.id, x, y + 26 + idleBob, 76, { flip, walk, filter, scalePulse: pulse, attackT });

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

  private drawSatoru(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const s = this.satoru!;
    const x = s.x - camX, y = s.y - camY;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(x, y + 16, 26, 9, 0, 0, Math.PI * 2); ctx.fill();
    // бегущий кот: лапы перебирают в противофазе
    const flip = Math.cos(Math.atan2(this.py - s.y, this.px - s.x)) < 0;
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

    // до следующей волны
    const toWave = WAVE_PERIOD - (this.time % WAVE_PERIOD);
    ctx.fillStyle = "rgba(232,217,176,0.6)";
    ctx.font = "13px Georgia";
    ctx.fillText(`усиление врагов через ${Math.ceil(toWave)} c`, w / 2, 74);

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
    const slots = [
      { label: "ЛКМ", name: this.hero.basicName, cd: 0, max: 1 },
      { label: "Q", name: this.hero.q.name, cd: Math.max(0, this.cdQ), max: this.hero.q.cooldown },
      { label: "E", name: this.hero.e.name, cd: Math.max(0, this.cdE), max: this.hero.e.cooldown },
      { label: "R", name: this.hero.ult.name, cd: Math.max(0, this.cdR), max: this.hero.ult.cooldown },
    ];
    const sw = 62, gap = 12;
    const sx = w / 2 - (slots.length * (sw + gap) - gap) / 2;
    for (let i = 0; i < slots.length; i++) {
      const x = sx + i * (sw + gap), y = py + 30;
      const sg = ctx.createLinearGradient(0, y, 0, y + sw);
      sg.addColorStop(0, "#241d18");
      sg.addColorStop(1, "#100c0a");
      ctx.fillStyle = sg;
      ctx.fillRect(x, y, sw, sw);
      ctx.strokeStyle = "#a08040"; ctx.lineWidth = 2;
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
    }

    // XP-полоса внизу панели
    ctx.fillStyle = "#0a0806";
    ctx.fillRect(px + 14, py + ph - 12, pw - 28, 7);
    ctx.fillStyle = "#b8a02e";
    ctx.fillRect(px + 14, py + ph - 12, (pw - 28) * Math.min(1, this.xp / this.xpNext), 7);

    // подсказки
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(240,230,208,0.45)";
    ctx.font = "12px Georgia";
    ctx.fillText("WASD — движение • Q/E — навыки (мана) • R — САТОРУ • Esc — пауза • M — звук", w - 20, h - 126);

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
      ctx.fillText(`ЛКМ — ${hero.basicName}`, x + 16, y0 + 272);
      ctx.fillText(`Q — ${hero.q.name}`, x + 16, y0 + 294);
      ctx.fillText(`E — ${hero.e.name}`, x + 16, y0 + 316);
      ctx.fillStyle = "#c9a15a";
      ctx.fillText(`R — ${hero.ult.name}`, x + 16, y0 + 338);
      ctx.textAlign = "center";

      const best = this.best[hero.id];
      ctx.fillStyle = "#8f8578";
      ctx.font = "12px Arial";
      ctx.fillText(
        best ? `рекорд: ${Math.floor(best.time / 60)}:${String(best.time % 60).padStart(2, "0")}, ${best.kills} уб., ур. ${best.level}` : "ещё не играл",
        x + cw / 2, y0 + 366,
      );
      ctx.fillStyle = "#6f6578";
      ctx.font = "bold 13px Arial";
      ctx.fillText(`[ ${i + 1} ]`, x + cw / 2, y0 + 388);
    }

    ctx.fillStyle = "#8f8272";
    ctx.font = "15px Georgia";
    ctx.fillText("Каждые 30 секунд врагов становится больше и они сильнее. Каждые 90 секунд — босс.", w / 2, y0 + ch + 44);
    ctx.fillText("Убийства дают опыт: уровень повышает урон и здоровье.", w / 2, y0 + ch + 68);
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
