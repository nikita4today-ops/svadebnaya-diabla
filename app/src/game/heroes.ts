/**
 * heroes.ts — герои, враги, боссы и карты «Свадебной Диаблы».
 * Все числа — базовые значения до волнового скейлинга и уровней игрока.
 */

export type HeroId = "nikita" | "maxim" | "dasha" | "vika";
export type MapId = "arena" | "odintsovo" | "school" | "hogwarts";

export interface AbilityDef {
  name: string;
  keyLabel: string;
  cooldown: number;
  desc: string;
}

export interface HeroDef {
  id: HeroId;
  name: string;
  title: string;
  face: string;
  mapId: MapId;
  mapName: string;
  cloth: string;
  accent: string;
  weaponName: string;
  hp: number;
  speed: number;
  basicName: string;
  basicDesc: string;
  themeColor: string;
  q: AbilityDef;
  e: AbilityDef;
  /** Массовый ультимейт (клавиша R). */
  r: AbilityDef;
  /** Зов САТОРУ — пятый скилл (клавиша T). */
  ult: AbilityDef;
}

export interface EnemyKindDef {
  id: string;
  name: string;
  color: string;
  accent: string;
  hp: number;
  dmg: number;
  speed: number;
  radius: number;
  xp: number;
  ranged: boolean;
  /** Предзапечённый спрайт варианта (цвет команды/класса). */
  spriteVar?: string;
  /** Масштаб спрайта относительно базового. */
  scaleMul?: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  subtitle: string;
  enemies: EnemyKindDef[];
  bossName: string;
  bossColor: string;
  skyTop: string;
}

export const WORLD_SIZE = 2600;

const SATORU: AbilityDef = {
  name: "Зов САТОРУ",
  keyLabel: "T",
  cooldown: 40,
  desc: "Кот САТОРУ прибегает и 12 секунд рвёт врагов когтями",
};

export const HEROES: HeroDef[] = [
  {
    id: "nikita",
    name: "Никита",
    title: "Хоккеист возмездия",
    face: "faces/nikita.png",
    mapId: "arena",
    mapName: "Хоккейная арена, Омск",
    cloth: "#f2f2f0",
    accent: "#d33a2c",
    weaponName: "Клюшка",
    hp: 150,
    speed: 265,
    basicName: "Замах клюшкой",
    basicDesc: "Мощный удар по дуге перед собой",
    themeColor: "#7ec8ff",
    q: { name: "Силовой бросок", keyLabel: "Q", cooldown: 5, desc: "Щелчок: шайба пробивает врагов насквозь" },
    e: { name: "Силовой приём", keyLabel: "E", cooldown: 7, desc: "Рывок вперёд, враги на пути отлетают" },
    r: { name: "Шайбоград", keyLabel: "R", cooldown: 22, desc: "14 взрывных шайб во все стороны" },
    ult: SATORU,
  },
  {
    id: "maxim",
    name: "Максим",
    title: "Шиноби Одинцова",
    face: "faces/maxim.png",
    mapId: "odintsovo",
    mapName: "Улицы Одинцова",
    cloth: "#f5f5f5",
    accent: "#ff7a1a",
    weaponName: "Техники Наруто",
    hp: 115,
    speed: 290,
    basicName: "Бросок сюрикена",
    basicDesc: "Быстрый сюрикен в точку прицела",
    themeColor: "#ffa03a",
    q: { name: "Расенган", keyLabel: "Q", cooldown: 6, desc: "Сфера чакры: взрыв вокруг и отброс врагов" },
    e: { name: "Чидори", keyLabel: "E", cooldown: 7, desc: "Молниеносный рывок сквозь врагов" },
    r: { name: "Расен-сюрикен", keyLabel: "R", cooldown: 24, desc: "Гигантская сфера летит в цель и взрывается" },
    ult: SATORU,
  },
  {
    id: "dasha",
    name: "Даша",
    title: "Стрелок Закрытой школы",
    face: "faces/dasha.png",
    mapId: "school",
    mapName: "«Закрытая школа», пансион «Логос»",
    cloth: "#23232a",
    accent: "#c9a15a",
    weaponName: "Пистолет",
    hp: 105,
    speed: 285,
    basicName: "Выстрел",
    basicDesc: "Скорострельный пистолет",
    themeColor: "#ffd24a",
    q: { name: "Веерный огонь", keyLabel: "Q", cooldown: 5, desc: "5 пуль веером по площади" },
    e: { name: "Боевой перекат", keyLabel: "E", cooldown: 6, desc: "Перекат с неуязвимостью и ускорением" },
    r: { name: "Тотальный отстрел", keyLabel: "R", cooldown: 22, desc: "Три залпа пуль по кругу" },
    ult: SATORU,
  },
  {
    id: "vika",
    name: "Вика",
    title: "Волшебница Хогвартса",
    face: "faces/vika.png",
    mapId: "hogwarts",
    mapName: "Большой зал Хогвартса",
    cloth: "#f7f3ea",
    accent: "#8a5fd4",
    weaponName: "Волшебная палочка",
    hp: 105,
    speed: 270,
    basicName: "Магический болт",
    basicDesc: "Сгусток магии из палочки",
    themeColor: "#b58cff",
    q: { name: "Экспеллиармус", keyLabel: "Q", cooldown: 6, desc: "Луч: обезоруживает и замедляет врагов" },
    e: { name: "Протего", keyLabel: "E", cooldown: 10, desc: "Щит, блокирующий весь урон 3 секунды" },
    r: { name: "Волна Авады", keyLabel: "R", cooldown: 26, desc: "Зелёная волна смерти расходится от героини" },
    ult: SATORU,
  },
];

