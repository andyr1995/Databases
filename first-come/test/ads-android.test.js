// platform.ads on Android: the same provider as on iPhone, against a fake that behaves as the
// Android source of the AdMob plugin does (see helpers-android.js). Only what differs from
// iOS is tested here; the shared logic is covered by the three other ads-*.test.js files.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdsProvider, DEFAULT_ADS_TUNING } from '../src/bridge/ads.ts';
import { createActivityWatch } from '../src/bridge/app-state.ts';
import { DEFAULT_BANNER_TUNING as B } from '../src/bridge/banner.ts';
import { GOOGLE_ANDROID_DEMO_UNITS } from '../src/bridge/config.ts';
import { DEFAULT_FULLSCREEN_TUNING as T } from '../src/bridge/fullscreen.ts';
import { createFakeAndroidAdMob, createFakeAndroidApp, flush } from './helpers-android.js';
import { createFakeAppState, createFakeClock, createFakeViewport, createMemoryStore, peek, quiet, settle } from './helpers.js';

const UNITS = GOOGLE_ANDROID_DEMO_UNITS;
/** Navigation-bar inset of an edge-to-edge web view with gesture navigation, in CSS px. */
const INSET = 24;

/** `options.plugin`: an existing fake plugin, to model a page that was loaded again. */
function setup(options = {}) {
  const clock = createFakeClock();
  const admob = options.plugin ?? createFakeAndroidAdMob(options.admob);
  const state = createFakeAppState();
  const app = createFakeAndroidApp();
  const viewport = createFakeViewport({ safeAreaBottom: options.inset ?? INSET, width: 390 });
  const ads = createAdsProvider({
    admob,
    os: 'android',
    units: UNITS,
    testing: options.testing ?? false,
    onActive: state.onActive,
    onActivity: createActivityWatch(app, 'android', quiet),
    store: createMemoryStore(),
    viewport,
    clock,
    log: quiet,
  });
  const heights = [];
  ads.onBannerHeight((px) => heights.push(px));
  return { clock, admob, state, app, viewport, ads, heights };
}

async function started(options) {
  const ctx = setup(options);
  await ctx.ads.init();
  // The UI thread loads the two ads, and the removeBanner that opened the start-up (which
  // found nothing to remove on a cold start) is no longer waited for.
  await ctx.clock.advance(B.removeSettleMs);
  return ctx;
}

const show = { interstitial: (ads) => ads.showInterstitial(), rewarded: (ads) => ads.showRewarded() };

// --- start-up ----------------------------------------------------------------------------------

test('android: the start-up order is the same, and there is no tracking prompt to show', async () => {
  const { ads, admob } = await started({
    admob: { consent: { status: 'REQUIRED', isConsentFormAvailable: true, canRequestAds: false, privacyOptionsRequirementStatus: 'REQUIRED' } },
  });
  assert.deepEqual(admob.sequence(), [
    'removeBanner',
    'requestConsentInfo',
    'showConsentForm',
    'trackingAuthorizationStatus', // always 'authorized' on Android
    'initialize',
    'prepareInterstitial',
    'prepareRewardVideoAd',
  ]);
  assert.equal(admob.count('requestTrackingAuthorization'), 0);
  assert.equal(ads.interstitialReady(), true);
  assert.equal(ads.rewardedReady(), true);
  assert.equal(ads.privacyOptionsRequired(), true);
});

test('android: the configured ad units are requested as they are; isTesting is never sent', async () => {
  const { ads, admob } = await started();
  await ads.showBanner();
  await flush();
  for (const [call, unit] of [
    ['prepareInterstitial', UNITS.interstitial],
    ['prepareRewardVideoAd', UNITS.rewarded],
    ['showBanner', UNITS.banner],
  ]) {
    assert.equal(admob.last(call).opts.adId, unit, call);
    assert.equal(admob.last(call).opts.isTesting, undefined, `${call}: the plugin would swap in its own ids`);
  }
  assert.deepEqual(admob.last('showBanner').opts, {
    adId: UNITS.banner,
    adSize: 'ADAPTIVE_BANNER',
    position: 'BOTTOM_CENTER',
    margin: 0,
    npa: false,
  });
});

