// Interstitial and rewarded video: readiness, reloading, backoff, and above all that
// show*() always settles and a reward is only ever reported when it was earned.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdsProvider } from '../src/bridge/ads.ts';
import { DEFAULT_FULLSCREEN_TUNING as T } from '../src/bridge/fullscreen.ts';
import {
  createFakeAdMob,
  createFakeAppState,
  createFakeClock,
  createMemoryStore,
  EVENTS,
  peek,
  quiet,
  settle,
  UNITS,
} from './helpers.js';

/** How long an ad of this kind may stay on screen before the game is released anyway. */
const capOf = (kind) => (kind === 'rewarded' ? T.maxRewardedShowMs : T.maxShowMs);

/** `options.plugin`: an existing fake plugin, to model a page that was loaded again. */
function setup(options = {}) {
  const clock = createFakeClock();
  const admob = options.plugin ?? createFakeAdMob(options.admob);
  const app = createFakeAppState();
  const ads = createAdsProvider({
    admob,
    units: UNITS,
    testing: false,
    onActive: app.onActive,
    store: createMemoryStore(),
    clock,
    log: quiet,
  });
  return { clock, admob, app, ads };
}

async function started(options) {
  const ctx = setup(options);
  await ctx.ads.init();
  await settle();
  return ctx;
}

// --- reward only when earned ---------------------------------------------------------------

test('rewarded: closing the video early resolves false', async () => {
  const { ads, admob, clock } = await started();
  const shown = ads.showRewarded();
  assert.equal(await peek(shown), 'pending');

  admob.dismiss('rewarded'); // Dismissed alone must never grant the reward
  await clock.advance(T.rewardGraceMs);
  assert.equal(await shown, false);
});

test('rewarded: reward earned, then dismissed, resolves true (and only at dismissal)', async () => {
  const { ads, admob } = await started();
  const shown = ads.showRewarded();

  admob.earnReward();
  assert.equal(await peek(shown), 'pending', 'the game continues after the ad is closed, not before');

  admob.dismiss('rewarded');
  assert.equal(await shown, true);
});

test('rewarded: the Rewarded event alone is enough', async () => {
  const { ads, admob } = await started();
  const shown = ads.showRewarded();
  admob.earnReward({ event: true, result: false });
  admob.dismiss('rewarded');
  assert.equal(await shown, true);
});

test('rewarded: the reward item returned by the plugin alone is enough', async () => {
  const { ads, admob } = await started();
  const shown = ads.showRewarded();
  admob.earnReward({ event: false, result: true });
  await settle();
  admob.dismiss('rewarded');
  assert.equal(await shown, true);
});

test('rewarded: a reward reported just after the dismissal still counts', async () => {
  const { ads, admob, clock } = await started();
  const shown = ads.showRewarded();
  admob.dismiss('rewarded');
  await clock.advance(T.rewardGraceMs / 2);
  assert.equal(await peek(shown), 'pending');
  admob.earnReward();
  assert.equal(await shown, true);
});

test('rewarded: a stray reward after a showing has ended is not carried into the next one', async () => {
  const { ads, admob, clock } = await started();

  const first = ads.showRewarded();
  admob.dismiss('rewarded');
  await clock.advance(T.rewardGraceMs);
  assert.equal(await first, false);

  admob.earnReward(); // arrives when no ad is on screen
  await settle();
  assert.equal(ads.rewardedReady(), true, 'the next video was loaded after the dismissal');

  const second = ads.showRewarded();
  admob.dismiss('rewarded');
  await clock.advance(T.rewardGraceMs);
  assert.equal(await second, false);
});

test('rewarded: one showing yields one result, whatever arrives afterwards', async () => {
  const { ads, admob, clock } = await started();
  const results = [];
  const shown = ads.showRewarded().then((earned) => results.push(earned));
  admob.earnReward();
  admob.dismiss('rewarded');
  await shown;

  admob.earnReward();
  admob.dismiss('rewarded');
  admob.failToShow('rewarded');
  await clock.advance(T.maxRewardedShowMs);
  assert.deepEqual(results, [true]);
  assert.equal(ads.rewardedReady(), true, 'duplicate events do not disturb the slot');
  assert.equal(admob.preparedCount('rewarded'), 1, 'and the ad it stands for exists');
});