export const MAPS: Record<MapId, MapDef> = {
  arena: {
    id: "arena",
    name: "Хоккейная арена",
    subtitle: "Омск",
    bossName: "Голкипер-Голем",
    bossColor: "#c8352a",
    skyTop: "#0d1622",
    enemies: [
      { id: "loko", name: "Хоккеист «Локомотива»", color: "#b3202c", accent: "#ffffff", hp: 36, dmg: 9, speed: 105, radius: 17, xp: 12, ranged: false },
      { id: "metallurg", name: "Хоккеист «Металлурга»", color: "#24448f", accent: "#d33a2c", hp: 46, dmg: 11, speed: 88, radius: 18, xp: 15, ranged: true, spriteVar: "enemy-hockey-metallurg" },
      { id: "akbars", name: "Хоккеист «Ак Барса»", color: "#1e7a4a", accent: "#ffffff", hp: 28, dmg: 7, speed: 135, radius: 16, xp: 11, ranged: false, spriteVar: "enemy-hockey-akbars" },
    ],
  },
  odintsovo: {
    id: "odintsovo",
    name: "Одинцово",
    subtitle: "ул. Молодёжная",
    bossName: "Пейн",
    bossColor: "#3a3a3f",
    skyTop: "#10141c",
    enemies: [
      { id: "akatsuki", name: "Акацуки", color: "#151518", accent: "#c0392b", hp: 38, dmg: 10, speed: 100, radius: 17, xp: 12, ranged: false },
      { id: "akatsuki-thrower", name: "Акацуки-метатель", color: "#1c1c22", accent: "#e74c3c", hp: 30, dmg: 9, speed: 85, radius: 16, xp: 14, ranged: true, spriteVar: "enemy-akatsuki-thrower" },
      { id: "akatsuki-runner", name: "Акацуки-штурмовик", color: "#101014", accent: "#a93226", hp: 24, dmg: 6, speed: 150, radius: 15, xp: 10, ranged: false, spriteVar: "enemy-akatsuki-runner", scaleMul: 0.9 },
    ],
  },
  school: {
    id: "school",
    name: "Закрытая школа",
    subtitle: "пансион «Логос»",
    bossName: "Гном-Вожак",
    bossColor: "#2f6b2f",
    skyTop: "#141210",
    enemies: [
      { id: "gnome", name: "Гномик", color: "#3f7a3a", accent: "#e8d9a0", hp: 22, dmg: 6, speed: 150, radius: 13, xp: 9, ranged: false },
      { id: "gnome-thrower", name: "Гномик-швырятель", color: "#5a8a3a", accent: "#c0392b", hp: 26, dmg: 8, speed: 95, radius: 13, xp: 12, ranged: true, spriteVar: "enemy-gnome-thrower" },
      { id: "gnome-brute", name: "Гномик-здоровяк", color: "#2c5c28", accent: "#8a6d3b", hp: 52, dmg: 12, speed: 75, radius: 17, xp: 16, ranged: false, scaleMul: 1.3, spriteVar: "enemy-gnome-brute" },
    ],
  },
  hogwarts: {
    id: "hogwarts",
    name: "Хогвартс",
    subtitle: "Большой зал",
    bossName: "Волан-де-Морт",
    bossColor: "#1d2b1d",
    skyTop: "#0e0a18",
    enemies: [
      { id: "deatheater", name: "Пожиратель смерти", color: "#191b22", accent: "#9aa5b1", hp: 40, dmg: 10, speed: 100, radius: 17, xp: 12, ranged: false },
      { id: "deatheater-mage", name: "Пожиратель-колдун", color: "#14161c", accent: "#3ddc84", hp: 30, dmg: 11, speed: 82, radius: 16, xp: 15, ranged: true, spriteVar: "enemy-deatheater-mage" },
      { id: "deatheater-assassin", name: "Пожиратель-убийца", color: "#101218", accent: "#7f8c9b", hp: 26, dmg: 7, speed: 145, radius: 15, xp: 10, ranged: false, spriteVar: "enemy-deatheater-assassin", scaleMul: 0.92 },
    ],
  },
};

