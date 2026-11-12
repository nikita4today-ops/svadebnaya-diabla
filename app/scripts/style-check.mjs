/* Скриншоты: Даша крупно + ходьба (кадр в движении) + бой у Вики. */
import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";
const root = "dist";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__GAME_READY__);
await page.waitForTimeout(700);
await page.screenshot({ path: "shots/p-title.png" });

// Даша: ходьба — кадр в движении
await page.keyboard.press("3");
await page.keyboard.press("Space");
await page.waitForTimeout(1000);
await page.keyboard.down("KeyD");
await page.waitForTimeout(400);
await page.screenshot({ path: "shots/p-dasha-walk.png" });
await page.waitForTimeout(2500);
await page.keyboard.up("KeyD");
await page.screenshot({ path: "shots/p-dasha-fight.png" });

// Вика: бой с пожирателями + Протего
await page.reload();
await page.waitForFunction(() => window.__GAME_READY__);
await page.keyboard.press("4");
await page.keyboard.press("Space");
await page.waitForTimeout(3000);
await page.keyboard.down("KeyA");
await page.waitForTimeout(350);
await page.keyboard.up("KeyA");
await page.keyboard.press("KeyE");
await page.mouse.move(800, 250);
await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
await page.keyboard.press("KeyR");
await page.waitForTimeout(1000);
await page.screenshot({ path: "shots/p-vika.png" });
console.log("CONSOLE_ERRORS:", JSON.stringify(errors));
await browser.close();
server.close();
