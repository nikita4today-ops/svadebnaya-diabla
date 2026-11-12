/**
 * maps.ts — процедурные фоны локаций (рисуются один раз в offscreen-canvas).
 * Узнаваемость локации — за счёт силуэтов, подписей и фирменных деталей.
 */

import { MapId, WORLD_SIZE } from "./heroes";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

function noiseSpeckle(ctx: Ctx, rand: () => number, n: number, colors: string[], size: number): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.globalAlpha = 0.05 + rand() * 0.1;
    const s = size * (0.5 + rand());
    ctx.fillRect(rand() * WORLD_SIZE, rand() * WORLD_SIZE, s, s);
  }
  ctx.globalAlpha = 1;
}

function tree(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.fillStyle = "#4a3524";
  ctx.fillRect(x - 3, y, 6, r * 0.6);
  ctx.fillStyle = "#2e5d33";
  ctx.beginPath(); ctx.arc(x, y - r * 0.3, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#3a7340";
  ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.5, r * 0.6, 0, Math.PI * 2); ctx.fill();
}

/** Панельная многоэтажка с окнами. */
function panelka(ctx: Ctx, x: number, y: number, w: number, h: number, tint: string): void {
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x + 8, y + 10, w, h);
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  const cols = Math.floor(w / 34);
  const rows = Math.floor(h / 40);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 3 === 0 ? "#d8e6ee" : "#8fa5ad";
      ctx.fillRect(x + 10 + c * 34, y + 10 + r * 40, 20, 24);
    }
  }
}

function paintOdintsovo(ctx: Ctx): void {
  const rand = mulberry32(101);
  // асфальт
  ctx.fillStyle = "#3d3f45";
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  noiseSpeckle(ctx, rand, 2600, ["#33353b", "#474a52", "#2c2e33"], 3);
  // газоны-кварталы
  const lawn = "#3c5c35";
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      ctx.fillStyle = lawn;
      ctx.fillRect(180 + gx * 620, 180 + gy * 620, 420, 420);
      ctx.strokeStyle = "#565a63";
      ctx.lineWidth = 10;
      ctx.strokeRect(180 + gx * 620, 180 + gy * 620, 420, 420);
    }
  }
  // дороги между кварталами с разметкой
  ctx.strokeStyle = "#d8d2c0";
  ctx.lineWidth = 4;
  ctx.setLineDash([28, 26]);
  for (let i = 0; i < 5; i++) {
    const p = 80 + i * 620;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, WORLD_SIZE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(WORLD_SIZE, p); ctx.stroke();
  }
  ctx.setLineDash([]);
  // дома-панельки в кварталах
  const tints = ["#b8a98f", "#a89a90", "#c0b49a", "#9aa39b"];
  for (let i = 0; i < 14; i++) {
    const bx = 220 + Math.floor(rand() * 4) * 620 + rand() * 160;
    const by = 220 + Math.floor(rand() * 4) * 620 + rand() * 160;
    panelka(ctx, bx, by, 130 + rand() * 60, 90 + rand() * 40, tints[i % tints.length]);
  }
  // деревья
  for (let i = 0; i < 40; i++) tree(ctx, 100 + rand() * (WORLD_SIZE - 200), 100 + rand() * (WORLD_SIZE - 200), 14 + rand() * 12);
  // ТЦ
  ctx.fillStyle = "#7a6a8f";
  ctx.fillRect(1120, 1120, 360, 160);
  ctx.strokeStyle = "#4a3f5c"; ctx.lineWidth = 4; ctx.strokeRect(1120, 1120, 360, 160);
  ctx.fillStyle = "#e8e2f2";
  ctx.font = "bold 44px Arial";
  ctx.textAlign = "center";
  ctx.fillText("ТЦ «ОДИНЦОВО»", 1300, 1215);
  // стела у въезда
  ctx.fillStyle = "#8f2b2b";
  ctx.fillRect(300, 2320, 520, 90);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 56px Arial";
  ctx.fillText("О Д И Н Ц О В О", 560, 2382);
}