test('interstitial: resolves true on dismissal, not when the plugin promise resolves', async () => {
  const { ads, admob } = await started();
  const shown = ads.showInterstitial();
  // the fake, like the plugin, has already resolved showInterstitial() and emitted Showed
  assert.equal(await peek(shown), 'pending');
  admob.dismiss('interstitial');
  assert.equal(await shown, true);
});

// --- show promises always settle -----------------------------------------------------------

test('show resolves false at once when nothing is ready', async () => {
  const idle = setup(); // init() never called
  assert.equal(await idle.ads.showInterstitial(), false);
  assert.equal(await idle.ads.showRewarded(), false);
  assert.equal(idle.admob.count('showInterstitial') + idle.admob.count('showRewardVideoAd'), 0);

  const loading = await started({ admob: { loads: 'manual' } }); // loads still under way
  assert.equal(await loading.ads.showInterstitial(), false);
  assert.equal(await loading.ads.showRewarded(), false);
  assert.equal(loading.admob.count('showInterstitial') + loading.admob.count('showRewardVideoAd'), 0);
});

for (const [kind, show] of [
  ['interstitial', (ads) => ads.showInterstitial()],
  ['rewarded', (ads) => ads.showRewarded()],
]) {
  test(`${kind}: a presentation that fails resolves false`, async () => {
    const { ads, admob } = await started({ admob: { showMode: 'fail' } });
    assert.equal(await show(ads), false);
    assert.equal(admob.count(kind === 'rewarded' ? 'prepareRewardVideoAd' : 'prepareInterstitial'), 2, 'and the next ad is requested');
  });

  test(`${kind}: FailedToShow resolves false even after a Showed event`, async () => {
    const { ads, admob } = await started();
    const shown = show(ads);
    admob.failToShow(kind);
    assert.equal(await shown, false);
  });

  test(`${kind}: a rejected show call resolves false`, async () => {
    const { ads } = await started({ admob: { showMode: 'reject' } });
    assert.equal(await show(ads), false);
  });

  test(`${kind}: a show call that throws resolves false`, async () => {
    const { ads, admob } = await started();
    const boom = () => {
      throw new Error('bridge is gone');
    };
    admob.showInterstitial = boom;
    admob.showRewardVideoAd = boom;
    assert.equal(await show(ads), false);
  });

  test(`${kind}: a native side that never answers is given up on after the present timeout`, async () => {
    const { ads, clock } = await started({ admob: { showMode: 'silent' } });
    const shown = show(ads);
    await clock.advance(T.presentTimeoutMs - 1);
    assert.equal(await peek(shown), 'pending');
    await clock.advance(1);
    assert.equal(await shown, false);
  });

  test(`${kind}: an ad that never reports its dismissal releases the game after the cap`, async () => {
    const { ads, admob, clock } = await started();
    const shown = show(ads);
    if (kind === 'rewarded') admob.earnReward({ event: true, result: false });
    await clock.advance(capOf(kind) - 2 * T.heartbeatMs);
    assert.equal(await peek(shown), 'pending');
    await clock.advance(2 * T.heartbeatMs);
    assert.equal(await shown, true, 'it was on screen (and for rewarded: the reward had been earned)');
  });

  // The plugin files prepared ads under the ad unit id. When the ad that was on screen is
  // finally closed, it deletes whatever is filed there by then.
  test(`${kind}: an ad still up after the cap takes the next ad with it when it closes; another is loaded`, async () => {
    const { ads, admob, clock } = await started();
    const first = show(ads);
    await clock.advance(capOf(kind));
    assert.equal(await first, kind === 'interstitial', 'released by the watchdog');
    assert.equal(admob.adOnScreen(kind), true, 'natively the ad is still up');
    assert.equal(kind === 'rewarded' ? ads.rewardedReady() : ads.interstitialReady(), true, 'the next ad was loaded meanwhile');

    admob.dismiss(kind); // the player closes it at last: the plugin deletes the ad loaded since
    await settle();
    assert.equal(admob.preparedCount(kind), 1, 'the bridge noticed and loaded another');
    assert.equal(kind === 'rewarded' ? ads.rewardedReady() : ads.interstitialReady(), true);

    const second = show(ads);
    assert.equal(admob.presentations(kind), 2, 'which the plugin really presents');
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await second, true);
  });

  test(`${kind}: a load still under way when that old ad closes is kept, not repeated`, async () => {
    const { ads, admob, clock } = await started({ admob: { loads: 'manual' } });
    const prepare = kind === 'rewarded' ? 'prepareRewardVideoAd' : 'prepareInterstitial';
    admob.loadOk('interstitial');
    admob.loadOk('rewarded');
    await settle();

    const first = show(ads);
    await clock.advance(capOf(kind));
    await first;
    assert.equal(admob.count(prepare), 2, 'the next load started when the game was released');

    admob.dismiss(kind); // deletes the OLD entry; the new ad is filed when its load completes
    await settle();
    assert.equal(admob.count(prepare), 2);
    admob.loadOk(kind);
    await settle();
    assert.equal(admob.preparedCount(kind), 1);

    const second = show(ads);
    assert.equal(admob.presentations(kind), 2);
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await second, true);
  });

  test(`${kind}: an ad the previous page left on screen does not leave the new page with a dead ad`, async () => {
    const before = await started();
    show(before.ads); // on screen when iOS discards the web content process
    before.admob.reloadPage();

    const { ads, admob } = await started({ plugin: before.admob });
    assert.equal(admob.adOnScreen(kind), true);
    assert.equal(await show(ads), false, 'the plugin refuses a second ad on top of it');
    await settle();

    admob.dismiss(kind); // also deletes the ad this page has prepared since
    await settle();
    assert.equal(admob.preparedCount(kind), 1);

    const shown = show(ads);
    assert.equal(admob.presentations(kind), 2);
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await shown, true);
  });

  test(`${kind}: only one full-screen ad at a time`, async () => {
    const { ads, admob } = await started();
    const shown = show(ads);
    assert.equal(await ads.showInterstitial(), false);
    assert.equal(await ads.showRewarded(), false);
    assert.equal(admob.count('showInterstitial') + admob.count('showRewardVideoAd'), 1);
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await shown, true);
  });
}

