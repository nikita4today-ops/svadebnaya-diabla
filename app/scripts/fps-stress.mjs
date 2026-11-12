/**
 * fps-stress.mjs — замер FPS под нагрузкой: запускаем игру, ждём поздние волны
 * (много врагов), считаем кадры через rAF. Только для процесса разработки.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) { console.error("no dist"); process.exit(1); }
const SHOTS = join(ROOT, "verification-shots");
mkdirSync(SHOTS, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const clean = req.url.split("?")[0];
    const raw = clean === "/" ? "/index.html" : clean;
    let path; try { path = decodeURIComponent(raw); } catch { path = raw; }
    const file = resolve(DIST, "." + path);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch(process.env.HEADED ? { headless: false } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/${process.env.SKIP ? `?skip=${process.env.SKIP}` : ""}`, { waitUntil: "networkidle" });
if (process.env.NOTEXT) {
  await page.evaluate(() => {
    CanvasRenderingContext2D.prototype.fillText = () => {};
    CanvasRenderingContext2D.prototype.strokeText = () => {};
  });
}
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });
await page.waitForTimeout(500);

// стартуем за Максима (Digit2 + Space)
await page.keyboard.press("Digit2");
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(500);

// держим атаку: кнопка мыши зажата в центре
await page.mouse.move(640, 300);
await page.mouse.down();

async function measureFps(seconds) {
  return page.evaluate((secs) => new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick);
      else res(frames / secs);
    };
    requestAnimationFrame(tick);
  }), seconds);
}

async function state() { return page.evaluate(() => window.__gameState ? window.__gameState() : "?"); }

// волна 1 (~5-8 врагов)
await page.waitForTimeout(3000);
const fps1 = await measureFps(3);
console.log("wave1 fps:", fps1.toFixed(1), "state:", await state(), "perf:", await page.evaluate(() => window.__perf && window.__perf()));

// ждём до волны 3-4 (~95 сек), периодически лечимся и двигаемся
const SOAK = process.env.SHORT ? 34 : 92;
for (let t = 0; t < SOAK; t += 8) {
  await page.evaluate(() => window.__debug && window.__debug.heal && window.__debug.heal());
  await page.keyboard.down("KeyD"); await page.waitForTimeout(700); await page.keyboard.up("KeyD");
  await page.keyboard.down("KeyW"); await page.waitForTimeout(700); await page.keyboard.up("KeyW");
  await page.waitForTimeout(6600);
  if ((await state()) !== "play") break;
}
await page.evaluate(() => window.__debug && window.__debug.heal && window.__debug.heal());
await page.screenshot({ path: join(SHOTS, "stress-wave4.png") });
const fps4 = await measureFps(3);
const enemies = await page.evaluate(() => window.__enemyCount !== undefined ? window.__enemyCount : "n/a");
console.log("wave4 fps:", fps4.toFixed(1), "state:", await state(), "enemies:", enemies, "perf:", await page.evaluate(() => window.__perf && window.__perf()));
await page.screenshot({ path: join(SHOTS, "stress-late.png") });

if (consoleErrors.length) console.error("CONSOLE ERRORS:", consoleErrors.slice(0, 5));
else console.log("CONSOLE ERRORS: none");

await browser.close();
server.close();
console.log(`RESULT: wave1=${fps1.toFixed(1)} late=${fps4.toFixed(1)}`);
