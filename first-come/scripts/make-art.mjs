#!/usr/bin/env node
// Draws the app icon, the web icons and the launch image from one SVG, so the
// art can be regenerated (or restyled) without an image editor.
//
//   node make-art.mjs [web-dir] [native-resources-dir]
//
// With no arguments it uses the web folder named in app.config.json and the resources/
// folder next to this one.
//
// Needs Playwright's Chromium (already installed in Claude Code cloud sessions;
// elsewhere: `npx playwright install chromium`).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
function findWebDir() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const config = join(here, '..', 'app.config.json');
  return resolve(dirname(config), JSON.parse(readFileSync(config, 'utf8')).webDir);
}
const webDir = findWebDir();
const nativeDir = resolve(process.argv[3] || join(here, '..', 'resources'));

const ARROWS =
  '<path d="M50 50V28M50 50H72M50 50V72M50 50H28" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>' +
  '<path d="M50 8l14 18H36zM92 50L74 64V36zM50 92L36 74h28zM8 50l18-14v28z" fill="#fff"/><circle cx="50" cy="50" r="10" fill="#fff"/>';

/** The 3x3 emblem: a coral block in the middle of squares already claimed by two other colours. */
function emblem(size) {
  const gap = size * 0.035;
  const cell = (size - gap * 2) / 3;
  const r = cell * 0.24;
  const tile = (cx, cy, fill, stripe) => {
    const x = cx * (cell + gap);
    const y = cy * (cell + gap);
    let s = `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${r}" fill="${fill}"/>`;
    if (stripe === 'h') s += `<rect x="${x + cell * 0.14}" y="${y + cell * 0.46}" width="${cell * 0.72}" height="${cell * 0.08}" rx="${cell * 0.04}" fill="#fff" opacity=".32"/>`;
    if (stripe === 'v') s += `<rect x="${x + cell * 0.46}" y="${y + cell * 0.14}" width="${cell * 0.08}" height="${cell * 0.72}" rx="${cell * 0.04}" fill="#fff" opacity=".32"/>`;
    return s;
  };
  const amber = '#ffab2e';
  const blue = '#3fb2ff';
  const mid = cell + gap;
  return (
    tile(0, 0, amber, 'h') + tile(1, 0, amber, 'h') + tile(2, 0, amber, 'h') + tile(0, 1, amber, 'v') +
    tile(2, 1, blue, 'v') + tile(0, 2, blue, 'h') + tile(1, 2, blue, 'h') + tile(2, 2, blue, 'h') +
    `<rect x="${mid}" y="${mid + cell * 0.05}" width="${cell}" height="${cell}" rx="${r}" fill="#bd3048"/>` +
    `<rect x="${mid}" y="${mid - cell * 0.03}" width="${cell}" height="${cell}" rx="${r}" fill="url(#coral)"/>` +
    `<g transform="translate(${mid} ${mid - cell * 0.03}) scale(${cell / 100})">${ARROWS}</g>`
  );
}

/** @param {number} size canvas size @param {number} inset fraction of the canvas left empty around the emblem */
function art(size, inset) {
  const inner = size * (1 - inset * 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a78"/><stop offset="1" stop-color="#1b1c44"/></linearGradient>` +
    `<linearGradient id="coral" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a98"/><stop offset="1" stop-color="#ff5a6e"/></linearGradient></defs>` +
    `<rect width="${size}" height="${size}" fill="url(#bg)"/>` +
    `<g transform="translate(${size * inset} ${size * inset})">${emblem(inner)}</g></svg>`
  );
}

const jobs = [
  // [file, canvas px, empty margin]
  [join(nativeDir, 'icon-1024.png'), 1024, 0.15],
  [join(nativeDir, 'splash-2732.png'), 2732, 0.41],
  [join(webDir, 'icons', 'icon-512.png'), 512, 0.15],
  [join(webDir, 'icons', 'icon-192.png'), 192, 0.15],
  [join(webDir, 'icons', 'icon-maskable-512.png'), 512, 0.22],
  [join(webDir, 'icons', 'apple-touch-icon.png'), 180, 0.15],
  [join(webDir, 'icons', 'favicon-48.png'), 48, 0.1],
];

mkdirSync(join(webDir, 'icons'), { recursive: true });
mkdirSync(nativeDir, { recursive: true });
const browser = await chromium.launch();
for (const [file, size, inset] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${art(size, inset)}</body>`);
  writeFileSync(file, await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } }));
  await page.close();
  console.log('wrote', file);
}
await browser.close();
