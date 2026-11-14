// app.config.json is the single source of truth: check its contents, and that
// capacitor.config.ts and the bridge derive from it instead of repeating it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  configWarnings,
  GOOGLE_ANDROID_DEMO_UNITS,
  GOOGLE_ANDROID_SAMPLE_APP_ID,
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
  assert.match(appConfig.version, /^\d+(\.\d+){0,2}$/, 'the rule scripts/configure-ios.mjs applies');
  assert.ok(Number.isInteger(appConfig.build) && appConfig.build >= 1);
  assert.equal(typeof appConfig.webDir, 'string');
  assert.equal(typeof appConfig.admob.testing, 'boolean');
  for (const os of ['ios', 'android']) {
    assert.match(appConfig.admob[os].appId, /^ca-app-pub-\d{16}~\d{10}$/, os);
    for (const format of ['banner', 'interstitial', 'rewarded']) {
      assert.match(appConfig.admob[os][format], /^ca-app-pub-\d{16}\/\d{10}$/, `${os} ${format}`);
    }
  }
  // An AdMob app, and each of its ad units, belongs to one store. The same id under both
  // systems is a paste into the wrong block.
  for (const key of ['appId', 'banner', 'interstitial', 'rewarded']) {
    assert.notEqual(appConfig.admob.android[key], appConfig.admob.ios[key], `admob.android.${key} repeats admob.ios.${key}`);
  }
  assert.ok(appConfig.iap.removeAdsProductId.length > 0);
  assert.ok(appConfig.trackingUsageDescription.length > 20, 'iOS shows this sentence in the tracking prompt');
});

// What app.config.json holds while testing is on is deliberately NOT checked: the shipping
// guide has the real AdMob ids pasted in first and "testing" switched off last. That a
// testing build cannot request a real ad unit is the next test's job.
test('the demo ids the bridge falls back to are Google\'s iOS demo ids', () => {
  // Values from https://developers.google.com/admob/ios/test-ads and .../ios/quick-start
  assert.deepEqual(GOOGLE_IOS_DEMO_UNITS, {
    banner: 'ca-app-pub-3940256099942544/2435281174', // Anchored Adaptive Banner
    interstitial: 'ca-app-pub-3940256099942544/4411468910',
    rewarded: 'ca-app-pub-3940256099942544/1712485313',
  });
  assert.equal(GOOGLE_IOS_SAMPLE_APP_ID, 'ca-app-pub-3940256099942544~1458002511');
});

test('the demo ids the bridge falls back to on Android are Google\'s Android demo ids', () => {
  // Values from https://developers.google.com/admob/android/test-ads and .../android/quick-start
  // (both read on 2026-11-14)
  assert.deepEqual(GOOGLE_ANDROID_DEMO_UNITS, {
    banner: 'ca-app-pub-3940256099942544/9214589741', // Anchored Adaptive Banner
    interstitial: 'ca-app-pub-3940256099942544/1033173712',
    rewarded: 'ca-app-pub-3940256099942544/5224354917', // Rewarded Ads
  });
  assert.equal(GOOGLE_ANDROID_SAMPLE_APP_ID, 'ca-app-pub-3940256099942544~3347511713');
  for (const format of ['banner', 'interstitial', 'rewarded']) {
    assert.notEqual(GOOGLE_ANDROID_DEMO_UNITS[format], GOOGLE_IOS_DEMO_UNITS[format], format);
  }
});

