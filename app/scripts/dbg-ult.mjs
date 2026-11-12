/* Одноразовая диагностика: Максим, ультимейт T, снимки каждые 100 мс + внутреннее состояние. */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "verification-shots");
mkdirSync(SHOTS, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = resolve(DIST, "." + raw);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 });
await page.keyboard.press("Digit2");
await page.waitForTimeout(150);
await page.keyboard.press("Space");
await page.waitForTimeout(2000);
await page.evaluate(() => window.__debug && window.__debug.heal());
await page.keyboard.press("KeyR");
await page.waitForTimeout(500);
await page.keyboard.press("KeyT");
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(100);
  const info = await page.evaluate(() => {
    const g = window.__dbg;
    return g ? g() : null;
  });
  console.log(i, JSON.stringify(info));
  await page.screenshot({ path: join(SHOTS, `dbg-t-${i}.png`) });
}
await browser.close();
server.close();
