// Bundles src/bridge/index.ts into <webDir>/vendor/native-bridge.js, the one file the web
// game imports when it runs inside the Capacitor shell.
//
// The web app's location comes from app.config.json ("webDir") and from nowhere else.
// Run through `npm run build:bridge` (needs Node 22.18+: it imports a .ts file directly).

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { configWarnings } from '../src/bridge/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';

const appConfig = JSON.parse(await readFile(path.join(root, 'app.config.json'), 'utf8'));
if (typeof appConfig.webDir !== 'string' || !appConfig.webDir) {
  console.error('build:bridge: app.config.json has no "webDir".');
  process.exit(1);
}

const webDir = path.resolve(root, appConfig.webDir);
const webDirStat = await stat(webDir).catch(() => null);
if (!webDirStat || !webDirStat.isDirectory()) {
  console.error(`build:bridge: webDir "${appConfig.webDir}" (${webDir}) is not a directory.`);
  process.exit(1);
}

// The oldest engines the bundle must parse: Safari 15 for iPhone (iOS 15), and for Android
// the oldest WebView the game's own stylesheet works in (it uses the `inset` shorthand,
// Chromium 87). Capacitor itself accepts WebView 60 and up.
const TARGETS = ['safari15', 'chrome87'];

const entry = path.join(root, 'src', 'bridge', 'index.ts');
const outfile = path.join(webDir, 'vendor', 'native-bridge.js');
// Written relative to the generated file, so the header stays right when both folders move.
const sourceFromOutput = path.relative(path.dirname(outfile), path.dirname(entry)).split(path.sep).join('/');

const banner = [
  '/*',
  ' * GENERATED FILE. Do not edit: changes are overwritten by the next build.',
  ' *',
  ' * Native bridge for the Capacitor apps (iPhone and Android): AdMob, App Store and Google Play',
  ' * purchases, haptics, share sheet, durable storage, Android Back.',
  ' * js/platform.js imports it only when the game runs inside the native shell.',
  ' *',
  ` * Source:  ${sourceFromOutput}/ (TypeScript; ad unit ids come from app.config.json beside it)`,
  ' * Rebuild: npm run build:bridge, in the folder that contains that src/ directory',
  ' */',
].join('\n');

// src/bridge/index.ts imports app.config.json. Only the two sections the bridge uses are
// compiled in; the rest (bundle id, version, the local web folder ...) stays out of the web app.
const bridgeConfigOnly = {
  name: 'bridge-config-only',
  setup(b) {
    b.onLoad({ filter: /[\\/]app\.config\.json$/ }, async (args) => {
      const full = JSON.parse(await readFile(args.path, 'utf8'));
      return { contents: JSON.stringify({ admob: full.admob, iap: full.iap }), loader: 'json' };
    });
  },
};

await mkdir(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: TARGETS,
  minify: true,
  legalComments: 'eof',
  banner: { js: banner },
  plugins: [bridgeConfigOnly],
  metafile: true,
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`build:bridge: wrote ${rel(outfile)} (${(bytes / 1024).toFixed(1)} kB, esm, ${TARGETS.join(' + ')}, minified)`);

const config = { admob: appConfig.admob ?? { testing: true }, iap: appConfig.iap ?? { removeAdsProductId: '' } };
for (const warning of configWarnings(config)) console.warn(`build:bridge: note: ${warning}`);