test('rewarded: a long video is not released at the interstitial cap, and its reward still counts', async () => {
  const { ads, admob, clock } = await started();
  const shown = ads.showRewarded();
  await clock.advance(T.maxShowMs + 60_000);
  assert.equal(await peek(shown), 'pending');
  admob.earnReward();
  admob.dismiss('rewarded');
  assert.equal(await shown, true);
});

test('a Loaded event while an ad is on screen does not make the slot ready', async () => {
  const { ads, admob } = await started({ admob: { loads: 'manual' } });
  admob.loadOk('interstitial');
  admob.loadOk('rewarded');
  await settle();

  const shown = ads.showInterstitial();
  // A load that was given up on long ago comes in now. The plugin files it under the ad
  // unit, and deletes it again when the ad on screen is closed.
  admob.emit(EVENTS.interstitialLoaded, { adUnitId: UNITS.interstitial });
  assert.equal(ads.interstitialReady(), false);
  assert.equal(await ads.showRewarded(), false, 'the interstitial is still up');
  assert.equal(admob.count('showRewardVideoAd'), 0);

  admob.dismiss('interstitial');
  assert.equal(await shown, true);
  assert.equal(ads.interstitialReady(), false);
  assert.equal(admob.count('prepareInterstitial'), 2, 'the next ad is requested as after any showing');
});