test('android: initialize() rejecting because the banner parent never appeared keeps ads off, and is retried', async () => {
  const { ads, admob, clock } = setup();
  admob.bannerParentMissing = true;
  await ads.init();
  await flush();
  assert.equal(admob.count('prepareInterstitial'), 0);
  assert.equal(ads.rewardedReady(), false);

  admob.bannerParentMissing = false;
  await clock.advance(DEFAULT_ADS_TUNING.startRetryBaseMs);
  await flush();
  assert.equal(admob.count('initialize'), 2);
  assert.equal(ads.rewardedReady(), true);
});

test('android: init() resolves, and never rejects, when every plugin call fails', async () => {
  const { ads, admob } = setup();
  for (const name of Object.keys(admob)) {
    if (typeof admob[name] === 'function' && /^(add|request|show|tracking|initialize|prepare|hide|resume|remove)/.test(name)) {
      admob[name] = () => Promise.reject(new Error(`${name} is not implemented on android`));
    }
  }
  assert.equal(await ads.init(), undefined);
  assert.equal(await ads.showInterstitial(), false);
  assert.equal(await ads.showRewarded(), false);
  await ads.showBanner();
  await ads.hideBanner();
  await ads.showPrivacyOptions();
});

// --- interstitial and rewarded -------------------------------------------------------------------

test('android: a load is answered before its Loaded event; the ad is ready once and requested once', async () => {
  const { ads, admob } = await started({ admob: { loads: 'manual' } });
  assert.equal(ads.interstitialReady(), false);
  admob.loadOk('interstitial'); // resolve first, then the event
  await flush();
  assert.equal(ads.interstitialReady(), true);
  assert.equal(admob.count('prepareInterstitial'), 1);
  assert.equal(admob.preparedCount('interstitial'), 1);
});

test('android interstitial: resolves true on dismissal, not when the plugin call resolves', async () => {
  const { ads, admob } = await started();
  const shown = ads.showInterstitial();
  await flush(); // InterstitialAd.show() was called, the call resolved, Showed arrived
  assert.equal(admob.adOnScreen('interstitial'), true);
  assert.equal(await peek(shown), 'pending');
  admob.dismiss('interstitial');
  assert.equal(await shown, true);
  await flush();
  assert.equal(admob.count('prepareInterstitial'), 2, 'the next ad is requested');
});

test('android rewarded: the plugin call never settles when the video is closed early; the game still gets false', async () => {
  const { ads, admob, clock } = await started();
  const shown = ads.showRewarded();
  await flush();
  admob.dismiss('rewarded');
  await clock.advance(T.rewardGraceMs);
  assert.equal(await shown, false);
});

test('android rewarded: reward, then dismissal, resolves true, and only at the dismissal', async () => {
  const { ads, admob } = await started();
  const shown = ads.showRewarded();
  await flush();
  admob.earnReward(); // the Rewarded event, then the show call resolves with the item
  assert.equal(await peek(shown), 'pending');
  admob.dismiss('rewarded');
  assert.equal(await shown, true);
});

