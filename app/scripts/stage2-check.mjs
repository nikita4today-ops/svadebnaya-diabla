/**
 * stage2-check.mjs — проверка этапа 2: волны с перерывами,
 * магазин (B, клавиши 1-6), прокачка навыков (1-4), золото.
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

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const dbg2 = () => page.evaluate(() => window.__dbg2());

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });

// старт соло за Никиту
await page.keyboard.press("Digit1");
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(1500);

let st = await dbg2();
console.log("initial:", JSON.stringify(st));
if (st.ws !== "fight") fail("ожидалась боевая фаза в начале");
console.log("fight ok:", JSON.stringify(st));

// зачистка волны → перерыв
await page.evaluate(() => window.__debug.wave());
await page.waitForTimeout(600);
st = await dbg2();
if (st.ws !== "break") fail("после зачистки волны не наступил перерыв");
console.log("break ok:", JSON.stringify(st));
await page.screenshot({ path: join(SHOTS, "stage2-break.png") });

// магазин
await page.evaluate(() => window.__debug.gold());
await page.keyboard.press("KeyB");
await page.waitForTimeout(300);
st = await dbg2();
if (!st.shop) fail("магазин не открылся в перерыв");
const goldBefore = st.gold;
await page.screenshot({ path: join(SHOTS, "stage2-shop.png") });

// покупка предмета 2 (Острый клинок, 50)
await page.keyboard.press("Digit2");
await page.waitForTimeout(300);
st = await dbg2();
if (st.gold >= goldBefore) fail(`золото не списалось: ${goldBefore} -> ${st.gold}`);
if (st.buys[1] !== 1) fail("предмет 2 не куплен");
console.log("buy ok:", JSON.stringify(st));

// прокачка навыка: закрыть магазин, ап уровня → очко → Digit1 (Q)
await page.keyboard.press("KeyB");
await page.waitForTimeout(200);
await page.evaluate(() => window.__debug.lvl());
await page.waitForTimeout(400);
st = await dbg2();
if (st.pts < 1) fail("очко навыка не выдано за уровень");
const qBefore = st.sk.q;
await page.keyboard.press("Digit1");
await page.waitForTimeout(300);
st = await dbg2();
if (st.sk.q !== qBefore + 1) fail(`прокачка Q не сработала: ${qBefore} -> ${st.sk.q}`);
if (st.pts !== 0) fail("очко не списалось");
console.log("skillup ok:", JSON.stringify(st));
await page.screenshot({ path: join(SHOTS, "stage2-levelup.png") });

// ульт заблокирован до 6 уровня
await page.keyboard.press("KeyT");
await page.waitForTimeout(200);
st = await dbg2();
if (st.sk.t !== 0) fail("ульт не должен быть прокачан");

// закрыть магазин, дождаться конца перерыва → волна 2
await page.keyboard.press("KeyB");
await page.waitForFunction(() => window.__dbg2().ws === "fight", null, { timeout: 20000 });
st = await dbg2();
console.log("wave2 fight ok:", JSON.stringify(st));
await page.waitForTimeout(2500);
await page.screenshot({ path: join(SHOTS, "stage2-wave2.png") });

const state = await page.evaluate(() => window.__gameState());
console.log("final state:", state);

if (consoleErrors.length) { console.error("CONSOLE ERRORS:", consoleErrors.slice(0, 5)); process.exit(1); }
console.log("STAGE2 OK: волны, перерыв, магазин, прокачка — всё работает");
await browser.close();
server.close();
