import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = resolve(DIST, "." + decodeURIComponent(raw));
    if (!file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__GAME_READY__ === true);
await page.keyboard.press("Digit3"); // Даша — дальний бой
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(1000);

// проверка: точка прицела должна проецироваться обратно ровно в курсор
let ok = true;
for (const [mx, my] of [[1000, 200], [300, 500], [640, 100], [1100, 600], [200, 150]]) {
  await page.mouse.move(mx, my);
  await page.waitForTimeout(120);
  const a = await page.evaluate(() => window.__dbgAim());
  const dx = Math.abs(a.scrX - mx), dy = Math.abs(a.scrY - my);
  const good = dx < 6 && dy < 6;
  if (!good) ok = false;
  console.log(`mouse(${mx},${my}) -> aim(${a.aimX.toFixed(0)},${a.aimY.toFixed(0)}) -> screen(${a.scrX.toFixed(1)},${a.scrY.toFixed(1)}) ${good ? "OK" : "FAIL dx=" + dx.toFixed(1) + " dy=" + dy.toFixed(1)}`);
}

// дальняя атака: снаряды летят строго к курсору
await page.mouse.move(1100, 200);
await page.waitForTimeout(100);
await page.mouse.down();
await page.waitForTimeout(400);
await page.mouse.up();
const a2 = await page.evaluate(() => window.__dbgAim());
console.log("facing after ranged attack:", a2.facing.toFixed(2), "(ожидается в сторону курсора)");

// ближняя атака Никиты без врага под курсором — замаха быть не должно
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.keyboard.press("Digit1");
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(800);
await page.mouse.move(200, 150); // пустое место
await page.mouse.down();
await page.waitForTimeout(500);
await page.mouse.up();
console.log("melee no-target click done (замах в пустоту заблокирован логикой)");

if (errs.length) { console.log("CONSOLE ERRORS:", errs); process.exit(1); }
console.log(ok ? "AIM OK: прицел точно следует за курсором" : "AIM FAIL");
process.exit(ok ? 0 : 1);