function paintSchool(ctx: Ctx): void {
  const rand = mulberry32(202);
  // паркет
  ctx.fillStyle = "#6d5133";
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 2;
  for (let y = 0; y < WORLD_SIZE; y += 26) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_SIZE, y); ctx.stroke();
  }
  noiseSpeckle(ctx, rand, 1600, ["#5d452b", "#7d5f3d"], 4);
  // центральный коридор — светлая плитка
  ctx.fillStyle = "#8d8574";
  ctx.fillRect(0, WORLD_SIZE / 2 - 130, WORLD_SIZE, 260);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  for (let x = 0; x < WORLD_SIZE; x += 65) {
    ctx.strokeRect(x, WORLD_SIZE / 2 - 130, 65, 130);
    ctx.strokeRect(x, WORLD_SIZE / 2, 65, 130);
  }
  // классы: ряды парт
  const desk = (x: number, y: number) => {
    ctx.fillStyle = "#8a6a42";
    ctx.fillRect(x, y, 56, 30);
    ctx.strokeStyle = "#4a3820"; ctx.lineWidth = 2; ctx.strokeRect(x, y, 56, 30);
    ctx.fillStyle = "#3c3c44";
    ctx.fillRect(x + 14, y + 38, 28, 18);
  };
  for (let room = 0; room < 6; room++) {
    const ox = 200 + (room % 3) * 760;
    const oy = room < 3 ? 200 : 1960;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) desk(ox + c * 150, oy + r * 130);
  }
  // доска
  ctx.fillStyle = "#1f4d33";
  ctx.fillRect(1080, 60, 440, 120);
  ctx.strokeStyle = "#8a6a42"; ctx.lineWidth = 10; ctx.strokeRect(1080, 60, 440, 120);
  ctx.fillStyle = "#e8f0e4";
  ctx.font = "bold 40px Arial";
  ctx.textAlign = "center";
  ctx.fillText("ЗАКРЫТАЯ ШКОЛА", 1300, 112);
  ctx.font = "26px Arial";
  ctx.fillText("пансион «Логос»", 1300, 152);
  // шкафчики вдоль коридора
  for (let x = 60; x < WORLD_SIZE - 60; x += 72) {
    ctx.fillStyle = "#4d5a68";
    ctx.fillRect(x, WORLD_SIZE / 2 - 196, 56, 44);
    ctx.strokeStyle = "#2c3540"; ctx.lineWidth = 2; ctx.strokeRect(x, WORLD_SIZE / 2 - 196, 56, 44);
    ctx.fillRect(x, WORLD_SIZE / 2 + 152, 56, 44);
    ctx.strokeRect(x, WORLD_SIZE / 2 + 152, 56, 44);
  }
  // окна по краю
  for (let x = 100; x < WORLD_SIZE - 100; x += 180) {
    ctx.fillStyle = "rgba(180,210,230,0.5)";
    ctx.fillRect(x, 8, 110, 26);
    ctx.fillRect(x, WORLD_SIZE - 34, 110, 26);
  }
}