test('time the app spent suspended does not count towards the on-screen cap', async () => {
  const { ads, admob, clock } = await started();
  const shown = ads.showInterstitial();
  await clock.advance(5_000);
  clock.jump(60 * 60_000); // the player followed the ad to the App Store for an hour
  await clock.advance(5_000);
  assert.equal(await peek(shown), 'pending', 'still waiting for the real dismissal');
  admob.dismiss('interstitial');
  assert.equal(await shown, true);
});

test('a suspension while waiting for the ad to appear does not use up the present timeout', async () => {
  const { ads, clock } = await started({ admob: { showMode: 'silent' } });
  const shown = ads.showRewarded();
  await clock.advance(4_000);
  clock.jump(60 * 60_000); // every timer comes due at once when the app resumes
  await clock.advance(2_000);
  assert.equal(await peek(shown), 'pending', 'events queued during the suspension still get their chance');
  await clock.advance(T.presentTimeoutMs);
  assert.equal(await shown, false);
});

// --- ready flags, reload after dismissal ---------------------------------------------------

test('nothing is ready, and nothing is requested, before init()', async () => {
  const { ads, admob } = setup();
  assert.equal(ads.enabled(), true, 'native never falls back to free rewards');
  assert.equal(ads.interstitialReady(), false);
  assert.equal(ads.rewardedReady(), false);
  assert.equal(admob.calls.length, 0);
});

test('ready flags follow the load results', async () => {
  const { ads, admob } = await started({ admob: { loads: 'manual' } });
  assert.equal(admob.count('prepareInterstitial'), 1);
  assert.equal(admob.count('prepareRewardVideoAd'), 1);
  assert.equal(admob.last('prepareInterstitial').opts.adId, UNITS.interstitial);
  assert.equal(admob.last('prepareRewardVideoAd').opts.adId, UNITS.rewarded);
  assert.equal(admob.last('prepareInterstitial').opts.isTesting, undefined, 'the plugin would swap in its own ids');
  assert.equal(ads.interstitialReady(), false);
  assert.equal(ads.rewardedReady(), false);

  admob.loadOk('interstitial');
  await settle();
  assert.equal(ads.interstitialReady(), true);
  assert.equal(ads.rewardedReady(), false);

  admob.loadOk('rewarded');
  await settle();
  assert.equal(ads.rewardedReady(), true);
});

test('a Loaded event for some other ad unit is ignored', async () => {
  const { ads, admob } = await started({ admob: { loads: 'manual' } });
  admob.emit(EVENTS.interstitialLoaded, { adUnitId: 'ca-app-pub-0000000000000000/1' });
  assert.equal(ads.interstitialReady(), false);
});

test('after a dismissal the next ad is loaded', async () => {
  const { ads, admob } = await started({ admob: { loads: 'manual' } });
  admob.loadOk('interstitial');
  admob.loadOk('rewarded');
  await settle();

  const shown = ads.showInterstitial();
  assert.equal(admob.last('showInterstitial').opts.adId, UNITS.interstitial);
  assert.equal(ads.interstitialReady(), false, 'not ready while it is on screen');
  assert.equal(admob.count('prepareInterstitial'), 1, 'no reload while it is on screen');

  admob.dismiss('interstitial');
  assert.equal(await shown, true);
  assert.equal(admob.count('prepareInterstitial'), 2);
  assert.equal(ads.interstitialReady(), false);
  admob.loadOk('interstitial');
  await settle();
  assert.equal(ads.interstitialReady(), true);

  const video = ads.showRewarded();
  assert.equal(ads.rewardedReady(), false);
  admob.earnReward();
  admob.dismiss('rewarded');
  assert.equal(await video, true);
  assert.equal(admob.count('prepareRewardVideoAd'), 2);
  admob.loadOk('rewarded');
  await settle();
  assert.equal(ads.rewardedReady(), true);
});