for (const kind of ['interstitial', 'rewarded']) {
  test(`android ${kind}: an ad the plugin no longer holds is refused (with a FailedToLoad event) and resolves false`, async () => {
    const { ads, admob } = await started();
    admob.native[kind].prepared.clear(); // e.g. taken along by an ad that closed after its page was gone
    assert.equal(await show[kind](ads), false);
    await flush();
    assert.equal(admob.preparedCount(kind), 1, 'and another one is loaded');
    assert.equal(kind === 'rewarded' ? ads.rewardedReady() : ads.interstitialReady(), true);
  });

  test(`android ${kind}: a presentation the SDK refuses resolves false`, async () => {
    const { ads, admob } = await started({ admob: { showMode: 'fail' } });
    assert.equal(await show[kind](ads), false);
    assert.equal(admob.presentations(kind), 0);
  });

  test(`android ${kind}: a show that comes to nothing is given up on after the present timeout`, async () => {
    const { ads, clock } = await started({ admob: { showMode: 'silent' } });
    const shown = show[kind](ads);
    await clock.advance(T.presentTimeoutMs - T.heartbeatMs);
    assert.equal(await peek(shown), 'pending');
    await clock.advance(T.heartbeatMs);
    assert.equal(await shown, false);
  });

  // The ad is an activity on top of the game's activity. Home, then the launcher icon:
  // Android destroys it (the game's activity is singleTask) and nothing is reported.
  test(`android ${kind}: an ad that vanishes without a Dismissed event ends when the game has been back in front for the grace period`, async () => {
    const { ads, admob, app, clock } = await started();
    const shown = show[kind](ads);
    await flush();
    app.paused(); // the ad activity covers the game
    if (kind === 'rewarded') admob.earnReward({ event: true, result: false });
    app.stopped(); // Home
    admob.adActivityDestroyed(kind);
    app.resumed(); // back through the launcher icon

    await clock.advance(T.resumeGraceMs - 1);
    assert.equal(await peek(shown), 'pending', 'a Dismissed event on its way still gets its chance');
    await clock.advance(1);
    assert.equal(await shown, true, 'it was on screen (and for rewarded: the reward had been earned)');
    assert.equal(admob.count(kind === 'rewarded' ? 'prepareRewardVideoAd' : 'prepareInterstitial'), 2);
  });

  test(`android ${kind}: the Dismissed event arriving during that grace period settles it at once`, async () => {
    const { ads, admob, app, clock } = await started();
    const results = [];
    const shown = show[kind](ads).then((value) => results.push(value));
    await flush();
    app.paused();
    app.resumed(); // the ad activity is finishing; its callback comes a moment later
    await clock.advance(T.resumeGraceMs / 2);
    admob.earnReward();
    admob.dismiss(kind);
    await shown;
    await clock.advance(T.resumeGraceMs);
    assert.deepEqual(results, [true], 'one result, and nothing left ticking');
  });

  test(`android ${kind}: a resume without an earlier pause proves nothing`, async () => {
    const { ads, admob, app, clock } = await started();
    app.paused(); // some earlier interruption, over before the ad is asked for
    const shown = show[kind](ads);
    app.resumed(); // its resume event only reaches the page now
    await clock.advance(T.resumeGraceMs + T.heartbeatMs);
    assert.equal(await peek(shown), 'pending', 'the ad is up and has not been closed');
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await shown, true);
  });

  test(`android ${kind}: being covered again during the grace period calls it off`, async () => {
    const { ads, admob, app, clock } = await started();
    const shown = show[kind](ads);
    await flush();
    app.paused();
    app.resumed();
    await clock.advance(T.resumeGraceMs / 2);
    app.paused(); // something is on top of the game again
    await clock.advance(T.resumeGraceMs);
    assert.equal(await peek(shown), 'pending');
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await shown, true);
  });

  test(`android ${kind}: a Dismissed event that turns up after such an ending takes the next ad with it; another is loaded`, async () => {
    const { ads, admob, app, clock } = await started();
    const first = show[kind](ads);
    await flush();
    app.paused();
    app.resumed();
    await clock.advance(T.resumeGraceMs);
    await first;
    assert.equal(kind === 'rewarded' ? ads.rewardedReady() : ads.interstitialReady(), true, 'the next ad was loaded');

    admob.dismiss(kind); // late: the plugin deletes what is filed under the ad unit by now
    await flush();
    assert.equal(admob.preparedCount(kind), 1, 'the bridge noticed and loaded another');
    const second = show[kind](ads);
    await flush();
    assert.equal(admob.presentations(kind), 2, 'which the plugin really presents');
    admob.earnReward();
    admob.dismiss(kind);
    assert.equal(await second, true);
  });
}

test('android interstitial: gone without a Dismissed event and never reported as shown: not counted', async () => {
  const { ads, app, clock } = await started({ admob: { showMode: 'silent' } });
  const shown = ads.showInterstitial();
  await flush();
  app.paused();
  app.resumed();
  await clock.advance(T.resumeGraceMs);
  assert.equal(await shown, false, 'an interstitial counts only if its Showed event was seen');
});

test('android rewarded: gone without a Dismissed event and without a reward: false', async () => {
  const { ads, admob, app, clock } = await started();
  const shown = ads.showRewarded();
  await flush();
  app.paused();
  admob.adActivityDestroyed('rewarded');
  app.resumed();
  await clock.advance(T.resumeGraceMs);
  assert.equal(await shown, false);
});

test('android: activity events outside a showing do nothing', async () => {
  const { ads, admob, app, clock } = await started();
  app.paused();
  app.resumed();
  await clock.advance(T.resumeGraceMs);
  assert.equal(ads.interstitialReady(), true);
  assert.equal(admob.count('prepareInterstitial'), 1);
});

// --- banner --------------------------------------------------------------------------------------

