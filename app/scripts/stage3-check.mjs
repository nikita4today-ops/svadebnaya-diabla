/**
 * stage3-check.mjs — проверка этапа 3: скиллы босса (телеграфы),
 * катаклизм-метеориты, рендер без ошибок.
 * Только для процесса разработки.
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

const browser = await chromium.launch({});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const dbg2 = () => page.evaluate(() => window.__dbg2());

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });

// соло за Никиту
await page.keyboard.press("Digit1");
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(1200);

// босс: телеграф атаки должен появиться в течение ~8 секунд
await page.evaluate(() => window.__debug.heal());
await page.evaluate(() => window.__debug.boss());
let bossTel = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__debug.heal());
  const st = await dbg2();
  if (st.tg > 0) { bossTel = true; break; }
}
if (!bossTel) fail("босс не создал телеграф атаки за 8 секунд");
console.log("boss telegraph ok");
await page.screenshot({ path: join(SHOTS, "stage3-boss-telegraph.png") });

// метеоритный катаклизм: meteorT стартует с 16 с — ждём до 30 секунд
let met = false;
for (let i = 0; i < 110; i++) {
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__debug.heal());
  const st = await dbg2();
  if (st.met) { met = true; break; }
}
if (!met) fail("катаклизм (метеориты) не сработал за 30 секунд");
console.log("meteor cataclysm ok");
await page.screenshot({ path: join(SHOTS, "stage3-meteor.png") });

const state = await page.evaluate(() => window.__gameState());
console.log("final state:", state);

if (consoleErrors.length) { console.error("CONSOLE ERRORS:", consoleErrors.slice(0, 5)); process.exit(1); }
console.log("STAGE3 OK: скиллы босса и катаклизмы работают");
await browser.close();
server.close();
