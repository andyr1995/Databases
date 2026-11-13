// The banner and onBannerHeight: the game is told the distance from the bottom of the
// screen to the top of the banner (banner height + home-indicator inset), and 0 whenever
// no banner is on screen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdsProvider } from '../src/bridge/ads.ts';
import { DEFAULT_BANNER_TUNING as B } from '../src/bridge/banner.ts';
import {
  createFakeAdMob,
  createFakeAppState,
  createFakeClock,
  createFakeViewport,
  createMemoryStore,
  EVENTS,
  quiet,
  settle,
  UNITS,
} from './helpers.js';

const INSET = 34; // iPhone home-indicator inset in portrait

function setup(options = {}) {
  const clock = createFakeClock();
  const admob = createFakeAdMob(options.admob);
  const app = createFakeAppState();
  const viewport = createFakeViewport({ safeAreaBottom: options.inset ?? INSET, width: 390 });
  const ads = createAdsProvider({
    admob,
    units: UNITS,
    testing: false,
    onActive: app.onActive,
    store: createMemoryStore(),
    viewport,
    clock,
    log: quiet,
  });
  const heights = [];
  ads.onBannerHeight((px) => heights.push(px));
  return { clock, admob, app, viewport, ads, heights };
}

async function started(options) {
  const ctx = setup(options);
  await ctx.ads.init();
  await settle();
  return ctx;
}

test('requests an adaptive banner anchored at the bottom, with the configured ad unit', async () => {
  const { ads, admob } = await started();
  assert.equal(await ads.showBanner(), undefined);
  assert.equal(admob.count('showBanner'), 1);
  assert.deepEqual(admob.last('showBanner').opts, {
    adId: UNITS.banner,
    adSize: 'ADAPTIVE_BANNER',
    position: 'BOTTOM_CENTER',
    margin: 0,
    npa: false,
  });
});

test('reports banner height plus the safe-area gap once the banner is on screen', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  assert.deepEqual(heights, [], 'nothing is on screen while the ad is loading');

  admob.bannerArrives(60);
  assert.deepEqual(heights, [60 + INSET]);
});

test('without a home indicator the height is the banner alone', async () => {
  const { ads, admob, heights } = await started({ inset: 0 });
  await ads.showBanner();
  admob.bannerArrives(50);
  assert.deepEqual(heights, [50]);
});

test('hide reports 0, show again resumes the same banner', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);

  assert.equal(await ads.hideBanner(), undefined);
  assert.equal(admob.count('hideBanner'), 1);
  assert.deepEqual(heights, [94, 0]);

  await ads.showBanner();
  await settle();
  assert.equal(admob.count('resumeBanner'), 1);
  assert.equal(admob.count('showBanner'), 1, 'the loaded banner is reused, not requested again');
  assert.deepEqual(heights, [94, 0, 94]);
});

test('repeated show / hide calls do not repeat plugin calls or callbacks', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  await ads.showBanner();
  admob.bannerArrives(60);
  await ads.showBanner();
  assert.equal(admob.count('showBanner'), 1);
  await ads.hideBanner();
  await ads.hideBanner();
  assert.equal(admob.count('hideBanner'), 1);
  assert.deepEqual(heights, [94, 0]);
});

test('a banner refresh with the same size does not call back again; a new size does', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  admob.bannerArrives(60);
  assert.deepEqual(heights, [94]);
  admob.bannerArrives(90);
  assert.deepEqual(heights, [94, 124]);
});

test('a load failure reports 0 and is retried with backoff', async () => {
  const { ads, admob, heights, clock } = await started();
  await ads.showBanner();
  admob.bannerFails();
  assert.deepEqual(heights, [], 'it never was on screen');

  await clock.advance(B.retryBaseMs - 1);
  assert.equal(admob.count('showBanner'), 1);
  await clock.advance(1);
  assert.equal(admob.count('showBanner'), 2);

  admob.bannerFails();
  await clock.advance(2 * B.retryBaseMs - 1);
  assert.equal(admob.count('showBanner'), 2);
  await clock.advance(1);
  assert.equal(admob.count('showBanner'), 3);

  admob.bannerArrives(60);
  assert.deepEqual(heights, [94]);
});

test('a refresh that fails takes the banner off screen: 0, then a new request', async () => {
  const { ads, admob, heights, clock } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  admob.bannerFails(); // the plugin removes the view
  assert.deepEqual(heights, [94, 0]);
  await clock.advance(B.retryBaseMs);
  assert.equal(admob.count('showBanner'), 2);
  admob.bannerArrives(60);
  assert.deepEqual(heights, [94, 0, 94]);
});

