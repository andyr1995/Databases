#!/usr/bin/env node
// Draws the app icons (iPhone, Android, web), the launch image and the Google Play
// listing art from one SVG, so the art can be regenerated (or restyled) without an
// image editor.
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
import { crc32, deflateSync, inflateSync } from 'node:zlib';

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
    `${svgOpen(size, size)}<rect width="${size}" height="${size}" fill="url(#bg)"/>` +
    `<g transform="translate(${size * inset} ${size * inset})">${emblem(inner)}</g></svg>`
  );
}

const GRADIENTS =
  `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a78"/><stop offset="1" stop-color="#1b1c44"/></linearGradient>` +
  `<linearGradient id="coral" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a98"/><stop offset="1" stop-color="#ff5a6e"/></linearGradient></defs>`;
const svgOpen = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${GRADIENTS}`;

/** The emblem alone on a transparent canvas (Android draws its own background and mask behind it). */
function foreground(size, inset) {
  const inner = size * (1 - inset * 2);
  return `${svgOpen(size, size)}<g transform="translate(${size * inset} ${size * inset})">${emblem(inner)}</g></svg>`;
}

/** The icon cut to a circle, for Android launchers that ask for a round one. */
function round(size) {
  const inner = size * 0.6;
  const off = (size - inner) / 2;
  return (
    `${svgOpen(size, size)}<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="url(#bg)"/>` +
    `<g transform="translate(${off} ${off})">${emblem(inner)}</g></svg>`
  );
}

/** Google Play's feature graphic: the emblem beside the name. */
function feature(w, h) {
  const inner = h * 0.56;
  const top = (h - inner) / 2;
  const left = w * 0.08;
  const x = left + inner + w * 0.06;
  const font = `font-family="ui-rounded, 'SF Pro Rounded', 'Nunito', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"`;
  return (
    `${svgOpen(w, h)}<rect width="${w}" height="${h}" fill="url(#bg)"/>` +
    `<g transform="translate(${left} ${top})">${emblem(inner)}</g>` +
    `<text x="${x}" y="${h * 0.5}" ${font} font-size="${h * 0.18}" font-weight="900" fill="#ffffff">First Come</text>` +
    `<text x="${x}" y="${h * 0.64}" ${font} font-size="${h * 0.066}" font-weight="700" fill="#c9c6f2">The order is the puzzle.</text></svg>`
  );
}

/** Empty margin around the emblem on Android's adaptive-icon layer and launch image, as a fraction of the canvas. */
const EMBLEM_INSET = 0.275;
const android = join(nativeDir, 'android');
const play = join(nativeDir, 'play');
/** Android screen densities: launcher icons are 48dp, adaptive layers 108dp, the launch image 288dp. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * Rewrites a PNG without an alpha channel as one with it (every pixel opaque). Chromium leaves
 * the channel out when nothing is transparent, and Google Play's icon is specified with it.
 * @param {Buffer} png  an 8-bit RGB or RGBA PNG, not interlaced
 */
function withAlpha(png) {
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += length + 12;
  }
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data;
  const [width, height, depth, colourType, interlace] = [header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[12]];
  if (colourType === 6) return png;
  if (depth !== 8 || colourType !== 2 || interlace !== 0) throw new Error('withAlpha: expected an 8-bit RGB PNG');
  const packed = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  const stride = width * 3;
  const out = Buffer.alloc(height * (1 + width * 4));
  let above = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    const row = Buffer.from(packed.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // Undo the PNG row filter (0 none, 1 left, 2 up, 3 average, 4 Paeth).
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? row[i - 3] : 0;
      const up = above[i];
      const upLeft = i >= 3 ? above[i - 3] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      row[i] = (row[i] + predicted) & 255;
    }
    const start = y * (1 + width * 4) + 1;
    for (let x = 0; x < width; x++) {
      row.copy(out, start + x * 4, x * 3, x * 3 + 3);
      out[start + x * 4 + 3] = 255;
    }
    above = row;
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return framed;
  };
  const newHeader = Buffer.from(header);
  newHeader[9] = 6;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', newHeader), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// [file, svg, width, height, transparent background?, 'rgba' to force an alpha channel]
const jobs = [
  [join(nativeDir, 'icon-1024.png'), art(1024, 0.15), 1024, 1024, false],
  [join(nativeDir, 'splash-2732.png'), art(2732, 0.41), 2732, 2732, false],
  [join(webDir, 'icons', 'icon-512.png'), art(512, 0.15), 512, 512, false],
  [join(webDir, 'icons', 'icon-192.png'), art(192, 0.15), 192, 192, false],
  [join(webDir, 'icons', 'icon-maskable-512.png'), art(512, 0.22), 512, 512, false],
  [join(webDir, 'icons', 'apple-touch-icon.png'), art(180, 0.15), 180, 180, false],
  [join(webDir, 'icons', 'favicon-48.png'), art(48, 0.1), 48, 48, false],
  // Google Play listing art (not part of the app).
  // Google asks for a 32-bit PNG (with alpha) here; `withAlpha` below sees to that.
  [join(play, 'icon-512.png'), art(512, 0.15), 512, 512, false, 'rgba'],
  [join(play, 'feature-graphic-1024x500.png'), feature(1024, 500), 1024, 500, false],
];
for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = join(android, `mipmap-${name}`);
  const icon = Math.round(48 * scale);
  const layer = Math.round(108 * scale);
  const launch = Math.round(288 * scale);
  jobs.push(
    // Launchers older than Android 8 use these two directly.
    [join(dir, 'ic_launcher.png'), art(icon, 0.15), icon, icon, false],
    [join(dir, 'ic_launcher_round.png'), round(icon), icon, icon, true],
    // Android 8 and later: this layer over a plain background, masked by the launcher.
    // Only the middle 66dp of the layer is guaranteed to be visible, so the emblem stays inside it.
    [join(dir, 'ic_launcher_foreground.png'), foreground(layer, EMBLEM_INSET), layer, layer, true],
    // The picture on Android's launch screen: the same drawing at its own, larger size, so
    // that it is sharp. Android shows a circle two thirds of the canvas across.
    [join(dir, 'ic_splash.png'), foreground(launch, EMBLEM_INSET), launch, launch, true],
  );
}

mkdirSync(join(webDir, 'icons'), { recursive: true });
const browser = await chromium.launch();
for (const [file, svg, width, height, transparent, format] of jobs) {
  mkdirSync(dirname(file), { recursive: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
  const png = await page.screenshot({ type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  writeFileSync(file, format === 'rgba' ? withAlpha(png) : png);
  await page.close();
  console.log('wrote', file);
}
// Colours the Android project needs alongside the images.
writeFileSync(
  join(android, 'colors.json'),
  `${JSON.stringify({ iconBackground: '#232466', splashBackground: '#1b1c44', statusBar: '#1b1c44' }, null, 2)}\n`,
);
console.log('wrote', join(android, 'colors.json'));
await browser.close();
