/**
 * coop-check.mjs — двухсторонний тест кооп-режима: хост создаёт лобби (C),
 * клиент входит по коду (J + буквы + Enter), хост стартует (Space),
 * оба должны оказаться в state=play и видеть врагов/друг друга.
 *
 * Usage: npm run build && node scripts/coop-check.mjs
 */
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
    let path;
    try { path = decodeURIComponent(raw); } catch { path = raw; }
    const file = resolve(DIST, "." + path);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
const errors = { host: [], client: [] };

async function makePage(tag) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors[tag].push(m.text()); });
  page.on("pageerror", (e) => errors[tag].push(String(e)));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 20000 });
  return page;
}

const fail = (msg) => { console.error(`COOP FAIL: ${msg}`); cleanup(1); };
async function cleanup(code) {
  await browser.close().catch(() => {});
  server.close();
  process.exit(code);
}

console.log("1. открываю хоста и клиента…");
const host = await makePage("host");
const client = await makePage("client");

console.log("2. хост создаёт лобби (C)…");
await host.keyboard.press("c");
await host.waitForFunction(() => window.__netInfo?.().mode === "host", null, { timeout: 5000 });
const code = await host.evaluate(() => window.__netInfo().code);
if (!/^[A-Z2-9]{5}$/.test(code)) await fail(`нет кода лобби: "${code}"`);
console.log(`   код лобби: ${code}`);

console.log("3. клиент входит по коду (J, буквы, Enter)…");
await client.keyboard.press("j");
for (const ch of code) await client.keyboard.press(ch);
await client.keyboard.press("Enter");

console.log("4. ждём handshake через nostr-релеи (до 60 сек)…");
try {
  await client.waitForFunction(() => window.__netInfo?.().lobby >= 2, null, { timeout: 60000 });
} catch {
  await host.screenshot({ path: join(SHOTS, "coop-host-stuck.png") });
  await client.screenshot({ path: join(SHOTS, "coop-client-stuck.png") });
  await fail("клиент не увидел лобби за 60 секунд");
}
await host.waitForFunction(() => window.__netInfo?.().lobby >= 2, null, { timeout: 10000 });
console.log("   оба в лобби");

console.log("5. хост стартует бой (Space)…");
await host.keyboard.press("Space");
await host.waitForFunction(() => window.__gameState?.() === "play", null, { timeout: 8000 });
await client.waitForFunction(() => window.__gameState?.() === "play", null, { timeout: 8000 });
console.log("   оба в игре");

console.log("6. ждём 8 секунд боя…");
await client.mouse.move(700, 400);
await client.keyboard.down("w");
await new Promise((r) => setTimeout(r, 4000));
await client.keyboard.up("w");
await new Promise((r) => setTimeout(r, 4000));

const hi = await host.evaluate(() => window.__netInfo());
const ci = await client.evaluate(() => window.__netInfo());
console.log(`   хост: players=${hi.players} enemies=${hi.enemies}`);
console.log(`   клиент: players=${ci.players} enemies=${ci.enemies}`);
await host.screenshot({ path: join(SHOTS, "coop-host.png") });
await client.screenshot({ path: join(SHOTS, "coop-client.png") });

if (hi.players < 2) await fail("хост не видит 2 игроков");
if (ci.players < 2) await fail("клиент не видит 2 игроков");
if (hi.enemies < 1) await fail("у хоста нет врагов");
if (ci.enemies < 1) await fail("клиент не видит врагов");
if (errors.host.length || errors.client.length) await fail(`console errors: ${JSON.stringify(errors)}`);

console.log("COOP OK: два игрока в одном бою, враги синхронизированы, ошибок нет");
await cleanup(0);
