// The built file itself: <webDir>/vendor/native-bridge.js, exactly as the game imports it.
//
// `npm test` rebuilds it first. Here it is loaded in Node with a pretend iOS shell in which
// NO plugin is implemented (every plugin call rejects), which is the harshest condition the
// bridge can meet: install() must still honour the contract and nothing may throw or reject.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ADS_ARGS, assertContract, loadWebPlatform, resultKinds, root, webDir } from './contract-helpers.js';
import { settle } from './helpers.js';

const bundlePath = path.join(webDir, 'vendor', 'native-bridge.js');

// What @capacitor/core looks for to decide it is running inside the iOS shell.
globalThis.webkit = { messageHandlers: { bridge: { postMessage() {} } } };

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

// With every plugin missing the bridge keeps retrying on real timers, as it should in the
// app. Track them so they can be cancelled when the tests are done and Node can exit.
const realSetTimeout = globalThis.setTimeout;
const timers = new Set();
globalThis.setTimeout = (...args) => {
  const timer = realSetTimeout(...args);
  timers.add(timer);
  return timer;
};

// The bridge reports each failed plugin call with console.warn. Keep the test output readable.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));

after(() => {
  for (const timer of timers) clearTimeout(timer);
  globalThis.setTimeout = realSetTimeout;
  console.warn = realWarn;
});

let bridge;
let source;

before(async () => {
  source = readFileSync(bundlePath, 'utf8');
  bridge = await import(pathToFileURL(bundlePath).href);
});

test('the bundle exists, is fresh, and says where it comes from', () => {
  assert.match(source, /^\/\*\n \* GENERATED FILE\. Do not edit/);
  const header = source.slice(0, source.indexOf('*/'));
  const sourceLine = /Source:\s+(\S+)/.exec(header);
  assert.ok(sourceLine, 'the header names the source folder');
  assert.equal(
    path.resolve(path.dirname(bundlePath), sourceLine[1]),
    path.join(root, 'src', 'bridge'),
    'and the path in the header leads back to src/bridge',
  );
  assert.match(header, /npm run build:bridge/);

  const sourceDir = path.join(root, 'src', 'bridge');
  const inputs = [...readdirSync(sourceDir).map((name) => path.join(sourceDir, name)), path.join(root, 'app.config.json')];
  const newestInput = Math.max(...inputs.map((file) => statSync(file).mtimeMs));
  assert.ok(statSync(bundlePath).mtimeMs >= newestInput, 'the bundle is older than its sources: run npm run build:bridge');
});

test('the bundle is one self-contained, minified ES module that exports install()', () => {
  assert.deepEqual(Object.keys(bridge), ['install']);
  assert.equal(typeof bridge.install, 'function');
  // It loaded from a folder with no node_modules above it, so nothing is left to resolve.
  assert.doesNotMatch(source, /\bimport\s*\(\s*["'`]\./, 'no lazy chunks to fetch at run time');
  const body = source.slice(source.indexOf('*/') + 2);
  assert.ok(body.split('\n').length < 20, 'minified');
  assert.ok(source.length < 100_000, `unexpectedly large: ${source.length} bytes`);
});

test('only the ad and purchase settings of app.config.json are compiled in', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'app.config.json'), 'utf8'));
  for (const id of [config.admob.ios.banner, config.admob.ios.interstitial, config.admob.ios.rewarded, config.iap.removeAdsProductId]) {
    assert.ok(source.includes(id), `${id} is in the bundle`);
  }
  assert.ok(!source.includes(config.trackingUsageDescription));
  assert.ok(!source.includes(JSON.stringify(config.webDir)));
});

test('install() on the real platform.js honours the contract', async () => {
  const web = await loadWebPlatform();
  assert.equal(await bridge.install(web.platform), undefined);
  assertContract(web.platform, web);
  assert.equal(web.platform.isNative, true);
  assert.equal(web.platform.os, 'ios');
  assert.equal(web.platform.ads.name, 'admob');

  await bridge.install(web.platform); // a second call is harmless
  assertContract(web.platform, web);
});

test('install() rejects something that is not a platform object', async () => {
  await assert.rejects(() => bridge.install(undefined), TypeError);
});

test('with every plugin missing, nothing throws, nothing rejects, and no ad is ever ready', async () => {
  const web = await loadWebPlatform();
  await bridge.install(web.platform);
  const { platform } = web;

  assert.deepEqual(await resultKinds(platform.ads, ADS_ARGS), await resultKinds(web.noAds, ADS_ARGS));
  assert.equal(platform.ads.enabled(), true);
  assert.equal(platform.ads.interstitialReady(), false);
  assert.equal(platform.ads.rewardedReady(), false);
  assert.equal(await platform.ads.showInterstitial(), false);
  assert.equal(await platform.ads.showRewarded(), false);

  assert.equal(await platform.iap.product(), null);
  assert.equal(await platform.iap.owned(), false);
  assert.equal(await platform.iap.purchase(), 'failed');
  assert.equal(await platform.iap.restore(), false);

  assert.equal(platform.haptic('success'), undefined);
  assert.equal(await platform.share({ text: 'hello', url: 'https://example.com' }), 'failed');
  assert.equal(platform.openExternal('https://example.com'), undefined);
  assert.equal(platform.appReady(), undefined);
  assert.equal(await platform.persist.get('save.v1'), null);
  assert.equal(await platform.persist.set('save.v1', '{}'), undefined);
  assert.equal(platform.onActiveChange(() => {}), undefined);

  await settle();
  await settle();
  assert.deepEqual(rejections.map(String), [], 'no unhandled promise rejection anywhere');
  assert.ok(
    warnings.some((line) => line.includes('[native-bridge]') && line.includes('not implemented on ios')),
    'the failures were reported, not swallowed silently',
  );
});