function paintHogwarts(ctx: Ctx): void {
  const rand = mulberry32(303);
  // каменные плиты
  ctx.fillStyle = "#3a3542";
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 3;
  for (let y = 0; y < WORLD_SIZE; y += 100) {
    for (let x = 0; x < WORLD_SIZE; x += 100) {
      ctx.strokeRect(x + ((y / 100) % 2) * 50, y, 100, 100);
    }
  }
  noiseSpeckle(ctx, rand, 1400, ["#443e4e", "#322c3a"], 5);
  // ковровая дорожка
  ctx.fillStyle = "#5c1f24";
  ctx.fillRect(WORLD_SIZE / 2 - 110, 0, 220, WORLD_SIZE);
  ctx.strokeStyle = "#c9a15a"; ctx.lineWidth = 6;
  ctx.strokeRect(WORLD_SIZE / 2 - 110, 0, 220, WORLD_SIZE);
  // 4 длинных стола факультетов
  const houses: Array<[string, string]> = [["#7f1d1d", "Г"], ["#1f4d2a", "С"], ["#1d3a6b", "К"], ["#6b5a1d", "П"]];
  houses.forEach(([col, letter], i) => {
    const x = 420 + i * 500;
    ctx.fillStyle = "#5a4128";
    ctx.fillRect(x, 300, 120, 2000);
    ctx.strokeStyle = "#3a2a18"; ctx.lineWidth = 4; ctx.strokeRect(x, 300, 120, 2000);
    ctx.fillStyle = col;
    ctx.fillRect(x + 40, 300, 40, 2000);
    ctx.fillStyle = "#e8dfc8";
    ctx.font = "bold 30px Arial";
    ctx.textAlign = "center";
    for (let y = 420; y < 2200; y += 300) ctx.fillText(letter, x + 60, y);
  });
  // свечи — светящиеся точки
  for (let i = 0; i < 120; i++) {
    const x = 80 + rand() * (WORLD_SIZE - 160);
    const y = 80 + rand() * (WORLD_SIZE - 160);
    const g = ctx.createRadialGradient(x, y, 0, x, y, 26);
    g.addColorStop(0, "rgba(255,220,140,0.85)");
    g.addColorStop(1, "rgba(255,220,140,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff3d0";
    ctx.fillRect(x - 2, y - 6, 4, 12);
  }
  // готические окна
  for (let y = 160; y < WORLD_SIZE - 160; y += 340) {
    for (const x of [26, WORLD_SIZE - 66]) {
      ctx.fillStyle = "rgba(120,150,220,0.35)";
      ctx.beginPath();
      ctx.moveTo(x, y + 80); ctx.lineTo(x, y + 20);
      ctx.quadraticCurveTo(x + 20, y - 20, x + 40, y + 20);
      ctx.lineTo(x + 40, y + 80); ctx.closePath(); ctx.fill();
    }
  }
  // надпись на кафедре
  ctx.fillStyle = "#c9a15a";
  ctx.font = "bold 52px Georgia";
  ctx.textAlign = "center";
  ctx.fillText("Х О Г В А Р Т С", WORLD_SIZE / 2, 130);
}

function paintArena(ctx: Ctx): void {
  const rand = mulberry32(404);
  // трибуны
  ctx.fillStyle = "#18222e";
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = ["#3d4a5c", "#5c3d3d", "#3d5c4a", "#565c3d"][Math.floor(rand() * 4)];
    ctx.globalAlpha = 0.25 + rand() * 0.4;
    ctx.fillRect(rand() * WORLD_SIZE, rand() * WORLD_SIZE, 5, 5);
  }
  ctx.globalAlpha = 1;
  // борта
  const rx = 220, ry = 380, rw = WORLD_SIZE - 440, rh = WORLD_SIZE - 760;
  ctx.fillStyle = "#e8e8e4";
  ctx.fillRect(rx - 40, ry - 40, rw + 80, rh + 80);
  ctx.fillStyle = "#d33a2c";
  ctx.fillRect(rx - 40, ry + rh + 20, rw + 80, 20); // рекламная полоса
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.fillText("А Р Е Н А   О М С К", WORLD_SIZE / 2, ry + rh + 40 - 8);
  // лёд
  const ice = ctx.createLinearGradient(rx, ry, rx, ry + rh);
  ice.addColorStop(0, "#dfeef7");
  ice.addColorStop(0.5, "#f2f8fc");
  ice.addColorStop(1, "#d8e9f4");
  ctx.fillStyle = ice;
  ctx.fillRect(rx, ry, rw, rh);
  // царапины на льду
  ctx.strokeStyle = "rgba(140,170,190,0.35)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 160; i++) {
    const x = rx + rand() * rw, y = ry + rand() * rh;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20 - rand() * 40, y + 20 - rand() * 40); ctx.stroke();
  }
  const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
  // красная линия и синие линии
  ctx.fillStyle = "#d33a2c";
  ctx.fillRect(rx, cy - 8, rw, 16);
  ctx.fillStyle = "#2a5fd4";
  ctx.fillRect(cx - rw * 0.28 - 8, ry, 16, rh);
  ctx.fillRect(cx + rw * 0.28 - 8, ry, 16, rh);
  // центральный круг и вбрасывания
  const circle = (x: number, y: number, r: number, col: string) => {
    ctx.strokeStyle = col; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
  };
  circle(cx, cy, 150, "#d33a2c");
  circle(rx + rw * 0.18, ry + rh * 0.22, 110, "#d33a2c");
  circle(rx + rw * 0.18, ry + rh * 0.78, 110, "#d33a2c");
  circle(rx + rw * 0.82, ry + rh * 0.22, 110, "#d33a2c");
  circle(rx + rw * 0.82, ry + rh * 0.78, 110, "#d33a2c");
  // ворота
  for (const gx of [rx + 90, rx + rw - 90]) {
    ctx.strokeStyle = "#d33a2c"; ctx.lineWidth = 8;
    ctx.strokeRect(gx - 24, cy - 60, 48, 120);
  }
  // логотип в центре
  ctx.fillStyle = "#16355c";
  ctx.font = "bold 64px Arial";
  ctx.fillText("АРЕНА ОМСК", cx, cy - 190);
  ctx.font = "bold 30px Arial";
  ctx.fillText("ХК «АВАНГАРД»", cx, cy + 220);
}

export function paintMap(mapId: MapId): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = WORLD_SIZE;
  c.height = WORLD_SIZE;
  const ctx = c.getContext("2d")!;
  if (mapId === "odintsovo") paintOdintsovo(ctx);
  else if (mapId === "school") paintSchool(ctx);
  else if (mapId === "hogwarts") paintHogwarts(ctx);
  else paintArena(ctx);
  // рамка мира
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 16;
  ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  return c;
}
