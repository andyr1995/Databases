// Contract with the web game. Loads the game's real js/platform.js in Node, installs the
// bridge (from source, with fake plugins) and checks that nothing the game relies on went
// missing or changed type.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installBridge } from '../src/bridge/install.ts';
import { ADS_ARGS, appConfig, assertContract, loadWebPlatform, resultKinds, shapeOf } from './contract-helpers.js';
import { createFakeAdMob, createFakeClock, quiet, settle } from './helpers.js';

function fakePlugins(options = {}) {
  const prefs = new Map();
  return {
    admob: createFakeAdMob({ loads: 'manual', ...options.admob }),
    app: { addListener: async () => ({ remove: async () => {} }) },
    browser: { open: async () => {} },
    haptics: { impact: async () => {}, notification: async () => {} },
    preferences: {
      get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }),
      set: async ({ key, value }) => void prefs.set(key, value),
    },
    purchases: {
      getProduct: async () => ({ product: { priceString: '£2.99' } }),
      getPurchases: async () => ({ purchases: [] }),
      purchaseProduct: async () => ({ transactionId: '1', productIdentifier: appConfig.iap.removeAdsProductId }),
      restorePurchases: async () => {},
    },
    share: { share: async () => ({}) },
    splash: { hide: async () => {} },
  };
}

async function installed(options = {}) {
  const web = await loadWebPlatform();
  const before = shapeOf(web.platform);
  const plugins = fakePlugins(options);
  installBridge(web.platform, {
    os: options.os ?? 'ios',
    config: { admob: appConfig.admob, iap: appConfig.iap },
    plugins,
    legacyStorage: null,
    clock: createFakeClock(),
    log: quiet,
  });
  return { web, before, plugins, platform: web.platform };
}

test('after install() every member of platform, noAds and noIap is still there with the same type', async () => {
  const { web, before, platform } = await installed();
  assertContract(platform, web);
  assert.deepEqual(shapeOf(platform), before, 'no member added, removed or retyped on platform itself');
});

test('install() marks the platform as native iOS and swaps in the native providers', async () => {
  const { platform } = await installed();
  assert.equal(platform.isNative, true);
  assert.equal(platform.os, 'ios');
  assert.equal(platform.ads.name, 'admob');
  assert.equal(platform.ads.enabled(), true);
  assert.equal(platform.iap.available(), true);
});

test('install() itself calls no plugin', async () => {
  const { plugins } = await installed();
  assert.equal(plugins.admob.calls.length, 0);
});

test('the native ad provider returns the same kinds of values as the web one', async () => {
  const { web, platform } = await installed();
  const webKinds = await resultKinds(web.noAds, ADS_ARGS);
  const nativeKinds = await resultKinds(platform.ads, ADS_ARGS);
  assert.deepEqual(nativeKinds, webKinds);
  assert.deepEqual(nativeKinds, {
    init: 'Promise<undefined>',
    enabled: 'boolean',
    showBanner: 'Promise<undefined>',
    hideBanner: 'Promise<undefined>',
    onBannerHeight: 'undefined',
    interstitialReady: 'boolean',
    showInterstitial: 'Promise<boolean>',
    rewardedReady: 'boolean',
    showRewarded: 'Promise<boolean>',
    privacyOptionsRequired: 'boolean',
    showPrivacyOptions: 'Promise<undefined>',
  });
});

test('the native purchase provider returns the same kinds of values as the web one', async () => {
  const { web, platform, plugins } = await installed();
  plugins.purchases.getProduct = () => Promise.reject(new Error('Product not found'));
  const webKinds = await resultKinds(web.noIap);
  const nativeKinds = await resultKinds(platform.iap);
  assert.deepEqual(nativeKinds, webKinds);
  assert.deepEqual(nativeKinds, {
    available: 'boolean',
    product: 'Promise<null>',
    owned: 'Promise<boolean>',
    purchase: 'Promise<string>',
    restore: 'Promise<boolean>',
  });
});

test('the remaining platform members keep their documented results', async () => {
  const { web, platform } = await installed();
  // Members of the web version that can run under Node are compared directly ...
  assert.equal(platform.haptic('tap'), web.platform.haptic('tap'));
  assert.equal(platform.appReady(), web.platform.appReady());
  assert.equal(await platform.persist.get('contract.absent'), null);
  assert.equal(await platform.persist.set('contract.key', 'value'), undefined);
  assert.equal(await platform.persist.get('contract.key'), 'value');
  assert.ok(['shared', 'copied', 'cancelled', 'failed'].includes(await platform.share({ text: 'hello' })));
  // ... the two that need a DOM on the web are checked against the documentation.
  assert.equal(platform.openExternal('https://example.com/'), undefined);
  assert.equal(platform.onActiveChange(() => {}), undefined);
  await settle();
});

test('with ads ready the game-facing flow works end to end through platform.ads', async () => {
  const { platform, plugins } = await installed({ admob: { loads: 'auto' } });
  const heights = [];
  platform.ads.onBannerHeight((px) => heights.push(px));
  await platform.ads.init();
  assert.equal(platform.ads.interstitialReady(), true);
  assert.equal(platform.ads.rewardedReady(), true);

  const video = platform.ads.showRewarded();
  plugins.admob.earnReward();
  plugins.admob.dismiss('rewarded');
  assert.equal(await video, true);

  await platform.ads.showBanner();
  plugins.admob.bannerArrives(60);
  await platform.ads.hideBanner();
  assert.deepEqual(heights, [60, 0]);
});

test('an OS without ad units in app.config.json still gets an enabled provider that is never ready', async () => {
  const { web, platform, plugins } = await installed({ os: 'android' });
  assertContract(platform, web);
  assert.equal(platform.os, 'android');
  assert.equal(platform.ads.enabled(), true);
  await platform.ads.init();
  assert.equal(platform.ads.rewardedReady(), false);
  assert.equal(plugins.admob.calls.length, 0);
});