async function withBanner(options) {
  const ctx = await started(options);
  await ctx.ads.showBanner();
  await flush();
  ctx.admob.bannerArrives();
  return ctx;
}

test('android banner: reports the ad height in dp plus the gap the plugin leaves under it', async () => {
  // What this test takes on trust: that the gap the plugin really leaves under the banner IS
  // the inset the page reads. The fake plugin has no layout; the inset comes from the fake
  // viewport alone. On a phone the two agree only in a window that is edge to edge, which
  // MainActivity asks for on Android 14 and earlier. The pieces that make it so are pinned to
  // the real sources in plugin-sources.test.js ("the banner is lifted by the bottom inset
  // that reaches it") and configure-android.test.js (the committed MainActivity), and the
  // sum itself is on the device checklist of SHIPPING-ANDROID.md (step 15, the Banner items).
  //
  // WebView 140+, edge to edge: the plugin lifts the banner above the navigation bar by the
  // bottom inset, the same inset the page reads.
  const edge = await withBanner();
  assert.equal(edge.admob.bannerOnScreen(), true);
  assert.deepEqual(edge.heights, [60 + INSET]);

  // Older WebView: Capacitor pads the web view clear of the bars; the banner sits on its bottom edge.
  const padded = await withBanner({ inset: 0 });
  assert.deepEqual(padded.heights, [60]);
});

test('android banner: nothing is reported while the ad is loading, although the view is already attached', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  await flush();
  assert.equal(admob.native.layout.attached, true);
  assert.equal(admob.bannerOnScreen(), false);
  assert.deepEqual(heights, []);
});

test('android banner: hide reports 0 at once; show again resumes the same banner and reports it when the plugin says so', async () => {
  const { ads, admob, heights } = await withBanner();
  await ads.hideBanner();
  assert.deepEqual(heights, [84, 0]);
  await flush();
  assert.equal(admob.bannerOnScreen(), false);
  assert.equal(admob.native.adView.paused, true, 'no refreshes while hidden');

  const view = admob.native.adView;
  ads.showBanner();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve(); // resumeBanner has answered; the UI thread has not acted yet
  assert.equal(admob.count('resumeBanner'), 1);
  assert.equal(admob.bannerOnScreen(), false);
  assert.deepEqual(heights, [84, 0], 'the bare answer is not taken as proof');

  await settle();
  assert.equal(admob.bannerOnScreen(), true);
  assert.equal(admob.native.adView, view, 'the loaded banner is reused');
  assert.equal(admob.count('showBanner'), 1);
  assert.deepEqual(heights, [84, 0, 84]);
});

test('android banner: resume answers although the view is gone; a new banner is requested after the confirmation wait', async () => {
  const { ads, admob, heights, clock } = await withBanner();
  await ads.hideBanner();
  await flush();
  admob.native.adView = null; // lost without a word
  admob.native.layout.attached = false;

  await ads.showBanner();
  await clock.advance(B.resumeConfirmMs - 1);
  assert.equal(admob.count('showBanner'), 1);
  assert.deepEqual(heights, [84, 0], 'no banner is claimed meanwhile');
  await clock.advance(1 + B.removeSettleMs);
  assert.equal(admob.count('showBanner'), 2);
  admob.bannerArrives();
  assert.deepEqual(heights, [84, 0, 84]);
});

test('android banner: a load failure reports 0 and is retried with a new view', async () => {
  const { ads, admob, heights, clock } = await withBanner();
  admob.bannerFails(); // a refresh failed: the plugin removed the view
  assert.deepEqual(heights, [84, 0]);
  assert.equal(admob.count('removeBanner'), 1, 'only the one from start-up: the plugin has removed the view itself');
  await clock.advance(B.retryBaseMs);
  assert.equal(admob.count('showBanner'), 2);
  await ads.showBanner();
  admob.bannerArrives();
  assert.deepEqual(heights, [84, 0, 84]);
});

test('android banner: a view that never loads is removed before the retry, so the retry is not swallowed', async () => {
  const { ads, admob, heights, clock } = await started();
  await ads.showBanner();
  await flush();
  const stuck = admob.native.adView;
  await clock.advance(B.loadTimeoutMs);
  assert.equal(admob.native.adView, null, 'the plugin was told to let go of it');
  await clock.advance(B.retryBaseMs);
  assert.equal(admob.count('showBanner'), 2);
  assert.notEqual(admob.native.adView, null);
  assert.notEqual(admob.native.adView, stuck, 'a new view, not a reload of the old one that never answers');
  admob.bannerArrives();
  assert.deepEqual(heights, [84]);
});