test('resolveAdUnits on Android: the same rule, with the Android demo units', () => {
  const real = {
    appId: 'ca-app-pub-1111111111111111~3333333333',
    banner: 'ca-app-pub-1111111111111111/2000000001',
    interstitial: 'ca-app-pub-1111111111111111/2000000002',
    rewarded: 'ca-app-pub-1111111111111111/2000000003',
  };
  const iosReal = { appId: 'x', banner: 'ios-banner', interstitial: 'ios-interstitial', rewarded: 'ios-rewarded' };
  assert.deepEqual(resolveAdUnits({ testing: true, ios: iosReal, android: real }, 'android'), GOOGLE_ANDROID_DEMO_UNITS);
  assert.deepEqual(resolveAdUnits({ testing: false, ios: iosReal, android: real }, 'android'), {
    banner: real.banner,
    interstitial: real.interstitial,
    rewarded: real.rewarded,
  });
  // One real id left among demo ids is still replaced, format by format.
  assert.deepEqual(
    resolveAdUnits({ testing: true, android: { ...real, ...GOOGLE_ANDROID_DEMO_UNITS, interstitial: real.interstitial } }, 'android'),
    GOOGLE_ANDROID_DEMO_UNITS,
  );
  // Each system only ever gets its own block.
  assert.deepEqual(resolveAdUnits({ testing: true, ios: iosReal, android: real }, 'ios'), GOOGLE_IOS_DEMO_UNITS);
  assert.equal(resolveAdUnits({ testing: false, ios: iosReal }, 'android'), null);
  assert.equal(resolveAdUnits({ testing: false, android: real }, 'ios'), null);
});

test('with the shipped app.config.json, both systems get units of their own', () => {
  const ios = resolveAdUnits(appConfig.admob, 'ios');
  const android = resolveAdUnits(appConfig.admob, 'android');
  assert.ok(ios && android);
  for (const format of ['banner', 'interstitial', 'rewarded']) {
    assert.match(android[format], /^ca-app-pub-\d{16}\/\d{10}$/);
    assert.notEqual(android[format], ios[format], format);
    if (appConfig.admob.testing) assert.ok(isDemoUnit(android[format]) && isDemoUnit(ios[format]), format);
  }
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
  assert.equal(resolveAdUnits(appConfig.admob, 'web'), null);
  assert.equal(resolveAdUnits({ testing: false }, 'ios'), null);
  assert.equal(resolveAdUnits({ testing: true }, 'android'), null);
});

test('configWarnings flags a release build that would still show demo ads, on either system', () => {
  const iosDemo = { appId: GOOGLE_IOS_SAMPLE_APP_ID, ...GOOGLE_IOS_DEMO_UNITS };
  const androidDemo = { appId: GOOGLE_ANDROID_SAMPLE_APP_ID, ...GOOGLE_ANDROID_DEMO_UNITS };
  const iosReal = {
    appId: 'ca-app-pub-1111111111111111~2222222222',
    banner: 'ca-app-pub-1111111111111111/1000000001',
    interstitial: 'ca-app-pub-1111111111111111/1000000002',
    rewarded: 'ca-app-pub-1111111111111111/1000000003',
  };
  const androidReal = {
    appId: 'ca-app-pub-1111111111111111~3333333333',
    banner: 'ca-app-pub-1111111111111111/2000000001',
    interstitial: 'ca-app-pub-1111111111111111/2000000002',
    rewarded: 'ca-app-pub-1111111111111111/2000000003',
  };
  const iap = { removeAdsProductId: 'remove_ads' };
  const warnings = (admob, purchases = iap) => configWarnings({ admob, iap: purchases });

  // Fit for release: nothing to say.
  assert.deepEqual(warnings({ testing: false, ios: iosReal, android: androidReal }), []);

  // Testing: one note, whatever the ids are (the shipping guide has the real ids pasted in first).
  assert.equal(warnings({ testing: true, ios: iosDemo, android: androidDemo }).length, 1);
  assert.equal(warnings({ testing: true, ios: iosReal, android: androidReal }).length, 1);
  assert.match(warnings({ testing: true, ios: iosDemo, android: androidDemo })[0], /admob\.testing is true/);

  // Released with demo ids: the units and the app id, for each system that still has them.
  assert.equal(warnings({ testing: false, ios: iosDemo, android: androidReal }).length, 2);
  const androidLeft = warnings({ testing: false, ios: iosReal, android: androidDemo });
  assert.equal(androidLeft.length, 2);
  assert.match(androidLeft[0], /admob\.android ids are still Google demo units: banner, interstitial, rewarded/);
  assert.match(androidLeft[1], /admob\.android\.appId/);
  assert.equal(warnings({ testing: false, ios: iosDemo, android: androidDemo }).length, 4);
  assert.match(warnings({ testing: false, ios: iosReal, android: { ...androidReal, rewarded: androidDemo.rewarded } })[0], /units: rewarded\./);

  // A system without ids shows no ads at all.
  assert.deepEqual(warnings({ testing: false, ios: iosReal }), ['admob.android is missing: the Android app will show no ads.']);
  assert.deepEqual(warnings({ testing: false, android: androidReal }), ['admob.ios is missing: the iOS app will show no ads.']);
  assert.equal(warnings({ testing: false }, { removeAdsProductId: '' }).length, 3);
});