export const XP_BASE = 42;
export const WAVE_PERIOD = 30; // каждые 30 секунд врагов больше и они сильнее
export const BOSS_PERIOD = 90;
export const SATORU_DURATION = 12;

/** Базовый спрайт вида врага (если нет предзапечённого варианта). */
export function kindSprite(k: EnemyKindDef): string {
  return k.spriteVar ?? ({
    loko: "enemy-hockey",
    akatsuki: "enemy-akatsuki",
    gnome: "enemy-gnome",
    deatheater: "enemy-deatheater",
  } as Record<string, string>)[k.id] ?? "enemy-hockey";
}

/** Кооп-режим: все враги со всех четырёх карт в одном пуле. */
export const ALL_ENEMY_KINDS: EnemyKindDef[] = [
  ...MAPS.arena.enemies,
  ...MAPS.odintsovo.enemies,
  ...MAPS.school.enemies,
  ...MAPS.hogwarts.enemies,
];

/** Боссы кооп-режима: выходят по очереди, по одному с каждой карты. */
export const COOP_BOSSES = [
  { name: MAPS.arena.bossName, color: MAPS.arena.bossColor, sprite: "enemy-hockey" },
  { name: MAPS.odintsovo.bossName, color: MAPS.odintsovo.bossColor, sprite: "enemy-akatsuki" },
  { name: MAPS.school.bossName, color: MAPS.school.bossColor, sprite: "enemy-gnome" },
  { name: MAPS.hogwarts.bossName, color: MAPS.hogwarts.bossColor, sprite: "enemy-deatheater" },
];

/** Карта кооп-режима: арена как нейтральная площадка, враги — со всех карт. */
export const COOP_MAP: MapDef = {
  ...MAPS.arena,
  name: "Совместный рейд",
  subtitle: "все фронты в одном бою",
  enemies: ALL_ENEMY_KINDS,
};
