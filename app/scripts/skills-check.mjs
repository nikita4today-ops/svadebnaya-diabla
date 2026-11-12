/**
 * skills-check.mjs — визуальная проверка скиллов R (маунт/клон),
 * ультимейтов (T) и зова САТОРУ (F) у всех четырёх героев.
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

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });

const NAMES = ["nikita", "maxim", "dasha", "vika"];
for (let h = 0; h < 4; h++) {
  // из состояния play/over — перезагружаем страницу для чистоты
  if (h > 0) {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });
  }
  await page.keyboard.press(`Digit${h + 1}`);
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await page.waitForTimeout(2500); // враги подходят
  await page.evaluate(() => window.__debug && window.__debug.heal());
  // скилл R (маунт/клон)
  await page.evaluate(() => window.__debug && window.__debug.heal());
  await page.keyboard.press("KeyR");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `mount-${NAMES[h]}.png`) });
  // ультимейт T (открывается с 6 уровня — ап уровня и прокачка)
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__debug.lvl(); });
  await page.waitForTimeout(400);
  await page.keyboard.press("Digit4");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__debug && window.__debug.heal());
  await page.keyboard.press("KeyT");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `ult-${NAMES[h]}.png`) });
  // зов САТОРУ на F
  await page.keyboard.press("KeyF");
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, `satoru-${NAMES[h]}.png`) });
  const state = await page.evaluate(() => window.__gameState());
  console.log(NAMES[h], "state:", state);
}

if (consoleErrors.length) { console.error("CONSOLE ERRORS:", consoleErrors.slice(0, 5)); process.exit(1); }
console.log("SKILLS OK: все ультимейты и САТОРУ отработали без ошибок");
await browser.close();
server.close();