test('an ad that has been waiting too long is replaced instead of shown', async () => {
  const { ads, admob, clock } = await started();
  assert.equal(ads.interstitialReady(), true);
  await clock.advance(T.maxAdAgeMs);
  assert.equal(admob.count('prepareInterstitial'), 1);
  assert.equal(ads.interstitialReady(), false, 'too old to show');
  assert.equal(admob.count('prepareInterstitial'), 2, 'a replacement was requested');
  assert.equal(ads.interstitialReady(), true, 'and the replacement is ready');
});

test('a stale ad is also replaced when the app comes back to the foreground', async () => {
  const { ads, admob, clock, app } = await started();
  await clock.advance(T.maxAdAgeMs);
  app.fire(true);
  assert.equal(admob.count('prepareInterstitial'), 2);
  assert.equal(admob.count('prepareRewardVideoAd'), 2);
  assert.equal(ads.rewardedReady(), true);
});

// --- backoff ----------------------------------------------------------------------------------

test('failed loads are retried with a doubling, capped delay', async () => {
  const { admob, clock, ads } = await started({ admob: { loads: 'manual' } });
  admob.loadOk('rewarded');
  const expected = [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000];
  let attempts = 1;
  for (const delay of expected) {
    admob.loadFail('interstitial');
    await settle();
    assert.equal(admob.count('prepareInterstitial'), attempts, 'no retry straight from the failure');
    await clock.advance(delay - 1);
    assert.equal(admob.count('prepareInterstitial'), attempts, `no retry before ${delay} ms`);
    await clock.advance(1);
    attempts++;
    assert.equal(admob.count('prepareInterstitial'), attempts, `retry after ${delay} ms`);
  }
  assert.equal(ads.interstitialReady(), false);
  assert.equal(admob.count('prepareRewardVideoAd'), 1, 'the other slot is unaffected');
});

test('a successful load resets the backoff', async () => {
  const { admob, clock, ads } = await started({ admob: { loads: 'manual' } });
  admob.loadFail('rewarded');
  await clock.advance(4_000);
  admob.loadFail('rewarded');
  await clock.advance(8_000);
  admob.loadOk('rewarded');
  await settle();
  assert.equal(ads.rewardedReady(), true);

  const shown = ads.showRewarded();
  admob.dismiss('rewarded');
  await clock.advance(T.rewardGraceMs);
  await shown;
  assert.equal(admob.count('prepareRewardVideoAd'), 4);
  admob.loadFail('rewarded');
  await clock.advance(3_999);
  assert.equal(admob.count('prepareRewardVideoAd'), 4);
  await clock.advance(1);
  assert.equal(admob.count('prepareRewardVideoAd'), 5, 'back to the first delay');
});

test('coming back to the foreground retries at once', async () => {
  const { admob, clock, app, ads } = await started({ admob: { loads: 'manual' } });
  admob.loadFail('interstitial');
  admob.loadFail('rewarded');
  await clock.advance(4_000);
  admob.loadFail('interstitial');
  admob.loadFail('rewarded');
  await settle();
  assert.equal(admob.count('prepareInterstitial'), 2);

  app.fire(false);
  assert.equal(admob.count('prepareInterstitial'), 2, 'going to the background does nothing');
  app.fire(true);
  assert.equal(admob.count('prepareInterstitial'), 3);
  assert.equal(admob.count('prepareRewardVideoAd'), 3);

  await clock.advance(8_000); // the timer that was replaced must not fire a second load
  assert.equal(admob.count('prepareInterstitial'), 3);
  admob.loadOk('interstitial');
  await settle();
  assert.equal(ads.interstitialReady(), true);
});

test('a load that never answers counts as a failure', async () => {
  const { admob, clock } = await started({ admob: { loads: 'manual' } });
  await clock.advance(T.loadTimeoutMs);
  assert.equal(admob.count('prepareInterstitial'), 1);
  await clock.advance(4_000);
  assert.equal(admob.count('prepareInterstitial'), 2);
});