test('android banner: after a width change the old view is really gone before the new one is asked for', async () => {
  const { admob, heights, viewport, clock } = await withBanner();
  const old = admob.native.adView;
  viewport.change({ w: 700 });
  await clock.advance(B.relayoutDelayMs);
  await flush();
  assert.equal(admob.count('showBanner'), 2);
  assert.ok(admob.sequence().lastIndexOf('removeBanner') < admob.sequence().lastIndexOf('showBanner'));
  assert.notEqual(admob.native.adView, null);
  assert.notEqual(admob.native.adView, old, 'showBanner created a view; it did not just reload the one being removed');
  assert.equal(old.reloads, 0);
  assert.deepEqual(heights, [84, 0]);
  admob.bannerArrives(50);
  assert.deepEqual(heights, [84, 0, 74]);
});

test('android banner: hidden while still loading: hidden as soon as it arrives, never while the load can still fail', async () => {
  const { ads, admob, heights } = await started();
  await ads.showBanner();
  await ads.hideBanner();
  await flush();
  assert.equal(admob.count('hideBanner'), 0, 'hideBanner next to a failing load would crash the app: see helpers-android.test.js');
  admob.bannerArrives();
  await flush();
  assert.equal(admob.count('hideBanner'), 1);
  assert.equal(admob.bannerOnScreen(), false);
  assert.deepEqual(heights, []);

  await ads.showBanner();
  await flush();
  assert.equal(admob.bannerOnScreen(), true);
  assert.deepEqual(heights, [84]);
});

test('android banner: a burst of show / hide calls ends in the state asked for last, and nothing crashes', async () => {
  for (const [burst, onScreen] of [
    [['hide', 'show'], true],
    [['hide', 'show', 'hide'], false],
    [['hide', 'hide', 'show', 'show', 'hide', 'show'], true],
  ]) {
    const { ads, admob, heights } = await withBanner();
    for (const step of burst) step === 'show' ? ads.showBanner() : ads.hideBanner();
    for (let i = 0; i < burst.length + 2; i++) await flush();
    assert.equal(admob.bannerOnScreen(), onScreen, burst.join(' '));
    assert.equal(heights.at(-1), onScreen ? 84 : 0, burst.join(' '));
    assert.equal(admob.native.crashed, null);
  }
});

test('android banner: a banner the previous page left behind is taken down, also one that was still loading', async () => {
  for (const loaded of [true, false]) {
    const before = await started();
    await before.ads.showBanner();
    await flush();
    if (loaded) before.admob.bannerArrives();
    before.admob.reloadPage();

    const { ads, admob, heights } = await started({ plugin: before.admob });
    await ads.hideBanner(); // the new page opens on a screen without a banner
    await flush();
    assert.equal(admob.native.adView, null, `loaded: ${loaded}`);
    assert.equal(admob.native.layout.attached, false);
    assert.deepEqual(heights, []);
    assert.equal(admob.native.crashed, null);
  }
});

test('android banner: when the new page wants a banner at once, it gets a view of its own', async () => {
  const before = await withBanner();
  const old = before.admob.native.adView;
  before.admob.reloadPage();

  const { ads, admob, heights } = setup({ plugin: before.admob });
  await ads.showBanner(); // before init() is through
  await ads.init();
  await flush();
  await flush();
  assert.notEqual(admob.native.adView, null);
  assert.notEqual(admob.native.adView, old);
  assert.deepEqual(heights, []);
  admob.bannerArrives();
  assert.deepEqual(heights, [84]);
});

test('android banner: consent withdrawn in the privacy options takes the banner down', async () => {
  const { ads, admob, heights } = await withBanner({
    admob: { consent: { status: 'OBTAINED', isConsentFormAvailable: true, canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED' } },
  });
  admob.consent = { ...admob.consent, canRequestAds: false };
  await ads.showPrivacyOptions();
  await flush();
  assert.equal(admob.bannerOnScreen(), false);
  assert.equal(ads.interstitialReady(), false);
  assert.deepEqual(heights, [84, 0]);
  assert.equal(admob.native.crashed, null);
});