test('a banner that never answers is treated as failed', async () => {
  const { ads, admob, clock, heights } = await started();
  await ads.showBanner();
  await clock.advance(B.loadTimeoutMs + B.retryBaseMs);
  assert.equal(admob.count('showBanner'), 2);
  assert.deepEqual(heights, []);
});

test('hidden while still loading: the banner is hidden as soon as it arrives, height stays 0', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  await ads.hideBanner();
  assert.equal(admob.count('hideBanner'), 0, 'there is nothing to hide yet');

  admob.bannerArrives(60); // the plugin puts it on screen regardless
  assert.equal(admob.count('hideBanner'), 1);
  assert.deepEqual(heights, []);

  await ads.showBanner();
  await settle();
  assert.equal(admob.count('resumeBanner'), 1);
  assert.deepEqual(heights, [94]);
});

test('a failed load while the banner is not wanted is not retried', async () => {
  const { ads, admob, clock } = await started();
  await ads.showBanner();
  await ads.hideBanner();
  admob.bannerFails();
  await clock.advance(B.retryCapMs);
  assert.equal(admob.count('showBanner'), 1);
  await ads.showBanner();
  assert.equal(admob.count('showBanner'), 2);
});

test('resume fails because the native view is gone: a new banner is requested', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  await ads.hideBanner();

  admob.resumeFails = true;
  await ads.showBanner();
  await settle();
  assert.equal(admob.count('resumeBanner'), 1);
  assert.equal(admob.count('showBanner'), 2);
  assert.deepEqual(heights, [94, 0]);
  admob.bannerArrives(60);
  assert.deepEqual(heights, [94, 0, 94]);
});

test('showBanner before init() waits for the SDK', async () => {
  const { ads, admob, heights } = setup();
  await ads.showBanner();
  assert.equal(admob.calls.length, 0, 'the plugin would never answer before initialize()');
  await ads.init();
  assert.equal(admob.count('showBanner'), 1);
  const order = admob.sequence();
  assert.ok(order.indexOf('initialize') < order.indexOf('showBanner'));
  admob.bannerArrives(60);
  assert.deepEqual(heights, [94]);
});

test('hideBanner before anything was shown does nothing', async () => {
  const { ads, admob, heights } = await started();
  await ads.hideBanner();
  assert.equal(admob.count('hideBanner'), 0);
  assert.deepEqual(heights, []);
});

test('a size event while the banner is hidden does not report a height', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  await ads.hideBanner();
  admob.bannerArrives(60); // a refresh that was already under way
  assert.deepEqual(heights, [94, 0]);
});

test('the safe-area inset changing (rotation) updates the reported height', async () => {
  const { ads, admob, heights, viewport } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  viewport.change({ inset: 21 });
  assert.deepEqual(heights, [94, 81]);
});

test('a width change rebuilds the adaptive banner for the new width', async () => {
  const { ads, admob, heights, viewport, clock } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);

  viewport.change({ w: 844, inset: 21 });
  assert.deepEqual(heights, [94, 81]);
  await clock.advance(B.relayoutDelayMs);
  assert.equal(admob.count('removeBanner'), 1);
  assert.equal(admob.count('showBanner'), 2);
  assert.deepEqual(heights, [94, 81, 0], 'removed: no banner on screen until the new one loads');

  admob.bannerArrives(50);
  assert.deepEqual(heights, [94, 81, 0, 71]);
});

test('a late listener is told the current height; a replaced listener is not called again', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.bannerArrives(60);
  const late = [];
  ads.onBannerHeight((px) => late.push(px));
  assert.deepEqual(late, [94]);
  await ads.hideBanner();
  assert.deepEqual(late, [94, 0]);
  assert.deepEqual(heights, [94]);
});

test('a throwing height listener does not break the banner', async () => {
  const { ads, admob } = await started();
  ads.onBannerHeight(() => {
    throw new Error('layout bug in the game');
  });
  await ads.showBanner();
  admob.bannerArrives(60);
  await ads.hideBanner();
  assert.equal(admob.count('hideBanner'), 1);
});

test('coming back to the foreground retries a banner that failed', async () => {
  const { ads, admob, app } = await started();
  await ads.showBanner();
  admob.bannerFails();
  app.fire(true);
  assert.equal(admob.count('showBanner'), 2);
});

test('malformed size events are ignored', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  admob.emit(EVENTS.bannerSize, undefined);
  admob.emit(EVENTS.bannerSize, { width: 390 });
  admob.emit(EVENTS.bannerSize, { width: 390, height: 'tall' });
  assert.deepEqual(heights, []);
});
