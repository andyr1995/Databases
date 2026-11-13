#!/usr/bin/env node
// Takes the App Store screenshots by playing the real game in a headless browser.
//
//   node scripts/make-screenshots.mjs [out-dir]
//
// Writes five 1320 x 2868 PNGs (the 6.9-inch iPhone size App Store Connect asks for).
// Needs Playwright's Chromium (already installed in Claude Code cloud sessions;
// elsewhere: `npx playwright install chromium`).
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', 'app.config.json'), 'utf8'));
const webDir = resolve(here, '..', config.webDir);
const outDir = resolve(process.argv[2] || join(here, '..', 'store', 'screenshots'));
mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  try {
    const data = await readFile(join(webDir, normalize(path)));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
// 440 x 956 CSS px at 3x is exactly 1320 x 2868.
const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
// Leave room where the iPhone's status bar and home indicator would be.
await context.addInitScript(() => {
  const style = document.createElement('style');
  style.textContent = ':root { --safe-top: 54px !important; --safe-bottom: 30px !important; }';
  document.addEventListener('DOMContentLoaded', () => document.head.append(style));
});
const page = await context.newPage();

/** Blocks that are safe / unsafe to tap in the campaign level on screen, given the taps made so far. */
async function advice(taps) {
  return page.evaluate(async (made) => {
    const { createSolver, startPosition, play } = await import('./js/engine.js');
    const { campaignLevel } = await import('./js/levels.js');
    const number = Number(document.querySelector('.title').textContent.replace(/\D+/g, ''));
    const level = campaignLevel(number);
    const solver = createSolver(level);
    let pos = startPosition(level);
    for (const b of made) pos = play(level, pos, b);
    const safe = solver.safeBlocks(pos);
    const unsafe = [];
    for (let b = 0; b < level.blocks.length; b++) {
      if (!(pos.done & (1 << b)) && !safe.includes(b) && play(level, pos, b).claimed > pos.claimed) unsafe.push(b);
    }
    return { safe, unsafe, blocks: level.blocks.length };
  }, taps);
}
const tap = (b) => page.locator(`.block[data-b="${b}"]`).click();
const open = async (query) => {
  await page.goto(base + query);
  await page.waitForSelector('.board, .screen.home');
  await page.waitForTimeout(500);
};
const shot = async (name) => {
  await page.screenshot({ path: join(outDir, name) });
  console.log('wrote', join(outDir, name));
};

// 1. Mid-play: a busy board with colours meeting.
await open('?level=72');
let made = [];
for (let i = 0; i < 4; i++) {
  const { safe } = await advice(made);
  if (safe.length <= 1 && i > 1) break;
  await tap(safe[0]);
  made.push(safe[0]);
  await page.waitForTimeout(450);
}
await page.waitForTimeout(500);
await shot('1-play.png');

// 2. A slip: the squares that would be stranded are crossed.
await open('?level=37');
made = [];
{
  const first = await advice(made);
  await tap(first.safe[0]);
  made.push(first.safe[0]);
  await page.waitForTimeout(600);
  const next = await advice(made);
  await tap((next.unsafe.length ? next.unsafe : first.unsafe)[0]);
  await page.waitForSelector('.cross');
  await page.waitForTimeout(260);
}
await shot('2-slip.png');

// 3. The Daily, with its three hearts.
await open('?daily');
await shot('3-daily.png');

// 4. A flawless result.
await open('?level=24');
made = [];
for (let i = 0; i < 12; i++) {
  const { safe } = await advice(made);
  if (!safe.length) break;
  await tap(safe[0]);
  made.push(safe[0]);
  await page.waitForTimeout(350);
}
await page.waitForSelector('.sheet.result');
await page.waitForTimeout(1400);
await shot('4-result.png');

// 5. Home, after a little progress.
await page.locator('.sheet button', { hasText: 'Home' }).click();
await page.waitForSelector('.screen.home');
await page.waitForTimeout(500);
await shot('5-home.png');

await browser.close();
server.close();