test('the build reports exactly what configWarnings says about the shipped config', () => {
  const said = configWarnings({ admob: appConfig.admob, iap: appConfig.iap });
  // While testing is on this is the one reminder; with real ids and testing off it is empty.
  assert.deepEqual(said, appConfig.admob.testing ? ['admob.testing is true: this build only requests Google demo ads and earns nothing.'] : []);
});

test('capacitor.config.ts takes appId, appName and webDir from app.config.json', async () => {
  const { default: capacitorConfig } = await import('../capacitor.config.ts');
  assert.equal(capacitorConfig.appId, appConfig.appId);
  assert.equal(capacitorConfig.appName, appConfig.appName);
  assert.equal(capacitorConfig.webDir, appConfig.webDir);
});

test('capacitor.config.ts on Android: dark web view, light system-bar icons, Capacitor handles the insets', async () => {
  const { default: capacitorConfig } = await import('../capacitor.config.ts');
  const colors = JSON.parse(readFileSync(path.join(root, 'resources', 'android', 'colors.json'), 'utf8'));
  // The web view starts out in the colour of the launch screen: no white flash between the two.
  assert.equal(capacitorConfig.android.backgroundColor, colors.splashBackground);
  assert.match(capacitorConfig.android.backgroundColor, /^#[0-9a-f]{6}$/i, 'a form WebColor.parseColor accepts');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(capacitorConfig.android.backgroundColor.slice(i, i + 2), 16));
  assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b < 64, 'a dark colour');
  assert.equal(capacitorConfig.backgroundColor, undefined, 'not the global key, which iPhone reads too');
  assert.equal(capacitorConfig.ios.backgroundColor, undefined);

  const bars = capacitorConfig.plugins.SystemBars;
  assert.equal(bars.style, 'DARK', 'light icons on the dark game');
  // The bridge (src/bridge/viewport.ts) and the stylesheet read --safe-area-inset-*, which only 'css' sets,
  // and the AdMob plugin places the banner by what this handling passes down.
  assert.equal(bars.insetsHandling, 'css');
  assert.equal(bars.initialViewportFitValueHint, 'cover');
  const html = readFileSync(path.resolve(root, appConfig.webDir, 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/, 'the hint is true: the page asks for it');
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
  // Scripts, tests, package.json (its "scripts" and its description too), workflows and the
  // documentation all take the location of the web app from app.config.json, so that moving
  // the folder is a one-line change. Only installed and generated files are skipped.
  const needle = appConfig.webDir;
  const skip = new Set(['node_modules', 'ios', 'android', '.git', 'package-lock.json']);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  assert.deepEqual(
    hits.sort(),
    ['app.config.json'],
    `"${needle}" must appear only in app.config.json ("webDir"). Code in the other files listed should read it from ` +
      'there, as scripts/build-bridge.mjs does; documentation should say "the web folder" or name it from the top of the repository.',
  );
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
