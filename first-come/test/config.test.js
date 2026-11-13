// app.config.json is the single source of truth: check its contents, and that
// capacitor.config.ts and the bridge derive from it instead of repeating it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  configWarnings,
  GOOGLE_IOS_DEMO_UNITS,
  GOOGLE_IOS_SAMPLE_APP_ID,
  isDemoUnit,
  resolveAdUnits,
} from '../src/bridge/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appConfig = JSON.parse(readFileSync(path.join(root, 'app.config.json'), 'utf8'));

test('app.config.json has every field the build needs', () => {
  assert.match(appConfig.appId, /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/);
  assert.equal(typeof appConfig.appName, 'string');
  assert.match(appConfig.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(appConfig.build) && appConfig.build >= 1);
  assert.equal(typeof appConfig.webDir, 'string');
  assert.equal(typeof appConfig.admob.testing, 'boolean');
  assert.match(appConfig.admob.ios.appId, /^ca-app-pub-\d{16}~\d{10}$/);
  for (const format of ['banner', 'interstitial', 'rewarded']) {
    assert.match(appConfig.admob.ios[format], /^ca-app-pub-\d{16}\/\d{10}$/, format);
  }
  assert.ok(appConfig.iap.removeAdsProductId.length > 0);
  assert.ok(appConfig.trackingUsageDescription.length > 20, 'iOS shows this sentence in the tracking prompt');
});

test('while testing is on, the configured ids are Google\'s iOS demo ids', () => {
  // Values from https://developers.google.com/admob/ios/test-ads and .../ios/quick-start
  assert.deepEqual(GOOGLE_IOS_DEMO_UNITS, {
    banner: 'ca-app-pub-3940256099942544/2435281174', // Anchored Adaptive Banner
    interstitial: 'ca-app-pub-3940256099942544/4411468910',
    rewarded: 'ca-app-pub-3940256099942544/1712485313',
  });
  assert.equal(GOOGLE_IOS_SAMPLE_APP_ID, 'ca-app-pub-3940256099942544~1458002511');
  if (!appConfig.admob.testing) return;
  const { appId, ...units } = appConfig.admob.ios;
  assert.equal(appId, GOOGLE_IOS_SAMPLE_APP_ID);
  assert.deepEqual(units, GOOGLE_IOS_DEMO_UNITS);
});

test('resolveAdUnits: testing never lets a real ad unit through', () => {
  const real = {
    appId: 'ca-app-pub-1111111111111111~2222222222',
    banner: 'ca-app-pub-1111111111111111/1000000001',
    interstitial: 'ca-app-pub-1111111111111111/1000000002',
    rewarded: 'ca-app-pub-1111111111111111/1000000003',
  };
  assert.deepEqual(resolveAdUnits({ testing: true, ios: real }, 'ios'), GOOGLE_IOS_DEMO_UNITS);
  assert.deepEqual(resolveAdUnits({ testing: false, ios: real }, 'ios'), {
    banner: real.banner,
    interstitial: real.interstitial,
    rewarded: real.rewarded,
  });
  assert.deepEqual(
    resolveAdUnits({ testing: true, ios: { ...real, rewarded: GOOGLE_IOS_DEMO_UNITS.rewarded } }, 'ios'),
    GOOGLE_IOS_DEMO_UNITS,
  );
  assert.equal(isDemoUnit(real.banner), false);
  assert.equal(isDemoUnit(GOOGLE_IOS_DEMO_UNITS.banner), true);
});

test('resolveAdUnits: no units for an OS the config does not cover', () => {
  assert.equal(resolveAdUnits(appConfig.admob, 'android'), null);
  assert.equal(resolveAdUnits(appConfig.admob, 'web'), null);
  assert.equal(resolveAdUnits({ testing: false }, 'ios'), null);
});

test('configWarnings flags a release build that would still show demo ads', () => {
  const demo = { appId: GOOGLE_IOS_SAMPLE_APP_ID, ...GOOGLE_IOS_DEMO_UNITS };
  const iap = { removeAdsProductId: 'remove_ads' };
  assert.equal(configWarnings({ admob: { testing: true, ios: demo }, iap }).length, 1);
  assert.equal(configWarnings({ admob: { testing: false, ios: demo }, iap }).length, 2);
  const real = {
    appId: 'ca-app-pub-1111111111111111~2222222222',
    banner: 'ca-app-pub-1111111111111111/1000000001',
    interstitial: 'ca-app-pub-1111111111111111/1000000002',
    rewarded: 'ca-app-pub-1111111111111111/1000000003',
  };
  assert.deepEqual(configWarnings({ admob: { testing: false, ios: real }, iap }), []);
  assert.equal(configWarnings({ admob: { testing: false }, iap: { removeAdsProductId: '' } }).length, 2);
});

test('capacitor.config.ts takes appId, appName and webDir from app.config.json', async () => {
  const { default: capacitorConfig } = await import('../capacitor.config.ts');
  assert.equal(capacitorConfig.appId, appConfig.appId);
  assert.equal(capacitorConfig.appName, appConfig.appName);
  assert.equal(capacitorConfig.webDir, appConfig.webDir);
});

test('capacitor.config.ts: full-bleed web view, launch screen with a native fallback timer', async () => {
  const { default: capacitorConfig } = await import('../capacitor.config.ts');
  assert.equal(capacitorConfig.ios.contentInset, 'never');
  const splash = capacitorConfig.plugins.SplashScreen;
  // launchAutoHide must stay true: it is what removes the launch screen when no JavaScript runs.
  assert.equal(splash.launchAutoHide, true);
  assert.ok(splash.launchShowDuration >= 2000 && splash.launchShowDuration <= 10000);
});

test('the web folder is named in exactly one place', () => {
  const needle = appConfig.webDir;
  const skip = new Set(['node_modules', 'ios', 'android', '.git', 'package-lock.json']);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['app.config.json']);
});

test('package.json: dependencies on the Capacitor 8 line, the four required scripts', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  for (const name of [
    '@capacitor/core',
    '@capacitor/ios',
    '@capacitor-community/admob',
    '@capacitor/haptics',
    '@capacitor/share',
    '@capacitor/app',
    '@capacitor/preferences',
    '@capacitor/browser',
    '@capacitor/splash-screen',
    '@capgo/native-purchases',
  ]) {
    assert.match(pkg.dependencies[name] ?? '', /^\^8\./, name);
  }
  for (const name of ['@capacitor/cli', 'esbuild', 'typescript']) assert.ok(pkg.devDependencies[name], name);
  for (const script of ['build:bridge', 'typecheck', 'test', 'sync']) assert.ok(pkg.scripts[script], script);
  assert.match(pkg.scripts.sync, /build:bridge.*cap sync ios/);
});
