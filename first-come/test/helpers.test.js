// The test doubles themselves. Every other test of the ad code leans on them, so the points
// on which they must not be wrong are pinned here: peek() must be able to say "settled", and
// the fake AdMob plugin must keep the state, and the call order, that the Swift source of
// @capacitor-community/admob 8.3.0 keeps (file and line numbers refer to that version).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeAdMob, createFakeClock, deferred, EVENTS, peek, settle, UNITS } from './helpers.js';

// --- peek ---------------------------------------------------------------------------------------

test('peek tells a settled promise from a pending one', async () => {
  assert.deepEqual(await peek(Promise.resolve(true)), { value: true });
  assert.deepEqual(await peek(Promise.resolve(false)), { value: false });
  assert.deepEqual(await peek(Promise.resolve(undefined)), { value: undefined });
  const boom = new Error('boom');
  assert.deepEqual(await peek(Promise.reject(boom)), { error: boom });
  assert.equal(await peek(new Promise(() => {})), 'pending');
});

test('peek sees a promise that settles a few promise callbacks from now', async () => {
  const chained = Promise.resolve()
    .then(() => {})
    .then(() => {})
    .then(() => 'late');
  assert.deepEqual(await peek(chained), { value: 'late' });

  const later = deferred();
  assert.equal(await peek(later.promise), 'pending');
  later.resolve(7);
  assert.deepEqual(await peek(later.promise), { value: 7 });
});

test('peek does not see a promise that only a timer will settle', async () => {
  const clock = createFakeClock();
  const timed = new Promise((resolve) => clock.setTimeout(() => resolve('done'), 1_000));
  assert.equal(await peek(timed), 'pending');
  await clock.advance(999);
  assert.equal(await peek(timed), 'pending');
  await clock.advance(1);
  assert.deepEqual(await peek(timed), { value: 'done' });
});

// --- the fake plugin: full-screen ads -------------------------------------------------------------

async function initialized(options) {
  const admob = createFakeAdMob(options);
  await admob.initialize();
  return admob;
}

test('fake: show is refused when nothing is prepared, and while an ad of that kind is up', async () => {
  const admob = await initialized();
  // AdInterstitialExecutor.swift:70 / AdRewardExecutor.swift:94
  await assert.rejects(admob.showInterstitial({ adId: UNITS.interstitial }), /Ad wasn't ready/);
  await assert.rejects(admob.showRewardVideoAd({ adId: UNITS.rewarded }), /Not Ready Yet/);
  assert.equal(admob.presentations('interstitial') + admob.presentations('rewarded'), 0);

  await admob.prepareInterstitial({ adId: UNITS.interstitial });
  await admob.showInterstitial({ adId: UNITS.interstitial });
  assert.equal(admob.adOnScreen('interstitial'), true);
  // AdInterstitialExecutor.swift:58-61
  await assert.rejects(admob.showInterstitial({ adId: UNITS.interstitial }), /already showing/);
  assert.equal(admob.presentations('interstitial'), 1);
});

test('fake: prepared ads are filed under the ad unit id, and closing an ad deletes what is filed there by then', async () => {
  const admob = await initialized();
  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  admob.showRewardVideoAd({ adId: UNITS.rewarded });
  assert.equal(admob.preparedCount('rewarded'), 1, 'the ad on screen keeps its entry');

  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded }); // AdRewardExecutor.swift:60 replaces the entry
  assert.equal(admob.preparedCount('rewarded'), 1);

  admob.dismiss('rewarded'); // AdRewardExecutor.swift:126-131
  assert.equal(admob.adOnScreen('rewarded'), false);
  assert.equal(admob.preparedCount('rewarded'), 0, 'the newer ad went with it');
  await assert.rejects(admob.showRewardVideoAd({ adId: UNITS.rewarded }), /Not Ready Yet/);

  admob.dismiss('rewarded'); // nothing is showing: the guard returns early
  assert.equal(admob.preparedCount('rewarded'), 0);
});

test('fake: the rewarded show call settles only with the reward', async () => {
  const admob = await initialized();
  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  const shown = admob.showRewardVideoAd({ adId: UNITS.rewarded });
  admob.dismiss('rewarded');
  assert.equal(await peek(shown), 'pending', 'closed early: the plugin never answers');

  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  const again = admob.showRewardVideoAd({ adId: UNITS.rewarded });
  admob.earnReward();
  assert.deepEqual(await peek(again), { value: { type: 'coins', amount: 1 } });
});

// --- the fake plugin: banner ----------------------------------------------------------------------

test('fake: before initialize() showBanner and resumeBanner never answer; removeBanner resolves and does nothing', async () => {
  const admob = createFakeAdMob();
  assert.equal(await peek(admob.showBanner({ adId: UNITS.banner })), 'pending');
  assert.equal(await peek(admob.resumeBanner()), 'pending');
  assert.deepEqual(await peek(admob.removeBanner()), { value: undefined }); // BannerExecutor.swift:110-113
  assert.equal(admob.native.banner, null);
});

test('fake: hideBanner acts one main-queue turn later than the other banner calls', async () => {
  const admob = await initialized();
  await admob.showBanner({ adId: UNITS.banner });
  admob.bannerArrives(60);
  assert.equal(admob.bannerOnScreen(), true);

  // AdMobPlugin.swift:377-378 + BannerExecutor.swift:70-71 (two hops) against
  // AdMobPlugin.swift:381-382 (one hop): sent together, the resume is applied first.
  admob.hideBanner();
  admob.resumeBanner();
  await settle();
  assert.equal(admob.bannerOnScreen(), false, 'the hazard the bridge has to avoid');

  // One after the other they are applied in the order they were made.
  await admob.resumeBanner();
  assert.equal(admob.bannerOnScreen(), true);
  await admob.hideBanner();
  await admob.resumeBanner();
  assert.equal(admob.bannerOnScreen(), true);
});

test('fake: resumeBanner rejects without a view on screen; removeBanner only finds one that is on screen', async () => {
  const admob = await initialized();
  await assert.rejects(admob.resumeBanner(), /not find subView/);

  await admob.showBanner({ adId: UNITS.banner }); // created, still loading
  await assert.rejects(admob.resumeBanner(), /not find subView/);
  await admob.removeBanner();
  assert.notEqual(admob.native.banner, null, 'a view that is not on screen yet is not found');

  admob.bannerArrives(60);
  await admob.hideBanner();
  await admob.removeBanner();
  assert.equal(admob.native.banner, null, 'a hidden view is found and removed');
});

test('fake: a page reload drops listeners and answers, and keeps what the plugin holds', async () => {
  const admob = await initialized({ loads: 'manual' });
  const heard = [];
  await admob.addListener(EVENTS.bannerSize, (size) => heard.push(size.height));
  await admob.showBanner({ adId: UNITS.banner });
  admob.bannerArrives(60);
  const load = admob.prepareInterstitial({ adId: UNITS.interstitial });
  const hide = admob.hideBanner();

  admob.reloadPage();
  admob.loadOk('interstitial');
  await settle();
  assert.equal(await peek(load), 'pending', 'the page that asked is gone');
  assert.equal(await peek(hide), 'pending');
  assert.equal(admob.listenerCount(EVENTS.bannerSize), 0);
  assert.deepEqual(heard, [60], 'no event reached the old page after the reload');

  assert.equal(admob.native.initialized, true);
  assert.notEqual(admob.native.banner, null, 'the banner view is still on the web view');
  assert.equal(admob.native.banner.hidden, true, 'and the hide under way was still applied');
  assert.equal(admob.preparedCount('interstitial'), 1, 'the ad the old page asked for was still filed');
});
