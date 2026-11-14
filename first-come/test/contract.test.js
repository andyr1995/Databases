// Contract with the web game. Loads the game's real js/platform.js in Node, installs the
// bridge (from source, with fake plugins) and checks that nothing the game relies on went
// missing or changed type.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installBridge } from '../src/bridge/install.ts';
import { ADS_ARGS, appConfig, assertContract, loadWebPlatform, resultKinds, shapeOf } from './contract-helpers.js';
import { createFakeAndroidAdMob, createFakeAndroidApp, createFakePlayPurchases, flush } from './helpers-android.js';
import { createFakeAdMob, createFakeClock, peek, quiet, settle } from './helpers.js';

function fakePlugins(options = {}) {
  const prefs = new Map();
  return {
    admob: createFakeAdMob({ loads: 'manual', ...options.admob }),
    app: { addListener: async () => ({ remove: async () => {} }), minimizeApp: async () => {} },
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

/** The same set as the plugins' Android sources behave. */
function androidPlugins(options = {}) {
  return {
    ...fakePlugins(options),
    admob: createFakeAndroidAdMob(options.admob),
    app: createFakeAndroidApp(),
    purchases: createFakePlayPurchases(),
  };
}

async function installed(options = {}) {
  const web = await loadWebPlatform();
  const before = shapeOf(web.platform);
  const plugins = options.os === 'android' ? androidPlugins(options) : fakePlugins(options);
  const clock = createFakeClock();
  installBridge(web.platform, {
    os: options.os ?? 'ios',
    config: { admob: appConfig.admob, iap: appConfig.iap },
    plugins,
    legacyStorage: null,
    clock,
    log: quiet,
  });
  return { web, before, plugins, clock, platform: web.platform };
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
  assert.equal(platform.onBack(() => true), web.platform.onBack(() => true));
  await settle();
});

test('onBack is part of the contract, and on iPhone it stays as inert as the web version', async () => {
  const { web, platform, plugins } = await installed();
  assert.equal(typeof web.platform.onBack, 'function', 'js/platform.js declares it');
  const calls = [];
  plugins.app.addListener = async (event) => (calls.push(event), { remove: async () => {} });
  assert.equal(platform.onBack(() => assert.fail('never called on iPhone')), undefined);
  await settle();
  assert.deepEqual(calls, []);
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
  const web = await loadWebPlatform();
  const plugins = androidPlugins();
  installBridge(web.platform, {
    os: 'android',
    config: { admob: { testing: appConfig.admob.testing, ios: appConfig.admob.ios }, iap: appConfig.iap },
    plugins,
    legacyStorage: null,
    clock: createFakeClock(),
    log: quiet,
  });
  const { platform } = web;
  assertContract(platform, web);
  assert.equal(platform.os, 'android');
  assert.equal(platform.ads.enabled(), true);
  await platform.ads.init();
  assert.equal(platform.ads.rewardedReady(), false);
  assert.equal(await platform.ads.showRewarded(), false);
  assert.equal(plugins.admob.calls.length, 0);
});

// --- Android ---------------------------------------------------------------------------------------

test('android: install() honours the same contract and marks the platform as native Android', async () => {
  const { web, before, platform, plugins } = await installed({ os: 'android' });
  assertContract(platform, web);
  assert.deepEqual(shapeOf(platform), before, 'no member added, removed or retyped on platform itself');
  assert.equal(platform.isNative, true);
  assert.equal(platform.os, 'android');
  assert.equal(platform.ads.name, 'admob');
  assert.equal(platform.ads.enabled(), true);
  assert.equal(platform.iap.available(), true);
  assert.equal(plugins.admob.calls.length, 0, 'nothing is asked of the ad plugin before the game calls init()');
  assert.equal(plugins.purchases.calls.length, 0);
});

test('android: Back leaves the app from the moment the bridge is installed, before the game has registered anything', async () => {
  // The state the game is in on its "Something went wrong starting the game" screen.
  const { plugins } = await installed({ os: 'android' });
  await settle();
  assert.equal(plugins.app.listenerCount('backButton'), 1);
  plugins.app.pressBack();
  await settle();
  assert.equal(plugins.app.minimized, 1);
});

test('android: both providers return the same kinds of values as the web ones', async () => {
  const { web, platform, plugins } = await installed({ os: 'android' });
  assert.deepEqual(await resultKinds(platform.ads, ADS_ARGS), await resultKinds(web.noAds, ADS_ARGS));
  plugins.purchases.play.catalog.clear();
  assert.deepEqual(await resultKinds(platform.iap), await resultKinds(web.noIap));
});

test('android: the game-facing flow works end to end: adverts, banner, purchase, Back', async () => {
  const { platform, plugins, clock } = await installed({ os: 'android' });
  const heights = [];
  platform.ads.onBannerHeight((px) => heights.push(px));
  let onHome = false;
  platform.onBack(() => !onHome);

  await platform.ads.init();
  await clock.advance(1_000);
  assert.equal(plugins.admob.last('prepareRewardVideoAd').opts.adId, appConfig.admob.android.rewarded);
  assert.equal(platform.ads.interstitialReady(), true);
  assert.equal(platform.ads.rewardedReady(), true);

  const video = platform.ads.showRewarded();
  await flush();
  plugins.app.paused(); // the ad covers the game
  plugins.admob.earnReward();
  plugins.admob.dismiss('rewarded');
  plugins.app.resumed();
  assert.equal(await video, true);

  // An ad that Android takes away without a word ends once the game is in front again.
  const lost = platform.ads.showInterstitial();
  await flush();
  plugins.app.paused();
  plugins.admob.adActivityDestroyed('interstitial');
  plugins.app.resumed();
  await clock.advance(5_000);
  assert.deepEqual(await peek(lost), { value: true });

  await platform.ads.showBanner();
  await flush();
  assert.equal(plugins.admob.last('showBanner').opts.adId, appConfig.admob.android.banner);
  plugins.admob.bannerArrives();
  await platform.ads.hideBanner();
  assert.deepEqual(heights, [60, 0]);
  // On Android the answer to resumeBanner proves nothing: without a view there is no banner.
  await flush();
  plugins.admob.native.adView = null;
  await platform.ads.showBanner();
  await flush();
  assert.deepEqual(heights, [60, 0]);
  await clock.advance(5_000);
  assert.equal(plugins.admob.count('showBanner'), 2, 'a new one is requested instead');

  assert.deepEqual(await platform.iap.product(), { price: '£2.99' });
  assert.equal(await platform.iap.purchase(), 'purchased');
  assert.deepEqual(plugins.purchases.calls.find((c) => c.name === 'purchaseProduct').opts, {
    productIdentifier: appConfig.iap.removeAdsProductId,
    productType: 'inapp',
    isConsumable: false,
    autoAcknowledgePurchases: true,
  });
  assert.equal(await platform.iap.owned(), true);
  assert.equal(plugins.purchases.play.purchases[0].acknowledged, true);

  plugins.app.pressBack(); // in a level: the game goes Home
  await settle();
  assert.equal(plugins.app.minimized, 0);
  onHome = true;
  plugins.app.pressBack(); // on Home: out of the app
  await settle();
  assert.equal(plugins.app.minimized, 1);
  assert.equal(plugins.admob.native.crashed, null);
});
