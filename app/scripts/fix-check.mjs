import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "verification-shots");
mkdirSync(SHOTS, { recursive: true });
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

const hero = process.argv[2] || "1";
const skill = process.argv[3] || "KeyR"; // какой скилл активировать для кадра
await page.keyboard.press(`Digit${hero}`);
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(1500);
// двигаем мышь в сторону, чтобы герой смотрел вправо-вниз (лицом к камере)
await page.mouse.move(640, 560);
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, `fix-face-h${hero}.png`) });
// активируем маунта/скилл
await page.evaluate(() => window.__debug.heal());
await page.keyboard.press(skill);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(SHOTS, `fix-mount-h${hero}.png`) });
console.log("fix shots ok, errors:", errs.length ? errs : "none");
await browser.close();
server.close();
